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

    public AdminBlockService(
        MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settings, ILogger<AdminBlockService> logger)
    { _db = db; _tenant = tenant; _settings = settings; _logger = logger; }

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

        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsOverlapViolation(ex))
        {
            // Lost the race to a booking that committed after our check. The database is
            // the only place a court-time collision is decidable; this is its answer.
            _logger.LogInformation("Admin block lost the slot race on court {CourtId} at {StartsAt}", courtId, startsAt);
            foreach (var entry in _db.ChangeTracker.Entries().Where(e => e.State == EntityState.Added).ToList())
            {
                entry.State = EntityState.Detached;
            }
            return new BookingResult.SlotTaken();
        }

        return new BookingResult.Ok(block, 0m);
    }

    /// <summary>Lifts a block. Only a block — a member's booking is cancelled through <see cref="BookingService.CancelAsync"/>, which settles the money.</summary>
    public async Task<bool> RemoveAsync(Guid blockId, Guid actorId, CancellationToken ct)
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
            }),
        });

        // Cancelled rather than deleted. The exclusion constraint ignores Cancelled rows,
        // so the court frees immediately, and the block stays on the record — an admin who
        // blocked four courts on a Saturday and lifted them an hour later leaves a trail.
        block.Status = BookingStatus.Cancelled;
        block.CancelledAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);
        return true;
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
