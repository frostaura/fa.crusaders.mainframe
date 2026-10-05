using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services.Realtime;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The only path that writes to <see cref="LedgerEntry"/>. Balance is always recomputed from
/// the sum of entries — there is no stored balance field, by design.
/// <para>
/// The ledger unit is <b>whole minutes</b> (P13, <c>docs/specs/minutes-and-packages.md</c>): every
/// balance, charge, refund, penalty, share and transfer is an <see cref="int"/>, and nothing in the
/// system holds a fraction of a minute. Purchase rows also capture <see cref="LedgerPosting.ZarPaid"/>,
/// the rand the package cost, so what the club took is auditable.
/// </para>
/// </summary>
public sealed class LedgerService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly IRealtimeBus _realtime;
    private readonly RealtimeOutbox _outbox;
    private readonly IEventBus _bus;
    private readonly TenantSettingsAccessor _settings;
    private readonly ShareHook? _shares;

    // The settings reader needs only the context and the tenant this service already holds, so
    // it is built here rather than injected — the six-parameter complexity gate.
    public LedgerService(
        MainframeDbContext db, ITenantContext tenant, IRealtimeBus realtime, RealtimeOutbox outbox, IEventBus bus,
        ShareHook? shares = null)
    {
        _db = db; _tenant = tenant; _realtime = realtime; _outbox = outbox; _bus = bus; _shares = shares;
        _settings = new TenantSettingsAccessor(db, tenant);
    }

    public async Task<int> GetBalanceAsync(Guid userId, CancellationToken ct)
    {
        var sum = await _db.LedgerEntries
            .Where(l => l.UserId == userId)
            .SumAsync(l => (int?)l.AmountMinutes, ct);
        return sum ?? 0;
    }

    /// <summary>
    /// The minutes a member has received as an organiser's shares that are held for their
    /// partners' possible returns (D11 — <see cref="ShareHolds"/>). Part of the balance, not
    /// spendable until <see cref="HeldMinutes.ReleasesAt"/>.
    /// </summary>
    public async Task<HeldMinutes> GetHeldAsync(Guid userId, CancellationToken ct) =>
        await ShareHolds.ForAsync(_db, userId, await _settings.GetAsync(ct), DateTimeOffset.UtcNow, ct);

    /// <summary>
    /// What a member may spend: the balance less what is held (<see cref="GetHeldAsync"/>). EVERY
    /// member spend check asks this, never <see cref="GetBalanceAsync"/> — a booking, a walk-up, a
    /// charge at the box, a volunteer paying for somebody, a partner paying a share. Only an
    /// admin's explicit overdraft looks past it, as it looks past the balance itself.
    /// </summary>
    public async Task<int> GetSpendableAsync(Guid userId, CancellationToken ct) =>
        await GetBalanceAsync(userId, ct) - (await GetHeldAsync(userId, ct)).Reserved;

    /// <summary>
    /// What may go back from <paramref name="bookingId"/> to the partner on <paramref name="seatId"/>
    /// without overdrawing its organiser (D11, review round 4): that booking's own hold — earmarked
    /// for its partners — plus the free balance left after every hold and every return that
    /// started waiting EARLIER (<see cref="ShareHolds.CoverageAsync"/>). A return posts only when
    /// this covers it, whatever the deadline, unless the desk named the overdraft. Read under the
    /// organiser's lock.
    /// </summary>
    public async Task<int> GetCoverageAsync(Guid userId, Guid bookingId, Guid seatId, CancellationToken ct) =>
        await ShareHolds.CoverageAsync(_db, new CoverageAsk(userId, bookingId, seatId, await GetBalanceAsync(userId, ct)),
            await _settings.GetAsync(ct), DateTimeOffset.UtcNow, ct);

    /// <summary>
    /// A member who has just RECEIVED minutes — a purchase, a desk adjustment, a refund, anything but
    /// a share moving between players — may now cover a return that was waiting on them. Retried
    /// in the same post-commit callback as their balance frame (one deferred item per member, as
    /// the outbox has always had), rather than at the next sweep (review round 2, M1).
    /// </summary>
    private static bool MoneyIn(IEnumerable<LedgerPosting> postings) =>
        postings.Any(p => p.AmountMinutes > 0 && p.Type != LedgerEntryType.ShareTransfer);

    /// <summary>
    /// A page of a member's movements, newest first.
    ///
    /// <para>
    /// <paramref name="skip"/> / <paramref name="take"/> default to "everything" so every
    /// existing caller is unchanged, but the wallet endpoint passes them: it used to return
    /// a member's entire ledger history on every load.
    /// </para>
    /// </summary>
    public Task<List<LedgerEntry>> GetEntriesAsync(
        Guid userId, DateTimeOffset from, DateTimeOffset to, CancellationToken ct, int skip = 0, int? take = null)
    {
        var q = _db.LedgerEntries
              .Where(l => l.UserId == userId && l.CreatedAt >= from && l.CreatedAt < to)
              .OrderByDescending(l => l.CreatedAt)
              .Skip(skip);
        if (take is { } n) q = q.Take(n);
        return q.ToListAsync(ct);
    }

    /// <summary>
    /// Posts several movements as one unit of work.
    ///
    /// <para>
    /// <see cref="PostAsync"/> saves per call, which is right when a caller has one movement
    /// to make and wrong when it has two that must not come apart. A cancellation posts a
    /// refund and a penalty separately — deliberately, because a netted row cannot answer
    /// "how much penalty did I pay?" — and posting them in two saves meant a failure between
    /// them left a full refund with no penalty. Payer reassignment had the same shape and a
    /// worse consequence: a refund to the booker, then a charge to the volunteer, then the
    /// field recording who now pays, in three independent commits.
    /// </para>
    ///
    /// <para>
    /// One save also means one concurrency check. Anything else the caller has changed on the
    /// tracked context — a booking's status, its payer — goes in the same statement batch, so
    /// the whole decision lands or none of it does.
    /// </para>
    ///
    /// <para>
    /// An empty list still saves: the caller's own pending changes are the point of the call
    /// as much as the postings are.
    /// </para>
    /// </summary>
    public async Task<IReadOnlyList<LedgerEntry>> PostManyAsync(
        IReadOnlyList<LedgerPosting> postings, CancellationToken ct)
    {
        var entries = postings.Select(Build).ToList();
        _db.LedgerEntries.AddRange(entries);
        await _db.SaveChangesAsync(ct);

        // One broadcast per affected user rather than one per row: two movements on the same
        // wallet are one balance change as far as a live subscriber is concerned. The DELTA is
        // the sum of that user's rows in this unit of work, which is why a refund and its
        // penalty animate the badge once, by their net.
        foreach (var group in postings.GroupBy(p => p.UserId))
        {
            await PublishBalanceAsync(group.Key, group.Sum(p => p.AmountMinutes), ReasonFor(group), ct, [.. group], postings);
        }

        foreach (var entry in entries) await MirrorAsync(entry, ct);

        return entries;
    }

    /// <summary>
    /// Queues the member's live balance frame for after the commit. See <see cref="RealtimeOutbox"/>
    /// for why it is not published here (D2-B07).
    ///
    /// <para>
    /// <b>Two frames, not one.</b> The unnamed <c>data:</c> frame is what ships today and what
    /// <c>balance.tsx</c> listens for as <c>message</c>; it is kept verbatim so a client on the
    /// current build keeps working through the rollout. The named <c>balance</c> frame beside it
    /// carries <c>delta_minutes</c> and <c>reason</c>, which is what GOAL item 8 actually needs:
    /// "animate the balance badge while zero to entice a user to add funds" requires the badge to
    /// know that money <i>arrived</i>, and today's payload is only the new total — from which a
    /// top-up and a cancellation refund are indistinguishable.
    /// </para>
    /// </summary>
    /// <summary>
    /// What is set aside for partners moved without a ledger row — a return started or stopped
    /// waiting (review round 4) — so the member's spendable and <c>owed_back_minutes</c> changed
    /// while their balance did not. Their live wallet is told, after the commit like any movement,
    /// with <c>delta_minutes</c> 0 and the reason <see cref="SetAsideReason"/>.
    /// </summary>
    public Task PublishSetAsideAsync(Guid userId, CancellationToken ct) => PublishBalanceAsync(userId, 0, SetAsideReason, ct);

    /// <summary>The balance frame's reason when only what is set aside moved (see <see cref="PublishSetAsideAsync"/>).</summary>
    public const string SetAsideReason = "share_set_aside";

    private Task PublishBalanceAsync(
        Guid userId, int deltaMinutes, string reason, CancellationToken ct, IReadOnlyList<LedgerPosting>? rows = null,
        IReadOnlyList<LedgerPosting>? unitOfWork = null)
    {
        // E10-1: each row's {reason, minutes}; R11 E11-1: why a share among them moved; R13 X13-2:
        // on a share row, the member on its other leg (read off the same unit of work).
        var frame = new WalletFrame(
            deltaMinutes, reason, rows is null ? [] : PartsOf(rows, unitOfWork ?? rows), rows?.Select(p => p.Share).FirstOrDefault(w => w is not null), rows is not null && MoneyIn(rows))
        {
            // R13 J13-4: the booking the movement is about, so the frame can name its court.
            BookingId = BookingOf(rows),
            // R12 C1 / C2: who cancelled, and whose scan reversed a settlement — unstored, per posting.
            CancelledBy = rows?.Select(p => p.CancelledBy).FirstOrDefault(c => c is not null),
            CheckedInBy = rows?.Select(p => p.CheckedInBy ?? p.Share?.CheckedInBy).FirstOrDefault(c => c is not null),
        };
        var tenantId = _tenant.TenantId;
        var booking = BookingOf(rows);

        return _outbox.EnqueueAsync(async token =>
        {
            // R12 X12-1: an action holding this booking's frames merges this one into the member's single frame.
            if (_outbox.Holds?.TryHold(tenantId, booking, userId, frame) == true) return;
            await SendAsync(userId, frame, token);
        }, ct);
    }

    /// <summary>
    /// Sends a frame a <see cref="WalletFrameScope"/> held — after every commit behind it, so the
    /// balance it reads is the one the member now has.
    /// </summary>
    public Task PublishFrameAsync(Guid userId, WalletFrame frame, CancellationToken ct) =>
        _outbox.EnqueueAsync(token => SendAsync(userId, frame, token), ct);

    /// <summary>The booking every row of a movement names, or null when they name none or several.</summary>
    private static Guid? BookingOf(IReadOnlyList<LedgerPosting>? rows)
    {
        if (rows is null || rows.Count == 0) return null;
        var first = rows[0].RelatedBookingId;
        return rows.All(r => r.RelatedBookingId == first) ? first : null;
    }

    private async Task SendAsync(Guid userId, WalletFrame frame, CancellationToken token)
    {
        var (tenantId, slug) = (_tenant.TenantId, _tenant.TenantSlug);
        var topic = RealtimeTopic.Wallet(tenantId, userId);
        // Optional only for the unit suites' hand-built containers; the app always registers it.
        var retry = frame.MoneyIn ? _shares : null;

        var balance = await GetBalanceAsync(userId, token);
        var held = await GetHeldAsync(userId, token);
        // R13 X13-2 / J13-4 (C13-7): the partners a share row moved to or from, and the booking's court and start.
        var counterparts = await NamesAsync([.. frame.Parts.Select(p => p.CounterpartyUserId)], token);
        var game = await GameOfAsync(frame.BookingId, token);
        // R12 E12-2 (C2): the scanner is named only when it was somebody else.
        var checkedInBy = frame.CheckedInBy is { } scanner && scanner != userId
            ? await _db.Memberships.AsNoTracking().Where(m => m.UserId == scanner).Select(m => m.FullName).FirstOrDefaultAsync(token)
            : null;

        // D11: the held part rides on the named frame, so the badge can say "12 min held until
        // Tue 18:00" beside the total. R15 X15-6/E15-2/J15-3: the NAMED frame goes FIRST and the
        // legacy unnamed frame (verbatim) after it. Sent the other way round, a client that read
        // the unnamed frame as a movement raised a reasonless toast ~1 ms before the named one
        // raised the real one; now the unnamed twin always arrives at a figure the client already
        // has, so even an older client sees a zero diff and stays quiet.
        _realtime.Publish(topic, new RealtimeMessage(BalanceEvent, JsonSerializer.Serialize(new
        {
            balance_minutes = balance,
            delta_minutes = frame.DeltaMinutes,
            reason = frame.Reason,
            at = DateTimeOffset.UtcNow,
            held_minutes = held.Held,
            owed_back_minutes = held.OwedBack,
            spendable_minutes = balance - held.Reserved,
            held_until = held.ReleasesAt,
            // C4: one part per share deadline, soonest first, summing to held_minutes; held_until is the first.
            held_parts = held.WireParts(),
            // E10-1: the rows behind delta_minutes, each {reason (by type), delta_minutes}; [] when only what is set aside moved.
            // R13 X13-2: counterparty_name on a share_transfer part — the other member on that row; null on every other part.
            parts = frame.Parts.Select(p => new
            {
                reason = p.Reason,
                delta_minutes = p.DeltaMinutes,
                counterparty_name = NameOf(counterparts, p.CounterpartyUserId),
            }).ToList(),
            // R13 J13-4: the court and start of the one booking every row names; null when none or several.
            court_name = game?.Court,
            booking_starts_at = game?.StartsAt,
            // R11 E11-1: WHY a share moved (WalletShareCauses), null unless a share row moved; and on a
            // no-show return the partner's part of the penalty that stayed behind.
            share_cause = frame.Share?.Cause,
            share_kept_minutes = frame.Share?.KeptMinutes,
            // R12 C1: on a cancellation's frame, "club" or "member"; null on anything else.
            cancelled_by = frame.CancelledBy,
            // R12 C2: on a reversal by a late check-in (and its share), the scanner when not this member.
            checked_in_by_name = string.IsNullOrWhiteSpace(checkedInBy) ? null : checkedInBy.Trim(),
            // R14 E14-2: on a share frame, the player whose act moved it when it was not this member; null otherwise.
            actor_name = await ShareActorNameAsync(frame.Share, userId, token),
        })));

        _realtime.Publish(topic, new RealtimeMessage(
            string.Empty, JsonSerializer.Serialize(new { balance_minutes = balance })));

        // Money arrived: a return waiting on this member may be covered now (see MoneyIn).
        if (retry is not null) await retry.AfterMinutesArriveAsync(tenantId, slug, [userId], token);
    }

    /// <summary>
    /// R14 E14-2: the name of the player (organiser or partner) whose act moved a share, for a member
    /// other than them; null for the member's own act, the system's, and an admin's ("the club").
    /// </summary>
    private async Task<string?> ShareActorNameAsync(ShareWhy? share, Guid userId, CancellationToken ct)
    {
        if (share is not { ActorIsPlayer: true, ActorUserId: { } actor } || actor == userId || actor == Guid.Empty) return null;
        var name = await _db.Memberships.AsNoTracking().Where(m => m.UserId == actor).Select(m => m.FullName).FirstOrDefaultAsync(ct);
        return string.IsNullOrWhiteSpace(name) ? null : name.Trim();
    }

    /// <summary>
    /// R14 E14-5: a booking the club cancelled after its session had started — nothing was refunded,
    /// so no ledger row moved and no frame went out. The member's wallet is told all the same: a
    /// balance-neutral frame (<see cref="CancelledNoRefundReason"/>, delta 0, no parts) naming the
    /// booking and who cancelled, so the phone can say what happened.
    /// </summary>
    public Task PublishCancelledNoRefundAsync(Guid userId, Guid bookingId, string cancelledBy, CancellationToken ct)
    {
        var frame = new WalletFrame(0, CancelledNoRefundReason, [], null, false) { BookingId = bookingId, CancelledBy = cancelledBy };
        return PublishFrameAsync(userId, frame, ct);
    }

    /// <summary>The frame reason of <see cref="PublishCancelledNoRefundAsync"/>.</summary>
    public const string CancelledNoRefundReason = "cancelled_no_refund";

    /// <summary>R13 J13-4 (C13-7): the court and start of the booking a frame is about; null when it names none.</summary>
    private async Task<(string? Court, DateTimeOffset StartsAt)?> GameOfAsync(Guid? bookingId, CancellationToken ct)
    {
        if (bookingId is null) return null;
        var game = await _db.Bookings.AsNoTracking().Where(b => b.Id == bookingId)
            .Select(b => new { b.StartsAt, Court = _db.Courts.Where(c => c.Id == b.CourtId).Select(c => c.Name).FirstOrDefault() })
            .FirstOrDefaultAsync(ct);
        return game is null ? null : (game.Court, game.StartsAt);
    }

    /// <summary>R13 X13-2 (C13-7): the other member on a share row, by name; null on every other part.</summary>
    private static string? NameOf(IReadOnlyDictionary<Guid, string> names, Guid? userId) =>
        userId.HasValue ? names.GetValueOrDefault(userId.Value) : null;

    /// <summary>The named SSE event the wallet stream carries alongside its legacy unnamed frame.</summary>
    public const string BalanceEvent = "balance";

    /// <summary>
    /// Why the member's balance moved, as a closed set the client maps to a sentence and an
    /// animation. Derived from the ledger type, because that is the only thing in the system
    /// that actually knows.
    ///
    /// <para>
    /// <c>mixed</c> exists for the one honest case: a unit of work that posts two different
    /// kinds of row for one member — a cancellation's refund and its penalty. Inventing a single
    /// reason for that pair would make the badge claim one of them happened and the other did
    /// not, and the member's statement says otherwise.
    /// </para>
    /// </summary>
    internal static string ReasonFor(IEnumerable<LedgerPosting> postings)
    {
        // E10-1: a unit of work that names its own stream reason says it; otherwise by type.
        var kinds = postings.Select(p => p.StreamReason ?? ReasonFor(p.Type)).Distinct().ToList();
        return kinds.Count == 1 ? kinds[0] : "mixed";
    }

    /// <summary>
    /// E10-1: each row of the movement for the frame's <c>parts</c> — its type reason and its
    /// signed minutes — so a refund-and-penalty pair can be said as both, not as their net.
    /// </summary>
    internal static IReadOnlyList<BalancePart> PartsOf(IEnumerable<LedgerPosting> postings, IReadOnlyList<LedgerPosting>? unitOfWork = null)
    {
        // Block body: lizard reads an object initialiser's `{` in an expression body as the end of the function (see below).
        return [.. postings.Select(p => new BalancePart(ReasonFor(p.Type), p.AmountMinutes) { CounterpartyUserId = CounterpartyOf(p, unitOfWork) })];
    }

    /// <summary>
    /// R13 X13-2: on a share leg, the member on the pair's other leg (R15 E15-7: or whoever the posting names) — the leg posted beside it under
    /// the same <c>share:{seat}:{seq}:</c> reference (<c>:out</c> / <c>:in</c>). Null on anything else.
    /// </summary>
    internal static Guid? CounterpartyOf(LedgerPosting posting, IReadOnlyList<LedgerPosting>? unitOfWork)
    {
        // R15 E15-7: a posting that names its other member says so itself (a pay-for).
        if (posting.CounterpartyUserId is { } named) return named;
        if (posting.Type != LedgerEntryType.ShareTransfer || unitOfWork is null || PairKey(posting.ExternalReference) is not { } key) return null;
        return unitOfWork.FirstOrDefault(o => !ReferenceEquals(o, posting) && o.Type == LedgerEntryType.ShareTransfer
                                              && o.UserId != posting.UserId && PairKey(o.ExternalReference) == key)?.UserId;
    }

    /// <summary>A share leg's reference without its leg suffix, or null.</summary>
    private static string? PairKey(string? reference)
    {
        if (reference is null) return null;
        var cut = reference.LastIndexOf(':');
        return cut > 0 ? reference[..cut] : null;
    }

    /// <summary>Members' names by id, for the frame. One read; empty when nobody is asked about.</summary>
    private async Task<Dictionary<Guid, string>> NamesAsync(IReadOnlyCollection<Guid?> ids, CancellationToken ct)
    {
        var wanted = ids.Where(i => i is not null).Select(i => i!.Value).Distinct().ToList();
        if (wanted.Count == 0) return [];
        return await _db.Memberships.AsNoTracking().Where(m => wanted.Contains(m.UserId))
            .ToDictionaryAsync(m => m.UserId, m => m.FullName.Trim(), ct);
    }

    // Block body, not an expression one: lizard's C# parser reads the `{` of a switch or an
    // object initialiser as the END of the function and dumps the rest of the file into a
    // *global* pseudo-function whose length trips `-L 200`. See memory/gotchas.md.
    internal static string ReasonFor(LedgerEntryType type)
    {
        return type switch
        {
            LedgerEntryType.TopUp => "top_up",
            LedgerEntryType.AdminAdjustment => "admin_adjustment",
            LedgerEntryType.AdminTopUp => "admin_top_up",
            LedgerEntryType.BookingCharge => "booking_charge",
            LedgerEntryType.CancellationRefund => "cancellation_refund",
            LedgerEntryType.NoShowPenalty or LedgerEntryType.LateCancellationPenalty => "penalty",
            LedgerEntryType.LightsPurchase => "lights_purchase",
            LedgerEntryType.ShareTransfer => "share_transfer",
            LedgerEntryType.PaymentReversal => "correction",
            _ => "unknown",
        };
    }

    /// <summary>
    /// <c>minutes.refunded</c>, <c>minutes.penalty_applied</c>, <c>minutes.adjusted</c> and
    /// <c>minutes.sold_at_desk</c> (<see cref="MinutesEvents"/>; webhooks spec §9), emitted where the spec says they happen — when the row is written.
    ///
    /// <para>
    /// They are here rather than at the cancellation, no-show and admin-adjust call sites for
    /// the reason the class comment gives about being the only path that writes a
    /// <see cref="LedgerEntry"/>: a refund posted by cancellation, by a no-show reversal, by
    /// a displacement or by any future path is the same event to an accounting consumer, and
    /// pinning the emit to one caller would have mirrored one of the four. It is deliberately
    /// <i>not</i> a duplicate of <c>booking.late_cancellation</c>: that event says a booking
    /// was cancelled late, this one says money moved and how much, and a consumer reconciling
    /// a wallet needs the second.
    /// </para>
    ///
    /// <para>
    /// <c>minutes.adjusted</c> earns its place here rather than in the admin endpoint for the
    /// same reason, and for one more: an adjustment is the only movement in the system a
    /// human decides by hand, so an accounting pipe fed by webhooks saw every automatic
    /// charge and refund and silently missed every desk correction.
    /// </para>
    ///
    /// <para>
    /// After the save, always — a posting that failed its concurrency check threw above and
    /// never reaches here, which is what stops the bus mirroring a movement the ledger does
    /// not have. Emitting is a channel write; it cannot fail the money path.
    /// </para>
    /// </summary>
    /// <summary>
    /// The event name for one row, read from its type AND its sign. A refund row is money back and
    /// a penalty row money kept — except on the late-evidence reversal of a no-show, which posts
    /// each leg's opposite under the same type. Named by type alone those went out as
    /// <c>minutes.refunded</c> −45 and <c>minutes.penalty_applied</c> +13 (review round 6, E6-11).
    /// Block body for the lizard reason in <c>memory/gotchas-gates.md</c>.
    /// </summary>
    internal static string? MirrorTypeOf(LedgerEntry entry)
    {
        return entry.Type switch
        {
            LedgerEntryType.CancellationRefund when entry.AmountMinutes < 0 => MinutesEvents.RefundReversed,
            LedgerEntryType.CancellationRefund => MinutesEvents.Refunded,
            LedgerEntryType.NoShowPenalty or LedgerEntryType.LateCancellationPenalty when entry.AmountMinutes > 0 => MinutesEvents.PenaltyReturned,
            LedgerEntryType.NoShowPenalty or LedgerEntryType.LateCancellationPenalty => MinutesEvents.PenaltyApplied,
            LedgerEntryType.AdminAdjustment => MinutesEvents.Adjusted,
            LedgerEntryType.AdminTopUp => MinutesEvents.SoldAtDesk,
            _ => null,
        };
    }

    private async Task MirrorAsync(LedgerEntry entry, CancellationToken ct)
    {
        var type = MirrorTypeOf(entry);
        if (type is null) return;

        var (actorUserId, actorIsAdmin) = ActorOf(entry, await HoldsAdminAsync(entry.ActorUserId, ct));
        var tenantId = _tenant.TenantId;
        var tenantSlug = _tenant.TenantSlug;

        // Queued behind the commit, exactly as the balance frame is: a webhook consumer told a
        // penalty was applied and then left with no such row is worse off than one told a
        // moment late, because nothing ever retracts it (D2-B07).
        var data = new Dictionary<string, object?>
        {
            ["entry_id"] = entry.Id,
            ["user_id"] = entry.UserId,
            ["entry_type"] = entry.Type.ToString(),
            ["amount_minutes"] = entry.AmountMinutes,
            ["booking_id"] = entry.RelatedBookingId,
            ["reason"] = entry.Reason,
        };
        // R15 E15-5: a desk sale says what the desk took and whether it was a gift — a consumer could
        // not tell a R0.00 "Give" from a paid sale. zar_received is the rand (0 on a gift, never null);
        // given is GivenMinutes.IsGiven, the one rule reports, the Night and the desk mail already use.
        if (type == MinutesEvents.SoldAtDesk)
        {
            data["zar_received"] = entry.ZarPaid ?? 0m;
            data["given"] = GivenMinutes.IsGiven(entry.Type, entry.ZarPaid);
        }

        await _outbox.EnqueueAsync(async token => await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: type,
            TenantId: tenantId, TenantSlug: tenantSlug,
            OccurredAt: entry.CreatedAt,
            ActorUserId: actorUserId, ActorIsAdmin: actorIsAdmin,
            SubjectUserId: entry.UserId,
            Data: data), token), ct);
    }

    /// <summary>
    /// Who performed this movement, as a webhook consumer should read it.
    ///
    /// <para>
    /// <b>D2-B41.</b> This was <c>ActorIsAdmin: entry.ActorUserId != entry.UserId</c>, which is
    /// wrong in both directions at once. Every SYSTEM posting — the no-show sweep's refund and
    /// penalty, the no-show reversal's two legs, a displacement, a reinstatement — carries
    /// <c>ActorUserId = Guid.Empty</c>, so all of them went out as
    /// <c>actor.is_admin: true</c> with an <b>all-zero actor id</b>: an accounting consumer
    /// reconciling by actor saw a phantom administrator issuing every automatic penalty the club
    /// has ever applied. And in the other direction, a member paying for a friend's booking
    /// differs from the subject and is not an admin either.
    /// </para>
    ///
    /// <para>
    /// <c>Guid.Empty</c> becomes a <b>null</b> actor, which is what every other system emitter in
    /// this tree already does (<c>MemberApprovalService</c> guards exactly this). The empty Guid
    /// stays in the COLUMN — <c>BookingService</c> queries <c>l.ActorUserId == Guid.Empty</c> to
    /// find system rows, and changing the column would be a schema migration in service of a
    /// wire bug — so the translation happens here, at the wire, where the lie was.
    /// </para>
    ///
    /// <para>
    /// <b>Review round 13, E13-2: the role is READ.</b> A human actor different from the subject
    /// was reported <c>is_admin: true</c> by inference — "three of the four mirrored types are
    /// admin-only by route". The fourth is not: a member paying for somebody else's court at the
    /// box posts that member's <c>minutes.refunded</c>, and the webhook named an ordinary member
    /// an administrator. <paramref name="actorHoldsAdmin"/> is the actor's own
    /// <see cref="User.IsAdmin"/> in this club (<see cref="HoldsAdminAsync"/>), so an admin is an
    /// admin on their own wallet as well, and nobody else ever is.
    /// </para>
    /// </summary>
    internal static (Guid? ActorUserId, bool ActorIsAdmin) ActorOf(LedgerEntry entry, bool actorHoldsAdmin)
        => entry.ActorUserId == Guid.Empty
            ? (null, false)
            : (entry.ActorUserId, actorHoldsAdmin);

    /// <summary>
    /// E13-2: whether this person holds the admin role in this club now — one read of one
    /// column, tenant-filtered like every <c>Users</c> read. The system (<see cref="Guid.Empty"/>)
    /// never does, and is not read.
    /// </summary>
    private async Task<bool> HoldsAdminAsync(Guid actorUserId, CancellationToken ct)
    {
        if (actorUserId == Guid.Empty) return false;
        return await _db.Users.AsNoTracking().AnyAsync(u => u.Id == actorUserId && u.IsAdmin, ct);
    }

    // Block body, not an expression one: lizard's C# parser reads the `{` of a switch or an
    // object initialiser as the END of the function and dumps the rest of the file into a
    // *global* pseudo-function whose length trips `-L 200`. See memory/gotchas.md.
    private LedgerEntry Build(LedgerPosting posting)
    {
        return new LedgerEntry
        {
            TenantId = _tenant.TenantId,
            UserId = posting.UserId,
            Type = posting.Type,
            AmountMinutes = posting.AmountMinutes,
            ZarPaid = posting.ZarPaid,
            RelatedBookingId = posting.RelatedBookingId,
            ActorUserId = posting.ActorUserId,
            Reason = posting.Reason,
            ExternalReference = posting.ExternalReference,
            CreatedAt = posting.At ?? DateTimeOffset.UtcNow,
        };
    }

    public async Task<LedgerEntry> PostAsync(LedgerPosting posting, CancellationToken ct)
    {
        var entry = new LedgerEntry
        {
            TenantId = _tenant.TenantId,
            UserId = posting.UserId,
            Type = posting.Type,
            AmountMinutes = posting.AmountMinutes,
            ZarPaid = posting.ZarPaid,
            RelatedBookingId = posting.RelatedBookingId,
            ActorUserId = posting.ActorUserId,
            Reason = posting.Reason,
            ExternalReference = posting.ExternalReference,
            CreatedAt = posting.At ?? DateTimeOffset.UtcNow,
        };
        _db.LedgerEntries.Add(entry);
        await _db.SaveChangesAsync(ct);

        // Queued for after the commit, not published here — D2-B07 and RealtimeOutbox.
        await PublishBalanceAsync(posting.UserId, posting.AmountMinutes, ReasonFor([posting]), ct, [posting]);
        await MirrorAsync(entry, ct);

        return entry;
    }
}

