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
            .SumAsync(l => (decimal?)l.AmountZar, ct);
        return sum ?? 0m;
    }

    public Task<List<LedgerEntry>> GetEntriesAsync(Guid userId, DateTimeOffset from, DateTimeOffset to, CancellationToken ct)
        => _db.LedgerEntries
              .Where(l => l.UserId == userId && l.CreatedAt >= from && l.CreatedAt < to)
              .OrderByDescending(l => l.CreatedAt)
              .ToListAsync(ct);

    public async Task<LedgerEntry> PostAsync(LedgerPosting posting, CancellationToken ct)
    {
        var entry = new LedgerEntry
        {
            TenantId = _tenant.TenantId,
            UserId = posting.UserId,
            Type = posting.Type,
            AmountZar = posting.AmountZar,
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
    decimal AmountZar,                 // signed credits amount (legacy field name)
    Guid ActorUserId,
    Guid? RelatedBookingId = null,
    string? Reason = null,
    string? ExternalReference = null,
    decimal? ZarPaid = null,            // populated on TopUp / PaymentReversal rows
    decimal? ConversionRate = null);    // credits-per-rand applied for this posting (null on non-conversion rows)
