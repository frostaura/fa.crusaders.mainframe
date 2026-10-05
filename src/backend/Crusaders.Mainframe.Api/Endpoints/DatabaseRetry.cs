using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// A save PostgreSQL aborted so that it could be run again — review round 16, FX16.
///
/// <para>
/// A deadlock (40P01) or a serialization failure (40001) is the database choosing a victim, not
/// refusing the data: the aborted transaction changed nothing, and running it again is the documented
/// answer. The walk-up path met one under load — identical retries in flight together, the winner's
/// activation UPDATE and a twin's INSERT of the same slot each waiting on the other inside
/// <c>ck_bookings_no_overlapping_slot</c> — and answered the box 500.
/// </para>
/// </summary>
internal static class DatabaseRetry
{
    /// <summary>Whether <paramref name="ex"/>, or anything it wraps, is PostgreSQL aborting a transaction to be retried.</summary>
    public static bool IsRetryableAbort(Exception ex)
    {
        for (var e = ex; e is not null; e = e.InnerException)
        {
            if (e is PostgresException { SqlState: PostgresErrorCodes.DeadlockDetected or PostgresErrorCodes.SerializationFailure })
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// Puts the context back to what the database holds after a failed save: what it was adding is
    /// forgotten (or the next save would insert it again, against a decision this request never
    /// made), and what it was changing is re-read, so the retry decides from the rows as they are.
    /// </summary>
    public static async Task ForgetFailedSaveAsync(MainframeDbContext db, CancellationToken ct)
    {
        foreach (var entry in db.ChangeTracker.Entries().ToList())
        {
            if (entry.State == EntityState.Added)
            {
                entry.State = EntityState.Detached;
            }
            else if (entry.State is EntityState.Modified or EntityState.Deleted)
            {
                await entry.ReloadAsync(ct);
            }
        }
    }
}
