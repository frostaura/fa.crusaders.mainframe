using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// One club's play pass (<c>docs/specs/play.md</c> §7.3), driven once a minute by <c>PlayWorker</c>:
/// the auto-confirm catch-up, the recompute-marker drain, and the retro-award catch-up. Each step is
/// its own method so the worker catches and logs each on its own.
/// </summary>
public sealed class PlaySweep
{
    public const int AutoConfirmBatch = 200;
    public const int DrainBatch = 500;
    public const int CatchUpBatch = 200;

    /// <summary>How far a failed booking's marker is pushed: a poisoned booking costs a log line every five minutes, not every minute.</summary>
    public static readonly TimeSpan FailureBackoff = TimeSpan.FromMinutes(5);

    private readonly MainframeDbContext _db;
    private readonly ResultService _results;
    private readonly PlayEvaluator _evaluator;
    private readonly ILogger<PlaySweep> _logger;

    public PlaySweep(MainframeDbContext db, ResultService results, PlayEvaluator evaluator, ILogger<PlaySweep> logger)
    {
        _db = db; _results = results; _evaluator = evaluator; _logger = logger;
    }

    /// <summary>
    /// Confirms pending results whose deadline has passed, each in its own save with its notices. A
    /// concurrency loss is skipped: the other writer decided. The confirmation's own save stages
    /// the booking's marker, so the drain evaluates its lineup.
    /// </summary>
    public async Task<int> AutoConfirmAsync(DateTimeOffset now, CancellationToken ct)
    {
        var due = await _db.MatchResults.AsNoTracking()
            .Where(r => r.Status == MatchResultStatus.Pending && r.ConfirmDueAt <= now)
            .OrderBy(r => r.ConfirmDueAt).Select(r => r.Id).Take(AutoConfirmBatch).ToListAsync(ct);

        var confirmed = 0;
        foreach (var id in due)
        {
            _db.ChangeTracker.Clear();
            var r = await _db.MatchResults.Include(x => x.Players).FirstOrDefaultAsync(x => x.Id == id, ct);
            if (r is null) continue;
            var (_, changed) = await _results.SettleDueAsync(r, now, ct);
            if (changed) confirmed++;
        }
        _db.ChangeTracker.Clear();
        return confirmed;
    }

    /// <summary>
    /// Drains the recompute markers due at <paramref name="now"/>: every member who is or was a player
    /// of the booking, has a seat on it or is in a result's lineup on it is evaluated; the marker is
    /// cleared only if it is not newer than this pass's start (a change during the pass survives);
    /// a failure pushes it <see cref="FailureBackoff"/> ahead and logs once.
    /// </summary>
    public async Task<int> DrainAsync(DateTimeOffset now, CancellationToken ct)
    {
        var passStart = now.Storable();
        var due = await _db.Bookings.AsNoTracking()
            .Where(b => b.PlayRecomputeDueAt != null && b.PlayRecomputeDueAt <= now)
            .OrderBy(b => b.PlayRecomputeDueAt).Select(b => b.Id).Take(DrainBatch).ToListAsync(ct);

        var drained = 0;
        foreach (var bookingId in due)
        {
            try
            {
                foreach (var userId in await AttendanceQuery.AffectedMembersAsync(_db, bookingId, ct))
                {
                    _db.ChangeTracker.Clear();
                    await _evaluator.EvaluateAsync(userId, now, ct);
                }
                // R16 E16-9: a session still on court is evaluated again when it ends — that is when its
                // badges are earned (never at the start: the club may yet cancel it, and badges stay).
                await _db.Bookings.Where(b => b.Id == bookingId && b.PlayRecomputeDueAt <= passStart)
                    .ExecuteUpdateAsync(u => u.SetProperty(b => b.PlayRecomputeDueAt,
                        b => b.CheckedInAt != null && b.CancelledAt == null && b.EndsAt > passStart ? b.EndsAt : (DateTimeOffset?)null), ct);
                drained++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _db.ChangeTracker.Clear();
                _logger.LogError(ex, "Play recompute failed for booking {Booking}; retrying in {Minutes} minutes", bookingId, FailureBackoff.TotalMinutes);
                var retry = now.Add(FailureBackoff).Storable();
                await _db.Bookings.Where(b => b.Id == bookingId)
                    .ExecuteUpdateAsync(u => u.SetProperty(b => b.PlayRecomputeDueAt, retry), ct);
            }
        }
        return drained;
    }

    /// <summary>
    /// The retro-award: members with any attendance whose profile is missing or older than the
    /// catalogue, <see cref="CatchUpBatch"/> a pass, until none remain. Silent for old history by
    /// the evaluator's fresh window.
    /// </summary>
    public async Task<int> CatchUpAsync(DateTimeOffset now, CancellationToken ct)
    {
        var stale = await _db.Users.AsNoTracking()
            .Where(u => !_db.MemberPlayProfiles.Any(p => p.UserId == u.Id && p.EvaluatorVersion >= BadgeCatalogue.Version))
            .Where(u => _db.Bookings.Any(b => b.UserId == u.Id && b.CheckedInAt != null)
                        || _db.BookingParticipants.Any(p => p.UserId == u.Id
                            && (p.CheckedInAt != null
                                || (p.Status == ParticipantStatus.Accepted && _db.Bookings.Any(b => b.Id == p.BookingId && b.CheckedInAt != null)))))
            .OrderBy(u => u.Id).Select(u => u.Id).Take(CatchUpBatch).ToListAsync(ct);

        var done = 0;
        foreach (var userId in stale)
        {
            _db.ChangeTracker.Clear();
            try
            {
                await _evaluator.EvaluateAsync(userId, now, ct);
                done++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // One member's failure must not hold up everybody behind them.
                _db.ChangeTracker.Clear();
                _logger.LogError(ex, "Play catch-up failed for member {User}", userId);
            }
        }
        return done;
    }
}
