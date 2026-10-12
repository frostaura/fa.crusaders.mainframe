using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The collaborators the players service needs beyond the context, the tenant and the settings,
/// bundled for the six-parameter complexity gate (the <c>ActivationPlumbing</c> pattern).
/// </summary>
public sealed record PlayersPlumbing(
    LedgerService Ledger, BookingRules Rules, RealtimeOutbox Outbox, IRealtimeBus Bus, ShareLedger Shares,
    ILogger<PlayersService> Logger);

/// <summary>
/// Who plays on a booking and who pays what (D11–D12): the organiser's invite, remove, nudge,
/// link and re-split, and each partner's accept, decline and withdraw.
///
/// <para>
/// <b>It never touches the booking row.</b> The booking is the organiser's, charged in full at
/// booking and settled by <see cref="BookingService"/> exactly as before; everything here is the
/// seats beside it, and money moves only through <see cref="ShareLedger"/>. That is what keeps the
/// settlement model's statements true of a split booking without one extra case.
/// </para>
///
/// <para>
/// <b>Every mutation ends with a reconcile, after its own commit.</b> The seat's state is the
/// decision; the reconcile is the consequence, idempotent, and the same code the settlement hook
/// and the worker run — so there is one place a share is ever computed.
/// </para>
/// </summary>
public sealed partial class PlayersService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly TenantSettingsAccessor _settings;
    private readonly PlayersPlumbing _p;

    public PlayersService(MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settings, PlayersPlumbing plumbing)
    {
        _db = db; _tenant = tenant; _settings = settings; _p = plumbing;
    }

    /// <summary>A booking, its seats (tracked), and the club's settings — what every decision here reads.</summary>
    internal sealed record Game(Booking Booking, List<BookingParticipant> Seats, TenantSettingsView Settings)
    {
        public IEnumerable<BookingParticipant> Live => Seats.Where(s => s.IsLive);

        public BookingParticipant? Organiser => Seats.FirstOrDefault(s => s.Seat == 1 && s.IsLive);
    }

    internal async Task<Game?> LoadAsync(Guid bookingId, CancellationToken ct)
    {
        var booking = await _db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        if (booking?.UserId is null || booking.Status == BookingStatus.AdminBlock) return null;
        var seats = await _db.BookingParticipants.Where(p => p.BookingId == bookingId).ToListAsync(ct);
        return new Game(booking, seats, await _settings.GetAsync(ct));
    }

    /// <summary>A game still taking players and payments: live or played, and before its share deadline.</summary>
    internal static bool IsOpen(Game g, DateTimeOffset now) =>
        g.Booking.Status is BookingStatus.Booked or BookingStatus.Completed
        && now < PlayerSettings.ShareDeadline(g.Booking, g.Settings);

    /// <summary>
    /// The organiser's own gate: their booking (anyone else's is a 404, never a 403 that confirms
    /// the id is real), not re-assigned to another payer at the box, and still open.
    /// </summary>
    private static PlayerOutcome? OrganiserGate(Game? g, Guid organiserId, DateTimeOffset now)
    {
        if (g is null || g.Booking.UserId != organiserId) return PlayerOutcome.BookingNotFound;
        if (g.Booking.PaidByUserId is { } payer && payer != organiserId) return PlayerOutcome.Refuse(409, PlayerErrors.PayerOverridden);
        return IsOpen(g, now) ? null : PlayerOutcome.Refuse(409, PlayerErrors.BookingNotOpen);
    }

    // ------------------------------------------------------------------ validation

    /// <summary>
    /// Checks a players request against the club before anything is booked or written: the kinds,
    /// the members, the seats, the mode, and the split against <paramref name="price"/>. Null when
    /// it is fine. A null <paramref name="price"/> is the shape check alone — for a request whose
    /// price is not known (a slot that cannot be quoted), which must still be refused if malformed
    /// rather than booked and left with a <c>players_error</c>.
    /// </summary>
    public async Task<PlayerOutcome?> ValidateAsync(
        Guid organiserId, PlayersRequest req, int? price, CancellationToken ct, IReadOnlyCollection<int>? takenSeats = null)
    {
        var specs = req.Players ?? [];
        if (specs.Count == 0) return null;
        if (specs.Count > BookingParticipant.MaxSeats - 1) return PlayerOutcome.Refuse(400, PlayerErrors.TooManyPlayers, new { max_players = BookingParticipant.MaxSeats - 1 });

        var members = new HashSet<Guid>();
        foreach (var spec in specs)
        {
            if (SpecError(spec) is { } bad) return PlayerOutcome.Refuse(400, bad);
            if (spec.UserId is not { } id) continue;
            if (id == organiserId || !members.Add(id)) return PlayerOutcome.Refuse(409, PlayerErrors.AlreadyInBooking, new { user_id = id });
            if (!await IsActiveMemberAsync(id, ct)) return PlayerOutcome.Refuse(404, PlayerErrors.MemberNotFound, new { user_id = id });
        }

        var seats = PlanSeats(specs, takenSeats ?? [1]);
        if (seats is null) return PlayerOutcome.Refuse(409, PlayerErrors.SeatTaken);

        var mode = SplitModes.Normalise(req.SplitMode ?? SplitModes.Equal);
        if (mode is null) return PlayerOutcome.Refuse(400, SplitCalculator.InvalidMode, new { allowed = SplitModes.All });
        if (price is not { } p) return null;
        var split = SplitCalculator.Split(p, mode, SplitInputs(specs, seats, req.OrganiserWeight));
        return split.Error is { } error ? PlayerOutcome.Refuse(400, error) : null;
    }

    /// <summary>The kind-and-shape check for one spec. Block body for the lizard reason.</summary>
    private static string? SpecError(PlayerSpec spec)
    {
        var kinds = (spec.UserId is not null ? 1 : 0) + (spec.GuestName is not null ? 1 : 0) + (spec.Link == true ? 1 : 0);
        if (kinds != 1) return PlayerErrors.InvalidPlayer;
        if (spec.Seat is { } seat && (seat < 2 || seat > BookingParticipant.MaxSeats)) return PlayerErrors.InvalidPlayer;
        if (spec.GuestName is { } name && GuestName(name) is null) return PlayerErrors.GuestNameInvalid;
        return null;
    }

    /// <summary>A guest's name, trimmed, or null when it is empty, too long or carries control characters.</summary>
    internal static string? GuestName(string raw)
    {
        var name = raw.Trim();
        if (name.Length == 0 || name.Length > BookingParticipant.GuestNameMaxLength) return null;
        return name.Any(char.IsControl) ? null : name;
    }

    private Task<bool> IsActiveMemberAsync(Guid userId, CancellationToken ct) =>
        _db.Users.AnyAsync(u => u.Id == userId && u.Status == "active"
            && _db.Memberships.Any(m => m.UserId == u.Id && m.Status == MembershipStatus.Active), ct);

    /// <summary>
    /// The seat each spec takes: its own when it names one, else the lowest free seat from 2 —
    /// so the first partner is the organiser's teammate. Null when two specs want one seat or
    /// there are more specs than free seats.
    /// </summary>
    internal static List<int>? PlanSeats(IReadOnlyList<PlayerSpec> specs, IReadOnlyCollection<int> taken)
    {
        var used = new HashSet<int>(taken);
        var plan = new int[specs.Count];
        for (var i = 0; i < specs.Count; i++)
        {
            if (specs[i].Seat is not { } wanted) continue;
            if (!used.Add(wanted)) return null;
            plan[i] = wanted;
        }
        for (var i = 0; i < specs.Count; i++)
        {
            if (plan[i] != 0) continue;
            var free = Enumerable.Range(2, BookingParticipant.MaxSeats - 1).FirstOrDefault(s => !used.Contains(s));
            if (free == 0) return null;
            used.Add(free);
            plan[i] = free;
        }
        return [.. plan];
    }

    private static List<SplitSeat> SplitInputs(IReadOnlyList<PlayerSpec> specs, List<int> seats, int? organiserWeight)
    {
        var inputs = new List<SplitSeat> { new(1, false, organiserWeight ?? 1) };
        for (var i = 0; i < specs.Count; i++)
        {
            inputs.Add(new SplitSeat(seats[i], specs[i].GuestName is not null, specs[i].Weight ?? 1, specs[i].Amount ?? 0m));
        }
        return inputs;
    }

    // ------------------------------------------------------------------ adding players

    /// <summary>
    /// Adds players to the organiser's booking — at creation (the BookSheet's Players step) or
    /// later (invite). The organiser's seat is written the first time; each new member seat and
    /// open link seat gets its own link token, returned here once and never again.
    /// </summary>
    /// <param name="club">
    /// The desk's add (null for the organiser's own): the admin, recorded as the inviter; it may
    /// invite again a member who declined or was taken off, and is not held to the club's
    /// per-booking invite cap — both on the admin change record. The member is told the CLUB added
    /// them (review round 1, B8), and with <see cref="ClubAdd.Accept"/> is placed as accepted (no
    /// consent recorded, so nothing is collected until they accept their share themselves).
    /// </param>
    ///
    /// <remarks>
    /// <b>Under the booking's own lock</b>, taken before anything is read: the invite cap counts
    /// every seat the booking was ever given, and two adds that both counted before either wrote
    /// would both squeeze under it. The lock ends at the commit; the reconcile runs after it.
    /// </remarks>
    public async Task<PlayerOutcome> AddAsync(
        Guid bookingId, Guid organiserId, PlayersRequest req, CancellationToken ct, ClubAdd? club = null)
    {
        var asAdmin = club is not null;
        await using var bookingLock = await PayerLock.BeginAsync(_db, _tenant.TenantId, bookingId, _p.Outbox, ct);
        var now = DateTimeOffset.UtcNow;
        var game = await LoadAsync(bookingId, ct);
        if (OrganiserGate(game, organiserId, now) is { } refused) return refused;

        var specs = req.Players ?? [];
        if (specs.Count == 0) return PlayerOutcome.Refuse(400, PlayerErrors.InvalidPlayer);
        foreach (var spec in specs.Where(s => s.UserId is not null))
        {
            if (game!.Live.Any(s => s.UserId == spec.UserId)) return PlayerOutcome.Refuse(409, PlayerErrors.AlreadyInBooking, new { user_id = spec.UserId });
        }
        if (FullRefusal(game!, specs) is { } full) return full;
        if (!asAdmin && InviteLoopRefusal(game!, specs) is { } loop) return loop;

        var taken = game!.Live.Select(s => s.Seat).Append(1).ToList();
        var mode = SplitModes.Normalise(req.SplitMode) ?? game.Organiser?.SplitMode ?? SplitModes.Equal;
        if (await ValidateAsync(organiserId, req with { SplitMode = mode }, game.Booking.AmountChargedMinutes, ct, taken) is { } bad)
        {
            return bad;
        }
        if (await DailyLimitRefusalAsync(game, specs, now, ct) is { } atLimit) return atLimit;

        return await AddSeatsAsync(new AddWork(game, req with { SplitMode = mode }, club?.ActorId ?? organiserId, now, bookingLock) { Club = club }, ct);
    }

    /// <summary>
    /// R19 J19-5: no room is said as no room. Four live seats (the organiser's counts, written or not)
    /// is <c>409 booking_full</c> — "This booking already has four players." — for the organiser and the
    /// desk, member, guest or link alike; fewer seats left than players asked for is
    /// <c>409 too_many_players</c> with <c>free_seats</c>. Both were <c>seat_taken</c> ("That seat was
    /// taken a moment ago. Pick another."), which sent the organiser looking for a seat that does not
    /// exist. A seat NAMED in the request that someone holds, with room elsewhere, is still
    /// <c>seat_taken</c> (<see cref="PlanSeats"/>).
    /// </summary>
    private static PlayerOutcome? FullRefusal(Game game, IReadOnlyList<PlayerSpec> specs)
    {
        var free = BookingParticipant.MaxSeats - game.Live.Select(s => s.Seat).Append(1).Distinct().Count();
        if (free <= 0) return PlayerOutcome.Refuse(409, PlayerErrors.BookingFull, new { max_players = BookingParticipant.MaxSeats });
        return specs.Count > free
            ? PlayerOutcome.Refuse(409, PlayerErrors.TooManyPlayers, new { max_players = BookingParticipant.MaxSeats - 1, free_seats = free })
            : null;
    }

    /// <summary>
    /// R16 J16-11: a member already holding their daily cap of court time on the game's club day is
    /// not added — by the organiser or the desk. Their accept would be refused for the same cap (D12),
    /// so the invite could never be taken, and an equal split would have gone down for nothing. The
    /// same rule and figures the accept meets (<see cref="BookingRules.PartnerCapRefusalAsync"/>); a
    /// game that has started is past asking, as the invite view's cap is.
    /// </summary>
    private async Task<PlayerOutcome?> DailyLimitRefusalAsync(Game game, IReadOnlyList<PlayerSpec> specs, DateTimeOffset now, CancellationToken ct)
    {
        if (game.Booking.StartsAt <= now) return null;
        foreach (var id in specs.Where(s => s.UserId is not null).Select(s => s.UserId!.Value))
        {
            if (await _p.Rules.PartnerCapRefusalAsync(id, game.Booking, game.Settings, ct) is null) continue;
            var name = PersonNames.Of(id, await PersonNames.ForAsync(_db, [id], ct));
            return PlayerOutcome.Refuse(409, PlayerErrors.AtDailyLimit, new { user_id = id, name });
        }
        return null;
    }

    /// <summary>The desk adding a player: who, and whether to place them as accepted (B8).</summary>
    public sealed record ClubAdd(Guid ActorId, bool Accept);

    /// <summary>
    /// The member's notice for being added: the organiser's invite (collapsed per the reminder
    /// cadence), or — when the club added them — the club's own notice, never collapsed, with the
    /// seat placed as accepted first when the desk asked for that (B8).
    /// </summary>
    private async Task StageAddedNoticeAsync(Game game, BookingParticipant seat, ClubAdd? club, CancellationToken ct)
    {
        // R15 E15-3: the club's add is on the record, in the add's own save — the member's and the
        // organiser's Nights said nothing of it.
        if (club is not null)
        {
            _db.AuditLogs.Add(SeatAudit(AddedByClubAction, game.Booking, seat, club.ActorId, new { accepted = club.Accept }));
        }
        if (club is null)
        {
            // R17 E17-8: the organiser's invite is on the record too — the invitee's and the organiser's Nights said nothing of it.
            _db.AuditLogs.Add(SeatAudit(InvitedAction, game.Booking, seat, game.Booking.UserId!.Value, new { share_minutes = seat.ShareMinutes }));
            var invite = await PlayerNotices.InviteAsync(_db, game.Booking, seat, game.Settings, ct);
            MemberNotices.Stage(_db, _tenant.TenantId,
                await PlayerNotices.CollapsedAsync(_db, invite, PlayerNotices.InvitedKeyPrefix, game.Settings, ct, game.Booking), game.Settings);
            return;
        }
        if (club.Accept)
        {
            seat.Status = ParticipantStatus.Accepted;
            seat.RespondedAt = StorableTime.UtcNow;
            MemberNotices.Stage(_db, _tenant.TenantId,
                await PlayerNotices.ClubSeatAsync(_db, game.Booking, seat, game.Settings, "club-added", ct), game.Settings);
            return;
        }

        // Still an invite, so the invite loop's rule holds: repeated inside the reminder cadence
        // it is inbox-only when a reminder will follow (the key keeps the invite prefix for that).
        var notice = await PlayerNotices.ClubSeatAsync(_db, game.Booking, seat, game.Settings, PlayerNotices.InvitedKeyPrefix + "club", ct);
        MemberNotices.Stage(_db, _tenant.TenantId,
            await PlayerNotices.CollapsedAsync(_db, notice, PlayerNotices.InvitedKeyPrefix, game.Settings, ct, game.Booking), game.Settings);
    }

    /// <summary>One add, decided: the game, the players (mode resolved), who, when, and the lock to commit.</summary>
    private sealed record AddWork(Game Game, PlayersRequest Req, Guid ActorId, DateTimeOffset Now, PayerLock Lock)
    {
        /// <summary>Set when the club is adding (B8).</summary>
        public ClubAdd? Club { get; init; }
    }

    /// <summary>
    /// The organiser's invite loop, closed (review finding 7): a member who said no to this game,
    /// or whom the organiser took off it, is not asked again — each invite is a mail they did not
    /// want — and no booking is given more than <c>player_invites_per_booking</c> member invites
    /// and link seats over its life, dead ones included, whatever the organiser does.
    /// </summary>
    private static PlayerOutcome? InviteLoopRefusal(Game game, IReadOnlyList<PlayerSpec> specs)
    {
        foreach (var id in specs.Where(s => s.UserId is not null).Select(s => s.UserId!.Value))
        {
            var past = game.Seats.Where(s => s.Seat > 1 && s.UserId == id).ToList();
            if (past.Any(s => s.Status == ParticipantStatus.Removed)) return PlayerOutcome.Refuse(409, PlayerErrors.PreviouslyRemoved, new { user_id = id });
            if (past.Any(s => s.Status == ParticipantStatus.Declined)) return PlayerOutcome.Refuse(409, PlayerErrors.PreviouslyDeclined, new { user_id = id });
        }

        var limit = PlayerSettings.InvitesPerBooking(game.Settings);
        var made = game.Seats.Count(s => s.Seat > 1 && s.GuestName is null);
        var adding = specs.Count(s => s.GuestName is null);
        return made + adding > limit
            ? PlayerOutcome.Refuse(409, PlayerErrors.InviteLimit, new { limit, invites_made = made })
            : null;
    }

    /// <param name="req">The players, with <see cref="PlayersRequest.SplitMode"/> already resolved.</param>
    private async Task<PlayerOutcome> AddSeatsAsync(AddWork work, CancellationToken ct)
    {
        var (game, req, actorId, now) = (work.Game, work.Req, work.ActorId, work.Now);
        var (specs, mode, organiserWeight) = (req.Players!, req.SplitMode!, req.OrganiserWeight);
        EnsureOrganiserSeat(game, now);
        StampDeadline(game);
        var plan = PlanSeats(specs, game.Live.Select(s => s.Seat).ToList())!;
        var added = new List<(BookingParticipant Seat, string? Token)>();
        for (var i = 0; i < specs.Count; i++) added.Add(NewSeat(game, specs[i], plan[i], actorId, now));

        var figures = added.ToDictionary(a => a.Seat.Id, a => (specs[added.IndexOf(a)].Weight ?? 1, specs[added.IndexOf(a)].Amount ?? 0m));
        if (organiserWeight is { } w) figures[game.Organiser!.Id] = (w, 0m);
        var before = game.Live.Where(s => s.Seat > 1 && s.UserId is not null && !figures.ContainsKey(s.Id)).ToDictionary(s => s.Id, s => s.ShareMinutes);
        if (Resplit(game, mode, figures) is { } splitError) return PlayerOutcome.Refuse(400, splitError);

        foreach (var (seat, _) in added.Where(a => a.Seat.UserId is not null))
        {
            await StageAddedNoticeAsync(game, seat, work.Club, ct);
        }
        await RecordRebalanceAsync(game, before, added.Select(a => a.Seat).ToList(), work, ct);

        if (await SaveAsync(ct) is { } conflict) return conflict;
        await work.Lock.CommitAsync(ct);
        // R16 J16-2: a share the add lowered goes back as the ADDER's act — the organiser's (their
        // receipt born read) or the desk's — never the club's system with no cause.
        var options = new ReconcileOptions(actorId) { OwnActionBy = work.Club is null ? actorId : null };
        await AfterAsync(game.Booking.Id, added.Where(a => a.Seat.UserId is not null).Select(a => a.Seat.UserId!.Value), ct, options);
        return PlayerOutcome.Ok(new
        {
            booking_id = game.Booking.Id,
            participants = added.Select(a => new
            {
                participant_id = a.Seat.Id,
                seat = a.Seat.Seat,
                user_id = a.Seat.UserId,
                guest_name = a.Seat.GuestName,
                status = PlayerViews.StatusName(a.Seat.Status),
                share_minutes = a.Seat.ShareMinutes,
                invite_token = a.Token,
                invite_path = a.Token is null ? null : InviteTokens.PathFor(a.Token),
            }).ToList(),
        });
    }

    /// <summary>
    /// R16 J16-2: every partner whose share an add lowered, on the record in the add's own save — a
    /// <c>players.split_changed</c> row whose <c>because</c> is <see cref="ShareActs.PlayerAdded"/> and
    /// whose <c>joined</c> names who joined. The share that goes back reads its cause, actor and words
    /// off it (<see cref="SeatFacts"/>, <see cref="ShareRowCauses"/>): "Jo joined, so the split went down".
    /// </summary>
    private async Task RecordRebalanceAsync(
        Game game, Dictionary<Guid, int> before, List<BookingParticipant> added, AddWork work, CancellationToken ct)
    {
        var moved = game.Live.Where(s => before.TryGetValue(s.Id, out var was) && was != s.ShareMinutes).ToList();
        if (moved.Count == 0) return;
        var names = await PersonNames.ForAsync(_db, added.Select(a => a.UserId), ct);
        var joined = string.Join(" and ", added.Select(a => a.GuestName ?? PersonNames.Of(a.UserId, names) ?? "A player"));
        foreach (var seat in moved)
        {
            _db.AuditLogs.Add(SeatAudit(SplitChangedAction, game.Booking, seat, work.ActorId, new
            {
                share_minutes = seat.ShareMinutes,
                previous_share_minutes = before[seat.Id],
                because = Email.ShareActs.PlayerAdded,
                joined,
                by_club = work.Club is not null,
            }));
        }
    }

    /// <summary>
    /// Freezes the booking's share deadline the first time it gets players (review H2): the SOLD
    /// end plus <c>share_lapse_hours</c> as the club has it NOW. A later change to the setting
    /// moves no deadline already stamped — raising it would otherwise reopen a game whose held
    /// shares were released and spent. Saved with the seats, under the booking's version token.
    /// </summary>
    private void StampDeadline(Game game)
    {
        if (game.Booking.ShareDeadlineAt is not null) return;
        var deadline = PlayerSettings.DeadlineFromSettings(game.Booking, game.Settings).Storable();
        // The request that just created the booking already tracks it; stamp that instance.
        var tracked = _db.ChangeTracker.Entries<Booking>().FirstOrDefault(e => e.Entity.Id == game.Booking.Id)?.Entity;
        if (tracked is null) _db.Bookings.Attach(game.Booking);
        (tracked ?? game.Booking).ShareDeadlineAt = deadline;
        game.Booking.ShareDeadlineAt = deadline;
    }

    /// <summary>Seat 1, written the first time a booking gets a second player. Nothing is backfilled before that.</summary>
    private void EnsureOrganiserSeat(Game game, DateTimeOffset now)
    {
        if (game.Organiser is not null) return;
        var seat = new BookingParticipant
        {
            TenantId = _tenant.TenantId,
            BookingId = game.Booking.Id,
            Seat = 1,
            UserId = game.Booking.UserId,
            Status = ParticipantStatus.Accepted,
            ShareMinutes = game.Booking.AmountChargedMinutes,
            ShareWeight = 1,
            SplitMode = SplitModes.Equal,
            InvitedByUserId = game.Booking.UserId,
            InvitedAt = now.Storable(),
            RespondedAt = now.Storable(),
            CreatedAt = now.Storable(),
            UpdatedAt = now.Storable(),
        };
        _db.BookingParticipants.Add(seat);
        game.Seats.Add(seat);
    }

    private (BookingParticipant, string?) NewSeat(Game game, PlayerSpec spec, int seatNumber, Guid actorId, DateTimeOffset now)
    {
        var guest = spec.GuestName is { } raw ? GuestName(raw) : null;
        var (token, hash) = guest is null ? InviteTokens.Mint() : (null!, null!);
        var seat = new BookingParticipant
        {
            TenantId = _tenant.TenantId,
            BookingId = game.Booking.Id,
            Seat = seatNumber,
            UserId = spec.UserId,
            GuestName = guest,
            // A guest needs nobody's yes: the organiser is bringing them and covering them.
            Status = guest is null ? ParticipantStatus.Invited : ParticipantStatus.Accepted,
            InviteTokenHash = hash,
            InvitedByUserId = actorId,
            InvitedAt = now.Storable(),
            RespondedAt = guest is null ? null : now.Storable(),
            CreatedAt = now.Storable(),
            UpdatedAt = now.Storable(),
        };
        _db.BookingParticipants.Add(seat);
        game.Seats.Add(seat);
        return (seat, token);
    }

    /// <summary>
    /// Re-divides the price across the live seats. <paramref name="figures"/> carries the weight and
    /// amount of any seat whose figure is new; every other seat keeps its own (its weight under a
    /// ratio, its share under an amount). A share that goes DOWN takes the consent down with it, so
    /// raising it again later is a new question to the partner rather than a debit they agreed to
    /// once, about a different figure.
    /// </summary>
    internal static string? Resplit(Game game, string mode, IReadOnlyDictionary<Guid, (int Weight, decimal Amount)> figures)
    {
        var live = game.Live.OrderBy(s => s.Seat).ToList();
        var inputs = live.Select(s => figures.TryGetValue(s.Id, out var f)
            ? new SplitSeat(s.Seat, s.GuestName is not null, f.Weight, f.Amount)
            : new SplitSeat(s.Seat, s.GuestName is not null, Math.Max(s.ShareWeight, mode == SplitModes.Ratio ? 0 : 1), s.ShareMinutes))
            .ToList();

        var split = SplitCalculator.Split(game.Booking.AmountChargedMinutes, mode, inputs);
        if (split.Error is { } error) return error;

        foreach (var share in split.Shares!)
        {
            var seat = live.First(s => s.Seat == share.Seat);
            seat.ShareMinutes = share.ShareMinutes;
            seat.ShareWeight = share.Weight;
            if (seat.ConsentedMinutes > seat.ShareMinutes) seat.ConsentedMinutes = seat.ShareMinutes;
        }
        game.Organiser!.SplitMode = mode;
        return null;
    }

    // ------------------------------------------------------------------ the organiser's other actions

    /// <summary>
    /// A partner seat died (removed, declined, withdrawn): the organiser absorbs its share — no
    /// auto re-split (D11) — and their own seat now SAYS so (review round 4, M4-6). It kept its old
    /// figure, so the open-seat prompt read "You cover 30.00" beside a Money panel saying 50.
    /// The organiser's share is only ever the remainder: the price less every live partner's.
    ///
    /// <para>
    /// <b>One statement, after the seat's own commit, and no version bump.</b> Written through the
    /// tracked organiser seat, two partners declining at once would both bump its version and one be
    /// answered 409. Computed in SQL from committed rows instead, so whichever runs last sees both.
    /// </para>
    /// </summary>
    internal async Task AbsorbFreedShareAsync(Booking booking, CancellationToken ct)
    {
        var price = booking.AmountChargedMinutes;
        var bookingId = booking.Id;
        await _db.BookingParticipants
            .Where(o => o.BookingId == bookingId && o.Seat == 1
                        && (o.Status == ParticipantStatus.Invited || o.Status == ParticipantStatus.Accepted))
            .ExecuteUpdateAsync(u => u.SetProperty(o => o.ShareMinutes, o => Math.Max(0, price - (_db.BookingParticipants
                .Where(p => p.BookingId == bookingId && p.Seat > 1
                            && (p.Status == ParticipantStatus.Invited || p.Status == ParticipantStatus.Accepted))
                .Sum(p => (int?)p.ShareMinutes) ?? 0))), ct);
    }

    /// <summary>Takes a player off the booking. Anything they paid comes back at the reconcile.</summary>
    public async Task<PlayerOutcome> RemoveAsync(Guid bookingId, Guid seatId, Guid organiserId, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var game = await LoadAsync(bookingId, ct);
        if (OrganiserGate(game, organiserId, now) is { } refused) return refused;
        // I4-5: the organiser's own removal — their "went back" receipt is born read. R14 E14-2: and
        // the share going back is theirs on the ledger too, not the club's system.
        return await RemoveSeatAsync(game!, seatId, now, ct, new ReconcileOptions(organiserId) { OwnActionBy = organiserId });
    }

    /// <param name="options">The admin's authority for the return, when an admin removes (review H1); null for the organiser.</param>
    internal async Task<PlayerOutcome> RemoveSeatAsync(Game game, Guid seatId, DateTimeOffset now, CancellationToken ct, ReconcileOptions? options = null)
    {
        var seat = game.Seats.FirstOrDefault(s => s.Id == seatId && s.Seat > 1 && s.IsLive);
        // R18 J18-4: a second tap on a seat already taken off is the first one's answer.
        if (seat is null && game.Seats.FirstOrDefault(s => s.Id == seatId && s.Seat > 1) is { Status: ParticipantStatus.Removed } gone)
        {
            return AlreadyThere(gone);
        }
        if (seat is null) return PlayerOutcome.PlayerNotFound;

        seat.Status = ParticipantStatus.Removed;
        seat.UpdatedAt = now.Storable();
        if (seat.UserId is not null)
        {
            var removal = await PlayerNotices.ChangedAsync(
                _db, game.Booking, seat, game.Settings, $"{PlayerNotices.RemovedKeyPrefix}{seat.Id:N}", ct);
            // Review round 2, B-8: the club took them off, not the organiser — the mail says so.
            if (options?.ClubRemoval is not null && removal.Payload is GameChangedPayload told)
            {
                removal = removal with { Payload = told with { ByClub = true }, Headline = $"The club took you off {told.CourtName}, {told.StartsAtLocal}" };
            }
            MemberNotices.Stage(_db, _tenant.TenantId,
                await PlayerNotices.CollapsedAsync(_db, removal, PlayerNotices.RemovedKeyPrefix, game.Settings, ct), game.Settings);
            _db.AuditLogs.Add(SeatAudit(SeatFacts.RemovedAction, game.Booking, seat, RemoverOf(game, options), new { by_club = options?.ClubRemoval is not null }));
        }

        if (await SaveAsync(ct, new Landing(seat.Id, ParticipantStatus.Removed)) is { } conflict) return conflict;
        await AbsorbFreedShareAsync(game.Booking, ct);
        await AfterAsync(game.Booking.Id, seat.UserId is { } u ? [u] : [], ct, options);
        return PlayerOutcome.Ok(new { participant_id = seat.Id, status = PlayerViews.StatusName(seat.Status) });
    }

    /// <summary>
    /// A reminder from the organiser to a player who has not answered or not paid, at most
    /// <c>player_nudge_limit</c> times in any 24 hours.
    /// </summary>
    public async Task<PlayerOutcome> NudgeAsync(Guid bookingId, Guid seatId, Guid organiserId, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var game = await LoadAsync(bookingId, ct);
        if (OrganiserGate(game, organiserId, now) is { } refused) return refused;

        var seat = game!.Seats.FirstOrDefault(s => s.Id == seatId && s.Seat > 1 && s.IsLive && s.UserId is not null);
        if (seat is null) return PlayerOutcome.PlayerNotFound;
        if (seat.Status == ParticipantStatus.Accepted && await _p.Shares.UnpaidAsync(game.Booking, seat, ct) <= 0)
        {
            return PlayerOutcome.Refuse(409, PlayerErrors.NothingToNudge);
        }

        var limit = PlayerSettings.NudgeLimit(game.Settings);
        var windowOpen = seat.LastNudgedAt is { } last && last > now.AddHours(-24);
        var count = windowOpen ? seat.NudgeCount : 0;
        if (count >= limit)
        {
            return PlayerOutcome.Refuse(429, PlayerErrors.NudgeLimit, new { limit, retry_after = seat.LastNudgedAt?.AddHours(24) });
        }

        seat.NudgeCount = count + 1;
        seat.LastNudgedAt = now.Storable();
        seat.UpdatedAt = now.Storable();
        MemberNotices.Stage(_db, _tenant.TenantId, await PlayerNotices.ReminderAsync(
            _db, game.Booking, seat, game.Settings, new ReminderKey(true, $"nudge:{seat.Id:N}:{now.UtcTicks}"), ct), game.Settings);

        if (await SaveAsync(ct) is { } conflict) return conflict;
        await AfterAsync(game.Booking.Id, [seat.UserId!.Value], ct);
        return PlayerOutcome.Ok(new { participant_id = seat.Id, nudges_left = Math.Max(0, limit - seat.NudgeCount) });
    }

    /// <summary>
    /// A fresh link for a seat nobody has taken yet — or for an invited member — replacing the old
    /// one. The token is not stored, so "copy the link again" is this: the old link stops working.
    /// </summary>
    public async Task<PlayerOutcome> RotateLinkAsync(Guid bookingId, Guid seatId, Guid organiserId, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var game = await LoadAsync(bookingId, ct);
        if (OrganiserGate(game, organiserId, now) is { } refused) return refused;

        var seat = game!.Seats.FirstOrDefault(s => s.Id == seatId && s.Seat > 1 && s.Status == ParticipantStatus.Invited);
        if (seat is null) return PlayerOutcome.PlayerNotFound;

        var (token, hash) = InviteTokens.Mint();
        seat.InviteTokenHash = hash;
        seat.UpdatedAt = now.Storable();
        if (await SaveAsync(ct) is { } conflict) return conflict;
        return PlayerOutcome.Ok(new { participant_id = seat.Id, invite_token = token, invite_path = InviteTokens.PathFor(token) });
    }

    /// <summary>
    /// Re-splits the booking: equal, by ratio, or by amount. Every partner whose share moved is
    /// told; one whose share went UP past what they agreed to is asked again, and nothing more is
    /// taken from them until they answer. A share that went down comes back at the reconcile.
    /// </summary>
    public async Task<PlayerOutcome> ChangeSplitAsync(Guid bookingId, Guid organiserId, SplitRequest req, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var game = await LoadAsync(bookingId, ct);
        if (OrganiserGate(game, organiserId, now) is { } refused) return refused;
        if (game!.Organiser is null || !game.Live.Any(s => s.Seat > 1)) return PlayerOutcome.Refuse(409, PlayerErrors.SplitNeedsSeats);

        var mode = SplitModes.Normalise(req.Mode);
        if (mode is null) return PlayerOutcome.Refuse(400, SplitCalculator.InvalidMode, new { allowed = SplitModes.All });

        if (SplitFigures(game, req) is not { } figures)
        {
            var unknown = (req.Seats ?? []).First(s => !game.Live.Any(l => l.Id == s.ParticipantId)).ParticipantId;
            return PlayerOutcome.Refuse(400, PlayerErrors.SplitNeedsSeats, new { participant_id = unknown });
        }

        var before = game.Live.ToDictionary(s => s.Id, s => s.ShareMinutes);
        if (Resplit(game, mode, figures) is { } error) return PlayerOutcome.Refuse(400, error);

        // Pay what you can: the organiser has decided how what partners could not pay is split, so
        // nothing is left to cover — whatever this split is, even one that leaves every share where it was.
        foreach (var covered in game.Seats.Where(s => s.ShortfallMinutes > 0)) covered.ShortfallMinutes = 0;

        var changed = game.Live.Where(s => s.Seat > 1 && s.UserId is not null && before[s.Id] != s.ShareMinutes).ToList();
        foreach (var seat in changed)
        {
            seat.UpdatedAt = now.Storable();
            // R14 E14-2: the partner's Night says the organiser changed it, and to what.
            _db.AuditLogs.Add(SeatAudit(SplitChangedAction, game.Booking, seat, organiserId,
                new { share_minutes = seat.ShareMinutes, previous_share_minutes = before[seat.Id] }));
            MemberNotices.Stage(_db, _tenant.TenantId, await PlayerNotices.ChangedAsync(
                _db, game.Booking, seat, game.Settings, $"split:{seat.Id:N}:{now.UtcTicks}", ct), game.Settings);
        }

        if (await SaveAsync(ct) is { } conflict)
        {
            return conflict.Error == PlayerErrors.Conflict ? await SplitTwinAsync(bookingId, organiserId, req, ct) ?? conflict : conflict;
        }
        // I4-5: the organiser's own split change — their receipts are born read. R14 E14-2: their act on the ledger too.
        await AfterAsync(game.Booking.Id, changed.Select(s => s.UserId!.Value), ct, new ReconcileOptions(organiserId) { OwnActionBy = organiserId });
        return PlayerOutcome.Ok(SplitAnswer(game, mode));
    }

    /// <summary>The figures a split request names, by seat; null when it names a seat that is not live.</summary>
    private static Dictionary<Guid, (int, decimal)>? SplitFigures(Game game, SplitRequest req)
    {
        var figures = new Dictionary<Guid, (int, decimal)>();
        foreach (var s in req.Seats ?? [])
        {
            if (!game.Live.Any(l => l.Id == s.ParticipantId)) return null;
            figures[s.ParticipantId] = (s.Weight ?? 1, s.Amount ?? 0m);
        }
        return figures;
    }

    /// <summary>
    /// R19 J19-6: a re-split that lost its save to another write on the booking's seats. When the seats
    /// already stand exactly where THIS request would put them — every live share, weight and the mode —
    /// the winner was its twin (a double tap, a retried request): the same 200 and the same shares, and
    /// nothing written, as R18's seat twins. Anything else (a different split, an accept, a removal) is
    /// null, and the caller keeps <c>conflict_retry</c>.
    /// </summary>
    private async Task<PlayerOutcome?> SplitTwinAsync(Guid bookingId, Guid organiserId, SplitRequest req, CancellationToken ct)
    {
        try
        {
            var mode = SplitModes.Normalise(req.Mode)!;
            var game = await LoadAsync(bookingId, ct);
            if (OrganiserGate(game, organiserId, DateTimeOffset.UtcNow) is not null || game!.Organiser is null) return null;
            if (SplitFigures(game, req) is not { } figures) return null;
            var stood = game.Live.ToDictionary(s => s.Id, s => (s.ShareMinutes, s.ShareWeight, s.ConsentedMinutes));
            var modeStood = game.Organiser.SplitMode == mode;
            if (Resplit(game, mode, figures) is not null || !modeStood) return null;
            var unmoved = game.Live.All(s => stood[s.Id] == (s.ShareMinutes, s.ShareWeight, s.ConsentedMinutes));
            return unmoved ? PlayerOutcome.Ok(SplitAnswer(game, mode)) : null;
        }
        finally
        {
            // A look, never a write: whatever Resplit set on the tracked seats goes nowhere.
            _db.ChangeTracker.Clear();
        }
    }

    /// <summary>A re-split's answer: the mode and every live seat's share, weight and whether it asks for consent.</summary>
    private static object SplitAnswer(Game game, string mode)
    {
        return new
        {
            booking_id = game.Booking.Id,
            split_mode = mode,
            shares = game.Live.OrderBy(s => s.Seat).Select(s => new
            {
                participant_id = s.Id,
                seat = s.Seat,
                share_minutes = s.ShareMinutes,
                weight = s.ShareWeight,
                // R16 J16-1: the one rule — a share the club settled by hand asks nothing.
                needs_consent = s.Seat > 1 && PlayerNotices.NeedsConsent(game.Booking, s),
            }).ToList(),
        };
    }

    // ------------------------------------------------------------------ plumbing

    /// <summary>The audit action a split change writes, once per partner whose share moved (R14 E14-2).</summary>
    public const string SplitChangedAction = "players.split_changed";

    /// <summary>Who took a seat off: the admin acting for the club, else the organiser (R14 E14-2).</summary>
    private static Guid RemoverOf(Game game, ReconcileOptions? options)
    {
        return options is { ActorUserId: var actor } && actor != Guid.Empty ? actor : game.Booking.UserId ?? Guid.Empty;
    }

    /// <summary>
    /// R14 E14-2: a seat change on the club's record, in the change's own save — the partner is the
    /// subject, the person who made it the actor, and the organiser named in the details so the
    /// Night can say whose game it was. <paramref name="more"/> is merged into the details.
    /// </summary>
    private AuditLog SeatAudit(string action, Booking booking, BookingParticipant seat, Guid actor, object more) =>
        SeatAuditFor(_tenant.TenantId, action, booking, seat, actor, more);

    /// <summary>
    /// <see cref="SeatAudit"/> for a caller outside this service — the desk's settle-outside and
    /// collect (R15 E15-3) write the same shape, so the Night reads every seat act one way.
    /// </summary>
    internal static AuditLog SeatAuditFor(Guid tenantId, string action, Booking booking, BookingParticipant seat, Guid actor, object more)
    {
        var details = System.Text.Json.JsonSerializer.SerializeToNode(new
        {
            booking_id = booking.Id,
            participant_id = seat.Id,
            organiser_user_id = booking.UserId,
            starts_at = booking.StartsAt,
        })!.AsObject();
        foreach (var (key, value) in System.Text.Json.JsonSerializer.SerializeToNode(more)!.AsObject().ToList())
        {
            details[key] = value?.DeepClone();
        }
        return new AuditLog
        {
            TenantId = tenantId,
            ActorUserId = actor,
            SubjectUserId = seat.UserId,
            Action = action,
            DetailsJson = details.ToJsonString(),
        };
    }

    /// <summary>R15 E15-3: the desk added a member to a game (placed as playing, or invited) — the Night's record of it.</summary>
    public const string AddedByClubAction = "players.added_by_club";

    /// <summary>R16 E16-1: the desk accepted a partner's invite on their behalf.</summary>
    public const string AcceptedByClubAction = "players.accepted_by_club";

    /// <summary>R17 E17-8: the organiser invited a member (actor the organiser, subject the invitee).</summary>
    public const string InvitedAction = TraceKinds.InvitedAction;

    /// <summary>R17 E17-8: a member accepted their invite themselves (actor and subject the member).</summary>
    public const string AcceptedAction = TraceKinds.AcceptedAction;

    /// <summary>R17 E17-8: a member declined their invite (actor and subject the member).</summary>
    public const string DeclinedAction = TraceKinds.DeclinedAction;

    /// <summary>R15 E15-3: the desk recorded a partner's share as paid by hand.</summary>
    public const string SettledOutsideAction = "players.settled_outside";

    /// <summary>R15 E15-3: the desk collected a partner's share by hand.</summary>
    public const string ShareCollectedAction = "players.share_collected";

    /// <summary>
    /// Saves. Null when it saved; otherwise the answer to give. Nothing is half-written — the whole
    /// decision was one save.
    ///
    /// <para>
    /// R18 J18-4: <c>seat_taken</c> only when a seat or member really was taken (the partial unique
    /// indexes on the seats). Any other loss — the seat's version moved, or this act's twin wrote the
    /// same notice first (its dedupe key) — re-reads the seat: already where <paramref name="landing"/>
    /// says this act was taking it is the twin's work and this caller's answer too, 200; anywhere else
    /// is <c>conflict_retry</c>, and asked again it is refused for what actually happened.
    /// </para>
    /// </summary>
    private async Task<PlayerOutcome?> SaveAsync(CancellationToken ct, Landing? landing = null)
    {
        try
        {
            await _db.SaveChangesAsync(ct);
            return null;
        }
        catch (DbUpdateException ex) when (SeatRaces.IsSeatTaken(ex))
        {
            _db.ChangeTracker.Clear();
            return PlayerOutcome.Refuse(409, PlayerErrors.SeatTaken);
        }
        catch (DbUpdateException ex) when (SeatRaces.IsLostRace(ex))
        {
            _db.ChangeTracker.Clear();
            return await LandedAsync(landing, ct);
        }
    }

    /// <summary>Where a seat act was taking its seat: the seat, and the status it ends in (R18 J18-4).</summary>
    private sealed record Landing(Guid SeatId, ParticipantStatus Status);

    /// <summary>
    /// After a lost race: the seat as the winner left it. In this act's target state → the same 200 the
    /// winner gave (<c>{participant_id, status}</c>); otherwise <c>conflict_retry</c>.
    /// </summary>
    private async Task<PlayerOutcome> LandedAsync(Landing? landing, CancellationToken ct)
    {
        if (landing is null) return PlayerOutcome.Refuse(409, PlayerErrors.Conflict);
        var seat = await _db.BookingParticipants.AsNoTracking().FirstOrDefaultAsync(p => p.Id == landing.SeatId, ct);
        return seat?.Status == landing.Status
            ? AlreadyThere(seat)
            : PlayerOutcome.Refuse(409, PlayerErrors.Conflict);
    }

    /// <summary>The answer to a seat act whose seat is already where the act would take it.</summary>
    internal static PlayerOutcome AlreadyThere(BookingParticipant seat)
    {
        return PlayerOutcome.Ok(new { participant_id = seat.Id, status = PlayerViews.StatusName(seat.Status) });
    }

    /// <summary>The consequence of any committed seat change: the shares follow, and the badge moves.</summary>
    private async Task AfterAsync(Guid bookingId, IEnumerable<Guid> notified, CancellationToken ct, ReconcileOptions? options = null)
    {
        IReadOnlyList<ShareMove> moves = [];
        try
        {
            moves = await _p.Shares.ReconcileAsync(bookingId, ct, options);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // The seat change stands; the worker's next pass moves the money. Logged, not thrown:
            // the member's answer was recorded and must not read as a failure.
            _p.Logger.LogError(ex, "Reconcile after a seat change on booking {Booking} failed", bookingId);
        }

        var touched = notified.Concat(moves.SelectMany(m => new[] { m.PartnerUserId, m.OrganiserUserId }));
        await MemberNotices.PublishUnreadAsync(_db, _p.Bus, _tenant.TenantId, touched, ct);
    }
}
