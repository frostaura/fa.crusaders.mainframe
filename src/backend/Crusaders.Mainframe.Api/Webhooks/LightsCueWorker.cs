using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;

namespace Crusaders.Mainframe.Api.Webhooks;

/// <summary>
/// Periodic worker that emits <c>booking.lights_on</c> at booking start and <c>booking.lights_off</c>
/// at booking end. Uses <c>cued_lights_on_at</c> / <c>cued_lights_off_at</c> markers on the booking
/// row to avoid double-firing.
/// </summary>
public sealed class LightsCueWorker : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly IEventBus _bus;
    private readonly ILogger<LightsCueWorker> _logger;

    public LightsCueWorker(IServiceProvider services, IEventBus bus, ILogger<LightsCueWorker> logger)
    { _services = services; _bus = bus; _logger = logger; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var period = TimeSpan.FromSeconds(15);
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await TickAsync(stoppingToken); }
            catch (Exception ex) { _logger.LogError(ex, "LightsCueWorker tick failed"); }
            await Task.Delay(period, stoppingToken);
        }
    }

    private async Task TickAsync(CancellationToken ct)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();

        var now = DateTimeOffset.UtcNow;

        // Bookings whose start has just passed and we haven't cued yet.
        var dueOn = await db.Bookings.IgnoreQueryFilters()
            .Where(b => b.Status == BookingStatus.Booked
                && b.LightsOnCuedAt == null
                && b.StartsAt <= now && b.EndsAt > now)
            .ToListAsync(ct);

        foreach (var b in dueOn)
        {
            await FireLightsAsync(db, tenant, b, on: true, ct);
            b.LightsOnCuedAt = now;
        }

        // Bookings that have just ended and we haven't cued off.
        var dueOff = await db.Bookings.IgnoreQueryFilters()
            .Where(b => (b.Status == BookingStatus.Booked || b.Status == BookingStatus.Completed)
                && b.LightsOffCuedAt == null
                && b.EndsAt <= now)
            .ToListAsync(ct);

        foreach (var b in dueOff)
        {
            await FireLightsAsync(db, tenant, b, on: false, ct);
            b.LightsOffCuedAt = now;
            if (b.Status == BookingStatus.Booked) b.Status = BookingStatus.Completed;
        }

        if (dueOn.Count + dueOff.Count > 0) await db.SaveChangesAsync(ct);
    }

    private async Task FireLightsAsync(MainframeDbContext db, ITenantContext tenant, Booking b, bool on, CancellationToken ct)
    {
        var court = await db.Courts.IgnoreQueryFilters().FirstAsync(c => c.Id == b.CourtId, ct);
        var tenantRow = await db.Tenants.IgnoreQueryFilters().FirstAsync(t => t.Id == b.TenantId, ct);
        tenant.Set(tenantRow.Id, tenantRow.Slug);

        var data = new Dictionary<string, object?>
        {
            ["booking_id"] = b.Id,
            ["court_id"] = b.CourtId,
            ["court_number"] = court.CourtNumber,
            ["court_name"] = court.Name,
            ["user_id"] = b.UserId,
            ["starts_at"] = b.StartsAt,
            ["ends_at"] = b.EndsAt,
            ["duration_seconds"] = on ? Math.Max(0, (int)(b.EndsAt - DateTimeOffset.UtcNow).TotalSeconds) : 0,
        };
        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: on ? "booking.lights_on" : "booking.lights_off",
            TenantId: b.TenantId, TenantSlug: tenantRow.Slug,
            OccurredAt: DateTimeOffset.UtcNow,
            ActorUserId: null, ActorIsAdmin: false,
            SubjectUserId: b.UserId,
            Data: data), ct);
    }
}