public sealed record LedgerPosting(
    Guid UserId,
    LedgerEntryType Type,
    int AmountMinutes,                  // signed whole minutes: positive in, negative out
    Guid ActorUserId,
    Guid? RelatedBookingId = null,
    string? Reason = null,
    string? ExternalReference = null,
    decimal? ZarPaid = null)            // the rand that moved, on TopUp / AdminTopUp / PaymentReversal rows
{
    /// <summary>
    /// Review round 10, E10-1: the live wallet frame's <c>reason</c> when the ledger type alone
    /// would misstate WHY the minutes moved — an outage refund, its reversal, a pay-for refund and
    /// a displacement are all <see cref="LedgerEntryType.CancellationRefund"/> rows, and a no-show
    /// settlement is a refund and a penalty that read as <c>mixed</c>. One of
    /// <see cref="WalletStreamReasons"/>; null keeps the type's own reason. Never stored.
    /// </summary>
    public string? StreamReason { get; init; }

    /// <summary>
    /// Review round 11, E11-1: on a <see cref="LedgerEntryType.ShareTransfer"/> leg, why the share
    /// moved — the frame's <c>share_cause</c>. "15 minutes … came back from Cleo" after an outage
    /// refund told the partner the organiser had returned it. Null elsewhere. Never stored.
    /// </summary>
    public ShareWhy? Share { get; init; }

    /// <summary>
    /// R15 E15-7: the other member a non-share movement is about — on a pay-for, the payer on the
    /// booker's refund and the booker on the payer's charge — so the frame's part carries
    /// <c>counterparty_name</c> as a share leg's does. Never stored.
    /// </summary>
    public Guid? CounterpartyUserId { get; init; }

    /// <summary>
    /// R15 D14-4: when the act that wrote this row happened, on the caller's clock — the injected
    /// <see cref="TimeProvider"/> on every device-triggered path (a walk-up, a pay-for, a check-in's
    /// charge, a reversal, a release, the no-show sweep). Null: the wall clock, as before. Stored as
    /// the row's <c>CreatedAt</c>, so a device decision and its money are on one clock.
    /// </summary>
    public DateTimeOffset? At { get; init; }

    /// <summary>Review round 12, C1: on a cancellation's refund and penalty, who cancelled (<see cref="WalletCancelledBy"/>). Never stored.</summary>
    public string? CancelledBy { get; init; }

    /// <summary>Review round 12, C2: on a reversal by a late check-in, the member whose scan it was. Never stored.</summary>
    public Guid? CheckedInBy { get; init; }
}

