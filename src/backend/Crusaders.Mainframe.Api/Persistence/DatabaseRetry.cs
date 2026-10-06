using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Npgsql;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// A save PostgreSQL aborted so that it could be run again — review round 16, FX16 and BE16c.
///
/// <para>
/// A deadlock (40P01) or a serialization failure (40001) is the database choosing a victim, not
/// refusing the data: the aborted transaction changed nothing, and running it again is the documented
/// answer. The walk-up path met one under load — identical retries in flight together, the winner's
/// activation UPDATE and a twin's INSERT of the same slot each waiting on the other inside
/// <c>ck_bookings_no_overlapping_slot</c> — and answered the box 500. The same shape is open to any
/// booking INSERT or UPDATE that the exclusion constraint checks while another transaction is updating
/// an overlapping row: an app or desk booking, a block, a pay-for, a check-in, a reversal.
/// </para>
///
/// <para>
/// <b>What is retried is a unit whose effects are all rolled back together</b> — one
/// <c>SaveChanges</c>, or one <see cref="Services.PayerLock"/> transaction — so a retry can never post
/// a charge twice: either the attempt committed (and is not retried) or nothing of it exists.
/// <see cref="RunAsync{T}"/> never retries inside a transaction somebody else opened: the abort has
/// ended that one too, and only its owner can start it again.
/// </para>
/// </summary>
internal static class DatabaseRetry
{
    /// <summary>How many times a unit is tried against a lost race before the abort is let through.</summary>
    public const int Attempts = 3;

    /// <summary>The error code the stable-error handler answers an abort that outlived its retries with (503).</summary>
    public const string ConflictRetry = "conflict_retry";

    /// <summary>The <c>Retry-After</c> seconds on that 503: a lost race clears in milliseconds.</summary>
    public const int RetryAfterSeconds = 1;

    /// <summary>Whether <paramref name="ex"/>, or anything it wraps, is PostgreSQL aborting a transaction to be retried.</summary>
    public static bool IsRetryableAbort(Exception? ex)
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
    /// Whether <paramref name="ex"/>, or anything it wraps, is a race this request lost — a PostgreSQL
    /// abort (<see cref="IsRetryableAbort"/>) or an optimistic-concurrency miss: a booking or a seat
    /// whose <c>Version</c> moved between the read and the write (review round 17, J17-1). Either way
    /// nothing this save wrote exists, and asking again decides from the rows as they now are.
    /// </summary>
    public static bool IsLostRace(Exception? ex)
    {
        for (var e = ex; e is not null; e = e.InnerException)
        {
            if (e is DbUpdateConcurrencyException) return true;
        }
        return IsRetryableAbort(ex);
    }

