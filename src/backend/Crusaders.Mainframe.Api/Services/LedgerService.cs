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
            await PublishBalanceAsync(group.Key, group.Sum(p => p.AmountMinutes), ReasonFor(group), ct, MoneyIn(group));
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

    private Task PublishBalanceAsync(Guid userId, int deltaMinutes, string reason, CancellationToken ct, bool moneyIn = false)
    {
        var (tenantId, slug) = (_tenant.TenantId, _tenant.TenantSlug);
        var topic = RealtimeTopic.Wallet(tenantId, userId);
        // Optional only for the unit suites' hand-built containers; the app always registers it.
        var retry = moneyIn ? _shares : null;

        return _outbox.EnqueueAsync(async token =>
        {
            var balance = await GetBalanceAsync(userId, token);
            var held = await GetHeldAsync(userId, token);

            _realtime.Publish(topic, new RealtimeMessage(
                string.Empty, JsonSerializer.Serialize(new { balance_minutes = balance })));

            // D11: the held part rides on the named frame, so the badge can say "12 min held until
            // Tue 18:00" beside the total. The legacy unnamed frame above stays verbatim.
            _realtime.Publish(topic, new RealtimeMessage(BalanceEvent, JsonSerializer.Serialize(new
            {
                balance_minutes = balance,
                delta_minutes = deltaMinutes,
                reason,
                at = DateTimeOffset.UtcNow,
                held_minutes = held.Held,
                owed_back_minutes = held.OwedBack,
                spendable_minutes = balance - held.Reserved,
                held_until = held.ReleasesAt,
                // C4: one part per share deadline, soonest first, summing to held_minutes; held_until is the first.
                held_parts = held.WireParts(),
            })));

            // Money arrived: a return waiting on this member may be covered now (see MoneyIn).
            if (retry is not null) await retry.AfterMinutesArriveAsync(tenantId, slug, [userId], token);
        }, ct);
    }

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
        var kinds = postings.Select(p => ReasonFor(p.Type)).Distinct().ToList();
        return kinds.Count == 1 ? kinds[0] : "mixed";
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
    private async Task MirrorAsync(LedgerEntry entry, CancellationToken ct)
    {
        var type = entry.Type switch
        {
            LedgerEntryType.CancellationRefund => MinutesEvents.Refunded,
            LedgerEntryType.NoShowPenalty or LedgerEntryType.LateCancellationPenalty => MinutesEvents.PenaltyApplied,
            LedgerEntryType.AdminAdjustment => MinutesEvents.Adjusted,
            LedgerEntryType.AdminTopUp => MinutesEvents.SoldAtDesk,
            _ => null,
        };
        if (type is null) return;

        var (actorUserId, actorIsAdmin) = ActorOf(entry);
        var tenantId = _tenant.TenantId;
        var tenantSlug = _tenant.TenantSlug;

        // Queued behind the commit, exactly as the balance frame is: a webhook consumer told a
        // penalty was applied and then left with no such row is worse off than one told a
        // moment late, because nothing ever retracts it (D2-B07).
        await _outbox.EnqueueAsync(async token => await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: type,
            TenantId: tenantId, TenantSlug: tenantSlug,
            OccurredAt: entry.CreatedAt,
            ActorUserId: actorUserId, ActorIsAdmin: actorIsAdmin,
            SubjectUserId: entry.UserId,
            Data: new()
            {
                ["entry_id"] = entry.Id,
                ["user_id"] = entry.UserId,
                ["entry_type"] = entry.Type.ToString(),
                ["amount_minutes"] = entry.AmountMinutes,
                ["booking_id"] = entry.RelatedBookingId,
                ["reason"] = entry.Reason,
            }), token), ct);
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
    /// <b>What is NOT claimed:</b> a human actor different from the subject is reported
    /// <c>is_admin: true</c> only because this row is one of the four types mirrored above, and
    /// three of those four are reachable only from an admin route. The honest test — does this
    /// actor hold the admin role — needs a user read this method does not have and the callers
    /// do not carry; <c>AdminTopUp</c> and <c>AdminAdjustment</c> are admin-only by route, and
    /// the refund/penalty pair is system-posted. Recorded rather than papered over, so the next
    /// reader knows which half is structural and which is inference.
    /// </para>
    /// </summary>
    internal static (Guid? ActorUserId, bool ActorIsAdmin) ActorOf(LedgerEntry entry)
        => entry.ActorUserId == Guid.Empty
            ? (null, false)
            : (entry.ActorUserId, entry.ActorUserId != entry.UserId);

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
        };
        _db.LedgerEntries.Add(entry);
        await _db.SaveChangesAsync(ct);

        // Queued for after the commit, not published here — D2-B07 and RealtimeOutbox.
        await PublishBalanceAsync(posting.UserId, posting.AmountMinutes, ReasonFor(posting.Type), ct, MoneyIn([posting]));
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
    decimal? ZarPaid = null);           // the rand that moved, on TopUp / AdminTopUp / PaymentReversal rows