/// <summary>
/// Why a share moved (one of <see cref="WalletShareCauses"/>), and on a no-show return the minutes kept as the partner's part of the penalty.
/// R12 C2: on a share taken again after a late check-in, the member whose scan it was.
/// </summary>
public sealed record ShareWhy(string Cause, int? KeptMinutes = null, Guid? CheckedInBy = null)
{
    /// <summary>
    /// R14 E14-2: the person whose act moved the share — the organiser who took a partner off or
    /// changed the split, who cancelled, the partner who withdrew, the admin, the scanner. Null when
    /// the club's system did it. The pair's ledger rows carry it as their actor.
    /// </summary>
    public Guid? ActorUserId { get; init; }

    /// <summary>
    /// R14 E14-2: <see cref="ActorUserId"/> is a player on the game (its organiser or a partner),
    /// so a member may be told their name — the frame's <c>actor_name</c>. An admin is "the club".
    /// </summary>
    public bool ActorIsPlayer { get; init; }
}

/// <summary>
/// The closed set the live wallet frame's <c>share_cause</c> carries (review round 11, E11-1). The
/// direction is the sign of <c>delta_minutes</c>; this is the reason.
/// </summary>
public static class WalletShareCauses
{
    /// <summary>The partner paid their share to the organiser.</summary>
    public const string SharePaid = "share_paid";

