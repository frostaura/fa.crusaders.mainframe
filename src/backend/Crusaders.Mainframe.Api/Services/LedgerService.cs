using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
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

    public LedgerService(MainframeDbContext db, ITenantContext tenant, BalanceBroadcaster broadcaster)
    { _db = db; _tenant = tenant; _broadcaster = broadcaster; }

    public async Task<decimal> GetBalanceAsync(Guid userId, CancellationToken ct)
    {
        var sum = await _db.LedgerEntries
            .Where(l => l.UserId == userId)
            .SumAsync(l => (decimal?)l.AmountCredits, ct);
        return sum ?? 0m;
    }

    public Task<List<LedgerEntry>> GetEntriesAsync(Guid userId, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
        => _db.LedgerEntries
              .Where(l => l.UserId == userId && l.CreatedAt >= from && l.CreatedAt < to)
              .OrderByDescending(l => l.CreatedAt)
              .ToListAsync(ct);

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

        return entries;
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
