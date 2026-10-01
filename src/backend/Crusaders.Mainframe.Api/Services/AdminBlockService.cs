using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Blocking a court for an event — a tournament, maintenance, a coaching clinic.
///
/// <para>
/// Deliberately NOT a branch inside <see cref="BookingService"/>. A block takes no money,
/// belongs to no member, refunds nothing and has no penalty window; threading a
/// <c>UserId is null</c> case through the charge path would put four money-free branches
/// through the one method the whole ledger hangs off. It is the same TABLE, because the
/// overlap exclusion constraint is what makes a block actually reserve the court —
/// <c>ck_bookings_no_overlapping_slot</c> covers every row whose status is not Cancelled,
/// so a member's booking and a block cannot both exist over the same court-time, decided
/// by the database rather than by whoever checked first.
/// </para>
/// </summary>
public sealed class AdminBlockService
{
    /// <summary>The label a block carries when the admin gave none. Rendered as-is on the grid.</summary>
    public const string DefaultLabel = "Blocked";

    /// <summary>Same outer wall as a booking: a block is still a court-time range, and an absurd one is still absurd.</summary>
    private const int MaxSlices = 96;

    private const int MaxLabelLength = 128;   // Matches the column, MainframeDbContext.

    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly TenantSettingsAccessor _settings;
    private readonly ILogger<AdminBlockService> _logger;
    private readonly AdminChangeRecorder _changes;

    public AdminBlockService(
        MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settings, ILogger<AdminBlockService> logger,
        AdminChangeRecorder changes)
    { _db = db; _tenant = tenant; _settings = settings; _logger = logger; _changes = changes; }