    /// <summary>The club collected the partner's share by hand.</summary>
    public const string ClubCollected = "club_collected";

    /// <summary>Taken again: a late check-in reversed the club's refund — the session was attended.</summary>
    public const string Attended = "attended";

    /// <summary>The partner withdrew from the game, so their share went back (narrowed in R14: nothing else).</summary>
    public const string ShareReturned = "share_returned";

    /// <summary>R14 X14-2: the organiser took the partner off the game, so their paid share went back.</summary>
    public const string OrganiserRemoved = Email.ShareActs.OrganiserRemoved;

    /// <summary>R14 X14-2: the organiser lowered the partner's share while they are still on the game; the difference went back.</summary>
    public const string SplitChanged = Email.ShareActs.SplitChanged;

    /// <summary>R14 review M1: the club recorded the partner's share as paid outside the app, so what they paid in the app went back.</summary>
    public const string ClubSettled = Email.ShareActs.ClubSettled;

    /// <summary>R16 J16-2: a player was added (by the organiser or the club) and the split went down; the difference went back.</summary>
    public const string PlayerAdded = Email.ShareActs.PlayerAdded;

    /// <summary>
    /// R14 review M1/L1: a share went back and no record names an act — a desk adjustment to the
    /// booking, a removal from before R14. Said plainly, with nobody named.
    /// </summary>
    public const string ShareBack = "share_back";

