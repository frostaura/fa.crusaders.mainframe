using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The only path that writes to <see cref="LedgerEntry"/>. Balance is always recomputed from
/// the sum of entries — there is no stored balance field, by design.
/// <para>
/// Per Phase 8 / client blueprint Rev 2: the ledger unit is <b>credits</b>. Top-up rows also
/// capture <see cref="LedgerPosting.ZarPaid"/> + <see cref="LedgerPosting.ConversionRate"/> so the
/// ZAR→credits conversion is auditable.
/// </para>
/// </summary>
public sealed class LedgerService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly BalanceBroadcaster _broadcaster;
    private readonly IEventBus _bus;

    public LedgerService(MainframeDbContext db, ITenantContext tenant, BalanceBroadcaster broadcaster, IEventBus bus)
    { _db = db; _tenant = tenant; _broadcaster = broadcaster; _bus = bus; }

    public async Task<decimal> GetBalanceAsync(Guid userId, CancellationToken ct)
    {
        var sum = await _db.LedgerEntries
            .Where(l => l.UserId == userId)
            .SumAsync(l => (decimal?)l.AmountCredits, ct);
        return sum ?? 0m;
    }

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
        // wallet are one balance change as far as a live subscriber is concerned.
        foreach (var userId in postings.Select(p => p.UserId).Distinct())
        {
            _broadcaster.Publish(userId, await GetBalanceAsync(userId, ct));
        }

        foreach (var entry in entries) await MirrorAsync(entry, ct);

        return entries;
    }

    /// <summary>
    /// <c>credit.refunded</c>, <c>credit.penalty_applied</c> and <c>credit.adjusted</c>
    /// (spec §9), emitted where the spec says they happen — when the row is written.
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
    /// <c>credit.adjusted</c> earns its place here rather than in the admin endpoint for the
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
            LedgerEntryType.CancellationRefund => "credit.refunded",
            LedgerEntryType.NoShowPenalty or LedgerEntryType.LateCancellationPenalty => "credit.penalty_applied",
            LedgerEntryType.AdminAdjustment => "credit.adjusted",
            _ => null,
        };
        if (type is null) return;

        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: type,
            TenantId: _tenant.TenantId, TenantSlug: _tenant.TenantSlug,
            OccurredAt: entry.CreatedAt,
            ActorUserId: entry.ActorUserId, ActorIsAdmin: entry.ActorUserId != entry.UserId,
            SubjectUserId: entry.UserId,
            Data: new()
            {
                ["entry_id"] = entry.Id,
                ["user_id"] = entry.UserId,
                ["entry_type"] = entry.Type.ToString(),
                ["amount_credits"] = entry.AmountCredits,
                ["booking_id"] = entry.RelatedBookingId,
                ["reason"] = entry.Reason,
            }), ct);
    }

    private LedgerEntry Build(LedgerPosting posting) => new()
    {
        TenantId = _tenant.TenantId,
        UserId = posting.UserId,
        Type = posting.Type,
        AmountCredits = posting.AmountCredits,
        ZarPaid = posting.ZarPaid,
        ConversionRate = posting.ConversionRate,
        RelatedBookingId = posting.RelatedBookingId,
        ActorUserId = posting.ActorUserId,
        Reason = posting.Reason,
        ExternalReference = posting.ExternalReference,
    };

    public async Task<LedgerEntry> PostAsync(LedgerPosting posting, CancellationToken ct)
    {
        var entry = new LedgerEntry
        {
            TenantId = _tenant.TenantId,
            UserId = posting.UserId,
            Type = posting.Type,
            AmountCredits = posting.AmountCredits,
            ZarPaid = posting.ZarPaid,
            ConversionRate = posting.ConversionRate,
            RelatedBookingId = posting.RelatedBookingId,
            ActorUserId = posting.ActorUserId,
            Reason = posting.Reason,
            ExternalReference = posting.ExternalReference,
        };
        _db.LedgerEntries.Add(entry);
        await _db.SaveChangesAsync(ct);

        // Notify any live wallet-stream subscribers (admin top-ups, refunds, charges, etc.).
        var balance = await GetBalanceAsync(posting.UserId, ct);
        _broadcaster.Publish(posting.UserId, balance);
        await MirrorAsync(entry, ct);

        return entry;
    }
}

public sealed record LedgerPosting(
    Guid UserId,
    LedgerEntryType Type,
    decimal AmountCredits,                 // signed credits amount (legacy field name)
    Guid ActorUserId,
    Guid? RelatedBookingId = null,
    string? Reason = null,
    string? ExternalReference = null,
    decimal? ZarPaid = null,            // populated on TopUp / PaymentReversal rows
    decimal? ConversionRate = null);    // credits-per-rand applied for this posting (null on non-conversion rows)