    public async Task<BookingResult> CreateAsync(
        Guid courtId, DateTimeOffset startsAt, int sliceCount, string? label, Guid actorId, CancellationToken ct)
    {
        if (sliceCount is < 1 or > MaxSlices) return new BookingResult.InvalidDuration(sliceCount, MaxSlices);

        var settings = await _settings.GetAsync(ct);
        var court = await _db.Courts.FirstOrDefaultAsync(c => c.Id == courtId && c.IsActive, ct);
        if (court is null) return new BookingResult.NotFound();

        var endsAt = startsAt.AddMinutes(settings.SliceMinutes * sliceCount);

        // An admin may block outside opening hours — that is when the maintenance happens —
        // and may block a slot that has already started, to close a court mid-session. What
        // an admin may NOT do is block over an existing booking without cancelling it: a
        // member who paid for a court must be refunded deliberately, not overwritten.
        var overlap = await _db.Bookings.AnyAsync(b =>
            b.CourtId == courtId &&
            b.Status != BookingStatus.Cancelled &&
            b.StartsAt < endsAt && b.EndsAt > startsAt, ct);
        if (overlap) return new BookingResult.SlotTaken();

        var block = new Booking
        {
            TenantId = _tenant.TenantId,
            CourtId = courtId,
            UserId = null,
            BookedByUserId = null,
            PaidByUserId = null,
            ActorUserId = actorId,
            StartsAt = startsAt,
            EndsAt = endsAt,
            SliceMinutes = settings.SliceMinutes,
            SliceCount = sliceCount,
            AmountChargedCredits = 0m,
            Status = BookingStatus.AdminBlock,
            BlockLabel = Normalise(label),
        };
        _db.Bookings.Add(block);

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorId,
            SubjectUserId = null,
            Action = "booking.blocked",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                booking_id = block.Id,
                court = court.Name,
                starts_at = block.StartsAt,
                ends_at = block.EndsAt,
                label = block.BlockLabel,
            }),
        });

        // On the club's change record, in the block's own save (review round 4 wave B): a lost
        // race detaches it with the block, so a refused block records nothing.
        await _changes.StageAsync(new AdminChange(
            Action: AdminChangeActions.BookingBlocked,
            ActorUserId: actorId,
            SubjectKind: AdminChangeSubjects.Court,
            SubjectId: court.Id,
            SubjectLabel: court.Name,
            After: BlockFacts(block)), ct);

        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsOverlapViolation(ex))
        {
            // Lost the race to a booking that committed after our check. The database is
            // the only place a court-time collision is decidable; this is its answer.
            _logger.LogInformation("Admin block lost the slot race on court {CourtId} at {StartsAt}", courtId, startsAt);
            DetachAdded();
            return new BookingResult.SlotTaken();
        }

        return new BookingResult.Ok(block, 0m);
    }

    /// <summary>Lifts a block, saying why (A5-1: the reason is required and recorded). Only a block — a member's booking is cancelled through <see cref="BookingService.CancelAsync"/>, which settles the money.</summary>
    public async Task<bool> RemoveAsync(Guid blockId, Guid actorId, string reason, CancellationToken ct)
    {
        var block = await _db.Bookings.FirstOrDefaultAsync(b => b.Id == blockId && b.Status == BookingStatus.AdminBlock, ct);
        if (block is null) return false;

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorId,
            SubjectUserId = null,
            Action = "booking.block_lifted",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                booking_id = block.Id,
                starts_at = block.StartsAt,
                label = block.BlockLabel,
                reason,
            }),
        });

        var court = await _db.Courts.AsNoTracking().FirstOrDefaultAsync(c => c.Id == block.CourtId, ct);
        await _changes.StageAsync(new AdminChange(
            Action: AdminChangeActions.BookingBlockLifted,
            ActorUserId: actorId,
            SubjectKind: AdminChangeSubjects.Court,
            SubjectId: block.CourtId,
            SubjectLabel: court?.Name,
            Reason: reason,
            Before: BlockFacts(block)), ct);

        // Cancelled rather than deleted. The exclusion constraint ignores Cancelled rows,
        // so the court frees immediately, and the block stays on the record — an admin who
        // blocked four courts on a Saturday and lifted them an hour later leaves a trail.
        block.Status = BookingStatus.Cancelled;
        block.CancelledAt = DateTimeOffset.UtcNow;

        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            // Two admins pressed "lift" on the same block.
            //
            // `Booking.Version` is a concurrency token that MainframeDbContext bumps on every
            // modified booking, so the loser's UPDATE matches no rows and throws — and this
            // method had no catch, while BookingService.CancelAsync has had one since the
            // identical race was found there. The lift button is on every admin's grid, so the
            // loser got an unhandled 500 from a route with no exception handler in front of it.
            //
            // False, which is the same answer a lift of a block that is already gone gets: the
            // route turns it into `block_not_found` and the bulk path turns it into a per-item
            // result row. Both are true — by the time this returns the block IS lifted, just
            // not by this request.
            _logger.LogInformation("Lift of block {BlockId} lost a concurrent write", blockId);

            // Neither this request's audit row nor its change row describes anything that
            // happened, and a bulk lift goes on to save again in this same context — detached,
            // so the next item's save cannot carry them in.
            DetachAdded();
            _db.Entry(block).State = EntityState.Detached;
            return false;
        }

        return true;
    }

    private void DetachAdded()
    {
        foreach (var entry in _db.ChangeTracker.Entries().Where(e => e.State == EntityState.Added).ToList())
        {
            entry.State = EntityState.Detached;
        }
    }

    /// <summary>What a block's change row names: when, and the label it showed on the grid.</summary>
    private static Dictionary<string, object?> BlockFacts(Booking block)
    {
        return new Dictionary<string, object?>
        {
            ["starts_at"] = block.StartsAt,
            ["ends_at"] = block.EndsAt,
            ["label"] = block.BlockLabel,
        };
    }

    private static string Normalise(string? label)
    {
        var trimmed = label?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return DefaultLabel;
        return trimmed.Length > MaxLabelLength ? trimmed[..MaxLabelLength] : trimmed;
    }

    private static bool IsOverlapViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == "23P01";
}