    /// <summary>The booking was cancelled, so the share went back.</summary>
    public const string BookingCancelled = Email.ShareActs.BookingCancelled;

    /// <summary>The club took the partner off the game.</summary>
    public const string ClubRemoved = "club_removed";

    /// <summary>The club refunded the session: the court's box was offline.</summary>
    public const string OutageRefund = "outage_refund";

    /// <summary>The sweep settled a no-show: the share came back less the partner's part of the penalty.</summary>
    public const string NoShow = "no_show";

    /// <summary>The court was already in use by an earlier booking: refunded in full.</summary>
    public const string Displaced = "displaced";
}

/// <summary>
/// The precise reasons the live wallet frame carries beside the per-type ones
/// (<see cref="LedgerService.ReasonFor(LedgerEntryType)"/>), so the phone can word a movement
/// truthfully (review round 10, E10-1). A real cancellation keeps <c>cancellation_refund</c> /
/// <c>mixed</c>; the frame's <c>parts</c> carry each row's own type reason and minutes.
/// </summary>
public static class WalletStreamReasons
{
    /// <summary>The sweep refunded a booking in full because its court's box was offline. Positive.</summary>
    public const string OutageRefund = "outage_refund";

    /// <summary>An outage refund taken back: the box's queued check-in arrived. Negative.</summary>
    public const string OutageRefundReversed = "outage_refund_reversed";

