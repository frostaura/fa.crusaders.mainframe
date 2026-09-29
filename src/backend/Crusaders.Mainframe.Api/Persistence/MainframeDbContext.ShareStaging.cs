using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// D11, review round 8: the partners' shares follow the organiser's <c>Owed</c>, and that follow-up
/// runs AFTER the settlement commits (<c>ShareHook</c>). A settlement whose hook never runs — the
/// admin's connection dropped, the process restarted in between — used to leave nothing behind: no
/// stamp, no marker, and on a game older than the sweep's window the partner's return was stranded
/// for good.
///
/// <para>
/// So every save that may move a booking's <c>Owed</c> — a ledger row naming the booking (a refund,
/// a penalty, a desk credit or debit; share transfers excepted, they are the follow-up itself), or
/// a change to its status or check-in — stages the durable "reconcile due" marker on that booking
/// IN THE SAME TRANSACTION, when it has partner seats. Crash-safe by construction: the money and
/// the marker commit together or not at all. The hook's reconcile, starting after the commit,
/// clears it (the guarded clear); if the hook never runs, the next minute sweep reaches it however
/// old the booking is. Staging counts no failed attempt, so the sweep does not back off from it.
/// </para>
/// </summary>
public partial class MainframeDbContext
{
    /// <summary>The bookings this save may move <c>Owed</c> on. Read before the save; states change after it.</summary>
    private List<Guid> BookingsOwedMayMove()
    {
        var fromLedger = ChangeTracker.Entries<LedgerEntry>()
            .Where(e => e.State == EntityState.Added && e.Entity.RelatedBookingId != null && e.Entity.Type != LedgerEntryType.ShareTransfer)
            .Select(e => e.Entity.RelatedBookingId!.Value);
        var fromBooking = ChangeTracker.Entries<Booking>()
            .Where(e => e.State == EntityState.Modified
                        && (e.Property(b => b.Status).IsModified || e.Property(b => b.CheckedInAt).IsModified))
            .Select(e => e.Entity.Id);
        return fromLedger.Concat(fromBooking).Distinct().ToList();
    }

    /// <summary>The bookings among <paramref name="bookingIds"/> that have partner seats.</summary>
    private IQueryable<Booking> WithPartnerSeats(List<Guid> bookingIds) =>
        Bookings.IgnoreQueryFilters()
            .Where(b => bookingIds.Contains(b.Id)
                        && BookingParticipants.IgnoreQueryFilters().Any(p => p.BookingId == b.Id && p.Seat > 1));

    /// <summary>Stages the marker on those of <paramref name="bookingIds"/> that have partner seats, in the current transaction.</summary>
    private Task<int> StageShareReconcileAsync(List<Guid> bookingIds, CancellationToken ct)
    {
        var at = DateTimeOffset.UtcNow.Storable();
        return WithPartnerSeats(bookingIds).ExecuteUpdateAsync(u => u
            .SetProperty(b => b.ShareReconcileDueAt, b => b.ShareReconcileDueAt ?? at)
            .SetProperty(b => b.ShareReconcileLastAttemptAt, at), ct);
    }

    /// <summary>The same, synchronously, for <see cref="SaveChanges(bool)"/>.</summary>
    private int StageShareReconcile(List<Guid> bookingIds)
    {
        var at = DateTimeOffset.UtcNow.Storable();
        return WithPartnerSeats(bookingIds).ExecuteUpdate(u => u
            .SetProperty(b => b.ShareReconcileDueAt, b => b.ShareReconcileDueAt ?? at)
            .SetProperty(b => b.ShareReconcileLastAttemptAt, at));
    }

    /// <summary>
    /// The save, with the marker staged beside it: inside the caller's transaction when there is
    /// one, else inside one opened here. Providers without transactions (the in-memory unit
    /// suites) and ExecuteUpdate save as before.
    /// </summary>
    private async Task<int> SaveStagingShareReconcileAsync(bool acceptAllChangesOnSuccess, CancellationToken ct)
    {
        var bookings = Database.IsRelational() ? BookingsOwedMayMove() : [];
        if (bookings.Count == 0) return await base.SaveChangesAsync(acceptAllChangesOnSuccess, ct);

        if (Database.CurrentTransaction is not null)
        {
            var saved = await base.SaveChangesAsync(acceptAllChangesOnSuccess, ct);
            await StageShareReconcileAsync(bookings, ct);
            return saved;
        }

        await using var transaction = await Database.BeginTransactionAsync(ct);
        var written = await base.SaveChangesAsync(acceptAllChangesOnSuccess, ct);
        await StageShareReconcileAsync(bookings, ct);
        await transaction.CommitAsync(ct);
        return written;
    }

    /// <summary>The synchronous spelling of <see cref="SaveStagingShareReconcileAsync"/>.</summary>
    private int SaveStagingShareReconcile(bool acceptAllChangesOnSuccess)
    {
        var bookings = Database.IsRelational() ? BookingsOwedMayMove() : [];
        if (bookings.Count == 0) return base.SaveChanges(acceptAllChangesOnSuccess);

        if (Database.CurrentTransaction is not null)
        {
            var saved = base.SaveChanges(acceptAllChangesOnSuccess);
            StageShareReconcile(bookings);
            return saved;
        }

        using var transaction = Database.BeginTransaction();
        var written = base.SaveChanges(acceptAllChangesOnSuccess);
        StageShareReconcile(bookings);
        transaction.Commit();
        return written;
    }
}