    /// <summary>
    /// Runs <paramref name="unit"/>, and when one of its saves loses an optimistic-concurrency race
    /// (<see cref="DbUpdateConcurrencyException"/>) runs it again — up to <see cref="Attempts"/>
    /// times — on what the database now holds (review round 17, J17-1).
    ///
    /// <para>
    /// For a unit that DECIDES from a row someone else may decide first: five members scanning one
    /// booking at once each read it unlit, each stamped it, and the four whose UPDATE matched no row
    /// (the booking's <c>Version</c> had moved) answered 500. Run again, the second look sees the
    /// booking lit and takes the repeat-arrival branch — the scanner's own seat, nothing else.
    /// </para>
    ///
    /// <para>
    /// Unlike <see cref="RunAsync{T}"/>, the unit need not commit as one: an earlier save inside it
    /// (a charge under the payer lock) may have committed before the losing one. So the context is
    /// not rewound to a mark. What the losing attempt added is forgotten; what the CALLER staged
    /// before the unit and is still unsaved stays staged; every booking and seat is re-read; and any
    /// other row the attempt changed without saving is re-read. A concurrency miss does not abort a
    /// PostgreSQL transaction (the save rolls back to its savepoint), so this also runs inside one.
    /// </para>
    /// </summary>
    /// <param name="stillMine">
    /// Asked after the re-read: whether the unit should decide again at all. False lets the race through
    /// (503 at the net) — for a caller that settles a row which became something else (an upload whose
    /// booking the no-show sweep settled meanwhile is REVERSED by its caller, not refused here).
    /// </param>
    public static async Task<T> ReDecideOnLostRaceAsync<T>(
        MainframeDbContext db, Func<Task<T>> unit, CancellationToken ct, Func<bool>? stillMine = null)
    {
        var before = new Dictionary<object, EntityState>(ReferenceEqualityComparer.Instance);
        foreach (var entry in db.ChangeTracker.Entries()) before[entry.Entity] = entry.State;

        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await unit();
            }
            catch (DbUpdateConcurrencyException) when (attempt < Attempts)
            {
                await ForgetLostAttemptAsync(db, before, ct);
                if (stillMine is not null && !stillMine()) throw;
            }
        }
    }

    /// <summary>The context after a lost optimistic race, as <see cref="ReDecideOnLostRaceAsync{T}"/> describes.</summary>
    private static async Task ForgetLostAttemptAsync(MainframeDbContext db, Dictionary<object, EntityState> before, CancellationToken ct)
    {
        foreach (var entry in db.ChangeTracker.Entries().ToList())
        {
            var had = before.TryGetValue(entry.Entity, out var was);
            if (entry.State == EntityState.Added)
            {
                // Added by the losing attempt: never saved, and a decision this request no longer makes.
                if (!had || was != EntityState.Added) entry.State = EntityState.Detached;
                continue;
            }
            if (entry.State == EntityState.Detached) continue;

            var raced = entry.Entity is Booking or BookingParticipant;
            var changedHere = (entry.State is EntityState.Modified or EntityState.Deleted) && (!had || was == EntityState.Unchanged);
            if (raced || changedHere) await entry.ReloadAsync(ct);
        }
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

    /// <summary>One <c>SaveChanges</c>, run again when PostgreSQL aborts it (see <see cref="RunAsync{T}"/>).</summary>
    public static Task<int> SaveAsync(MainframeDbContext db, CancellationToken ct) =>
        RunAsync(db, () => db.SaveChangesAsync(ct), ct);

    /// <summary>
    /// Runs <paramref name="unit"/>, and runs it again — up to <see cref="Attempts"/> times — when
    /// PostgreSQL aborts it with a deadlock or a serialization failure.
    ///
    /// <para>
    /// Between attempts the change tracker is put back exactly as it stood when the unit began
    /// (<see cref="TrackerMark"/>): what the caller had staged is staged again — a booking row still
    /// to be inserted, a pay-for nonce row marked paid — and whatever the attempt added or loaded is
    /// forgotten. That is right only because the unit's writes were rolled back with it, which is
    /// why a caller's open transaction disables the retry: the unit is then run once, as before.
    /// </para>
    /// </summary>
    public static async Task<T> RunAsync<T>(MainframeDbContext db, Func<Task<T>> unit, CancellationToken ct)
    {
        if (!db.Database.IsNpgsql() || db.Database.CurrentTransaction is not null) return await unit();

        var mark = TrackerMark.Take(db);
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await unit();
            }
            catch (Exception ex) when (attempt < Attempts && IsRetryableAbort(ex))
            {
                mark.Restore(db);
                // A few milliseconds, growing: the winner of the race needs only to commit.
                await Task.Delay(TimeSpan.FromMilliseconds(Random.Shared.Next(5, 20) * attempt), ct);
            }
        }
    }

    /// <summary>
    /// The change tracker as it stood at one instant: every entry, its state, its current and
    /// original values and which properties were modified. <see cref="Restore"/> puts it back.
    /// </summary>
    private sealed class TrackerMark
    {
        private readonly List<Kept> _kept;

        private TrackerMark(List<Kept> kept) => _kept = kept;

        public static TrackerMark Take(MainframeDbContext db)
        {
            var kept = new List<Kept>();
            foreach (var entry in db.ChangeTracker.Entries())
            {
                var modified = entry.Properties.Where(p => p.IsModified).Select(p => p.Metadata.Name).ToHashSet(StringComparer.Ordinal);
                kept.Add(new Kept(entry, entry.State, entry.CurrentValues.Clone(), entry.OriginalValues.Clone(), modified));
            }
            return new TrackerMark(kept);
        }

        public void Restore(MainframeDbContext db)
        {
            var keep = _kept.Select(k => k.Entry.Entity).ToHashSet(ReferenceEqualityComparer.Instance);
            foreach (var entry in db.ChangeTracker.Entries().ToList())
            {
                if (!keep.Contains(entry.Entity)) entry.State = EntityState.Detached;
            }
            foreach (var k in _kept) k.Restore();
        }
    }

    /// <summary>One entry of a <see cref="TrackerMark"/>.</summary>
    private sealed class Kept(EntityEntry entry, EntityState state, PropertyValues current, PropertyValues original, HashSet<string> modified)
    {
        public EntityEntry Entry { get; } = entry;
        private EntityState State { get; } = state;
        private PropertyValues Current { get; } = current;
        private PropertyValues Original { get; } = original;
        private HashSet<string> Modified { get; } = modified;

        public void Restore()
        {
            if (State == EntityState.Added)
            {
                // Never saved, as far as the database knows: inserted again on the next attempt.
                Entry.State = EntityState.Added;
                Entry.CurrentValues.SetValues(Current);
                return;
            }

            Entry.State = EntityState.Unchanged;
            Entry.OriginalValues.SetValues(Original);
            Entry.CurrentValues.SetValues(Current);
            foreach (var property in Entry.Properties)
            {
                property.IsModified = Modified.Contains(property.Metadata.Name);
            }
            if (State is EntityState.Deleted or EntityState.Unchanged) Entry.State = State;
        }
    }
}
