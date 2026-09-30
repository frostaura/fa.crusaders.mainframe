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
        Guid organiserId, PlayersRequest req, decimal? price, CancellationToken ct, IReadOnlyCollection<int>? takenSeats = null)
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
        if (!asAdmin && InviteLoopRefusal(game!, specs) is { } loop) return loop;

        var taken = game!.Live.Select(s => s.Seat).Append(1).ToList();
        var mode = SplitModes.Normalise(req.SplitMode) ?? game.Organiser?.SplitMode ?? SplitModes.Equal;
        if (await ValidateAsync(organiserId, req with { SplitMode = mode }, game.Booking.AmountChargedCredits, ct, taken) is { } bad)
        {
            return bad;
        }

        return await AddSeatsAsync(new AddWork(game, req with { SplitMode = mode }, club?.ActorId ?? organiserId, now, bookingLock) { Club = club }, ct);
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
        if (club is null)
        {
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
        if (Resplit(game, mode, figures) is { } splitError) return PlayerOutcome.Refuse(400, splitError);

        foreach (var (seat, _) in added.Where(a => a.Seat.UserId is not null))
        {
            await StageAddedNoticeAsync(game, seat, work.Club, ct);
        }

        if (await SaveAsync(ct) is { } conflict) return conflict;
        await work.Lock.CommitAsync(ct);
        await AfterAsync(game.Booking.Id, added.Where(a => a.Seat.UserId is not null).Select(a => a.Seat.UserId!.Value), ct);
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
                share_credits = a.Seat.ShareCredits,
                invite_token = a.Token,
                invite_path = a.Token is null ? null : InviteTokens.PathFor(a.Token),
            }).ToList(),
        });
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
            ShareCredits = game.Booking.AmountChargedCredits,
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
            : new SplitSeat(s.Seat, s.GuestName is not null, Math.Max(s.ShareWeight, mode == SplitModes.Ratio ? 0 : 1), s.ShareCredits))
            .ToList();

        var split = SplitCalculator.Split(game.Booking.AmountChargedCredits, mode, inputs);
        if (split.Error is { } error) return error;

        foreach (var share in split.Shares!)
        {
            var seat = live.First(s => s.Seat == share.Seat);
            seat.ShareCredits = share.ShareCredits;
            seat.ShareWeight = share.Weight;
            if (seat.ConsentedCredits > seat.ShareCredits) seat.ConsentedCredits = seat.ShareCredits;
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
        var price = booking.AmountChargedCredits;
        var bookingId = booking.Id;
        await _db.BookingParticipants
            .Where(o => o.BookingId == bookingId && o.Seat == 1
                        && (o.Status == ParticipantStatus.Invited || o.Status == ParticipantStatus.Accepted))
            .ExecuteUpdateAsync(u => u.SetProperty(o => o.ShareCredits, o => Math.Max(0m, price - (_db.BookingParticipants
                .Where(p => p.BookingId == bookingId && p.Seat > 1
                            && (p.Status == ParticipantStatus.Invited || p.Status == ParticipantStatus.Accepted))
                .Sum(p => (decimal?)p.ShareCredits) ?? 0m))), ct);
    }

    /// <summary>Takes a player off the booking. Anything they paid comes back at the reconcile.</summary>
    public async Task<PlayerOutcome> RemoveAsync(Guid bookingId, Guid seatId, Guid organiserId, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var game = await LoadAsync(bookingId, ct);
        if (OrganiserGate(game, organiserId, now) is { } refused) return refused;
        // I4-5: the organiser's own removal — their "went back" receipt is born read.
        return await RemoveSeatAsync(game!, seatId, now, ct, new ReconcileOptions(Guid.Empty) { OwnActionBy = organiserId });
    }

    /// <param name="options">The admin's authority for the return, when an admin removes (review H1); null for the organiser.</param>
    internal async Task<PlayerOutcome> RemoveSeatAsync(Game game, Guid seatId, DateTimeOffset now, CancellationToken ct, ReconcileOptions? options = null)
    {
        var seat = game.Seats.FirstOrDefault(s => s.Id == seatId && s.Seat > 1 && s.IsLive);
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
        }

        if (await SaveAsync(ct) is { } conflict) return conflict;
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
        if (seat.Status == ParticipantStatus.Accepted && await _p.Shares.UnpaidAsync(game.Booking, seat, ct) <= 0m)
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

        var figures = new Dictionary<Guid, (int, decimal)>();
        foreach (var s in req.Seats ?? [])
        {
            if (!game.Live.Any(l => l.Id == s.ParticipantId)) return PlayerOutcome.Refuse(400, PlayerErrors.SplitNeedsSeats, new { participant_id = s.ParticipantId });
            figures[s.ParticipantId] = (s.Weight ?? 1, s.Amount ?? 0m);
        }

        var before = game.Live.ToDictionary(s => s.Id, s => s.ShareCredits);
        if (Resplit(game, mode, figures) is { } error) return PlayerOutcome.Refuse(400, error);

        var changed = game.Live.Where(s => s.Seat > 1 && s.UserId is not null && before[s.Id] != s.ShareCredits).ToList();
        foreach (var seat in changed)
        {
            seat.UpdatedAt = now.Storable();
            MemberNotices.Stage(_db, _tenant.TenantId, await PlayerNotices.ChangedAsync(
                _db, game.Booking, seat, game.Settings, $"split:{seat.Id:N}:{now.UtcTicks}", ct), game.Settings);
        }

        if (await SaveAsync(ct) is { } conflict) return conflict;
        // I4-5: the organiser's own split change — their receipts are born read.
        await AfterAsync(game.Booking.Id, changed.Select(s => s.UserId!.Value), ct, new ReconcileOptions(Guid.Empty) { OwnActionBy = organiserId });
        return PlayerOutcome.Ok(new
        {
            booking_id = game.Booking.Id,
            split_mode = mode,
            shares = game.Live.OrderBy(s => s.Seat).Select(s => new
            {
                participant_id = s.Id,
                seat = s.Seat,
                share_credits = s.ShareCredits,
                weight = s.ShareWeight,
                needs_consent = s.Seat > 1 && s.Status == ParticipantStatus.Accepted && s.ShareCredits > s.ConsentedCredits,
            }).ToList(),
        });
    }

    // ------------------------------------------------------------------ plumbing

    /// <summary>
    /// Saves, turning a lost race into a 409 the client retries: a concurrent change to the same
    /// seat (the version token), or a seat or member taken by another request (the partial unique
    /// indexes). Nothing is half-written — the whole decision was one save.
    /// </summary>
    private async Task<PlayerOutcome?> SaveAsync(CancellationToken ct)
    {
        try
        {
            await _db.SaveChangesAsync(ct);
            return null;
        }
        catch (DbUpdateConcurrencyException)
        {
            _db.ChangeTracker.Clear();
            return PlayerOutcome.Refuse(409, PlayerErrors.Conflict);
        }
        catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: "23505" })
        {
            _db.ChangeTracker.Clear();
            return PlayerOutcome.Refuse(409, PlayerErrors.SeatTaken);
        }
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