    /// <summary>The sweep settled a no-show: refund and penalty (parts), net delta.</summary>
    public const string NoShowSettled = "no_show_settled";

    /// <summary>A no-show settlement undone by a late check-in: refund taken back, penalty returned (parts).</summary>
    public const string NoShowReversed = "no_show_reversed";

    /// <summary>Somebody else paid for this member's booking at the court: their charge came back. Positive.</summary>
    public const string PayForRefund = "pay_for_refund";

    /// <summary>This member paid for somebody else's booking at the court. Negative.</summary>
    public const string PayForCharge = "pay_for_charge";

    /// <summary>The booking was displaced by an earlier one whose attendance arrived late: refunded in full (or its penalty returned). Positive.</summary>
    public const string DisplacedRefund = "displaced_refund";

    /// <summary>A displaced booking reinstated: its refund taken back. Negative.</summary>
    public const string DisplacedReinstated = "displaced_reinstated";
}

/// <summary>
/// The one definition of GIVEN minutes (R14 review L5): a desk top-up the club took no rand for —
/// <c>ZarPaid</c> 0 or none recorded. The reports, the Night and the desk mail all read it here.
/// </summary>
public static class GivenMinutes
{
    public static bool IsGiven(LedgerEntryType type, decimal? zarPaid) => type == LedgerEntryType.AdminTopUp && (zarPaid ?? 0m) == 0m;
}

/// <summary>One ledger row of a live wallet movement: its type reason and its signed minutes (E10-1).</summary>
public sealed record BalancePart(string Reason, int DeltaMinutes)
{
    /// <summary>R13 X13-2: on a share row, the member on its other leg. Null elsewhere.</summary>
    public Guid? CounterpartyUserId { get; init; }
}
