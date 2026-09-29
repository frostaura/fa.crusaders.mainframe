using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// D14 (<c>docs/specs/play.md</c> §7.1): every save that may move a member's play record stages the
/// booking's <c>PlayRecomputeDueAt</c> marker IN THE SAME TRANSACTION, and <c>PlayWorker</c> drains it.
///
/// <para>
/// <b>A save-level rule rather than call sites</b>, for the reason <c>ShareStaging</c> gives: the
/// check-in is written by the box's online scan, its uploaded event, the walk-up, the kiosk and a
/// no-show reversal, and a rule each call site must remember is a rule one of them forgets. The
/// marker never touches a ledger row and never bumps a booking's <c>Version</c> — it is an
/// <c>UPDATE</c> of its own column after the save, inside the save's transaction.
/// </para>
///
/// <para>
/// <b>The marker is set to NOW, not kept at an earlier value</b> (a deviation from §7.1's
/// "keeping an earlier value", recorded in the P12 report): the worker clears it only when it is
/// not newer than its own pass's start, so a change that commits while a pass is evaluating must
/// move the marker past that start — an earlier value kept would be cleared, and the change lost
/// until something else touched the booking.
/// </para>
/// </summary>
public partial class MainframeDbContext
{
    /// <summary>The bookings this save may move a play record on. Read before the save; states change after it.</summary>
    private List<Guid> BookingsPlayMayMove()
    {
        var fromBooking = ChangeTracker.Entries<Booking>()
            .Where(e => e.Entity.UserId != null
                        && ((e.State == EntityState.Modified
                             && (e.Property(b => b.Status).IsModified || e.Property(b => b.CheckedInAt).IsModified))
                            || (e.State == EntityState.Added && e.Entity.CheckedInAt != null)))
            .Select(e => e.Entity.Id);
        var fromSeat = ChangeTracker.Entries<BookingParticipant>()
            .Where(e => e.State == EntityState.Added
                        || (e.State == EntityState.Modified
                            && (e.Property(p => p.Status).IsModified || e.Property(p => p.CheckedInAt).IsModified)))
            .Select(e => e.Entity.BookingId);
        var fromResult = ChangeTracker.Entries<MatchResult>()
            .Where(e => e.State is EntityState.Added or EntityState.Modified)
            .Select(e => e.Entity.BookingId);
        return fromBooking.Concat(fromSeat).Concat(fromResult).Distinct().ToList();
    }

    /// <summary>Only a member's booking has players to evaluate; an admin block has none.</summary>
    private IQueryable<Booking> MemberBookings(List<Guid> bookingIds) =>
        Bookings.IgnoreQueryFilters().Where(b => bookingIds.Contains(b.Id) && b.UserId != null);

    private Task<int> StagePlayRecomputeAsync(List<Guid> bookingIds, CancellationToken ct)
    {
        var at = DateTimeOffset.UtcNow.Storable();
        return MemberBookings(bookingIds).ExecuteUpdateAsync(u => u.SetProperty(b => b.PlayRecomputeDueAt, at), ct);
    }

    private int StagePlayRecompute(List<Guid> bookingIds)
    {
        var at = DateTimeOffset.UtcNow.Storable();
        return MemberBookings(bookingIds).ExecuteUpdate(u => u.SetProperty(b => b.PlayRecomputeDueAt, at));
    }

    /// <summary>
    /// The save, with both durable markers staged beside it — the share reconcile (D11) and the
    /// play recompute (D14): inside the caller's transaction when there is one, else inside one
    /// opened here. Providers without transactions (the in-memory unit suites) save as before.
    /// </summary>
    private async Task<int> SaveStagingAsync(bool acceptAllChangesOnSuccess, CancellationToken ct)
    {
        var relational = Database.IsRelational();
        var owed = relational ? BookingsOwedMayMove() : [];
        var play = relational ? BookingsPlayMayMove() : [];
        if (owed.Count == 0 && play.Count == 0) return await base.SaveChangesAsync(acceptAllChangesOnSuccess, ct);

        if (Database.CurrentTransaction is not null) return await SaveAndStageAsync(owed, play, acceptAllChangesOnSuccess, ct);

        await using var transaction = await Database.BeginTransactionAsync(ct);
        var written = await SaveAndStageAsync(owed, play, acceptAllChangesOnSuccess, ct);
        await transaction.CommitAsync(ct);
        return written;
    }

    private async Task<int> SaveAndStageAsync(List<Guid> owed, List<Guid> play, bool acceptAll, CancellationToken ct)
    {
        var saved = await base.SaveChangesAsync(acceptAll, ct);
        if (owed.Count > 0) await StageShareReconcileAsync(owed, ct);
        if (play.Count > 0) await StagePlayRecomputeAsync(play, ct);
        return saved;
    }

    /// <summary>The synchronous spelling of <see cref="SaveStagingAsync"/>.</summary>
    private int SaveStaging(bool acceptAllChangesOnSuccess)
    {
        var relational = Database.IsRelational();
        var owed = relational ? BookingsOwedMayMove() : [];
        var play = relational ? BookingsPlayMayMove() : [];
        if (owed.Count == 0 && play.Count == 0) return base.SaveChanges(acceptAllChangesOnSuccess);

        if (Database.CurrentTransaction is not null) return SaveAndStage(owed, play, acceptAllChangesOnSuccess);

        using var transaction = Database.BeginTransaction();
        var written = SaveAndStage(owed, play, acceptAllChangesOnSuccess);
        transaction.Commit();
        return written;
    }

    private int SaveAndStage(List<Guid> owed, List<Guid> play, bool acceptAll)
    {
        var saved = base.SaveChanges(acceptAll);
        if (owed.Count > 0) StageShareReconcile(owed);
        if (play.Count > 0) StagePlayRecompute(play);
        return saved;
    }
}
