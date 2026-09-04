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

    /// <summary>Internal so tests drive one tick directly rather than waiting on the timer.</summary>
    internal async Task TickAsync(CancellationToken ct)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();

        var now = DateTimeOffset.UtcNow;

        // NOTE: this worker no longer cues lights ON.
        //
        // It used to, on a pure clock: any Booked row whose start had passed, with no
        // reference to attendance, payment or balance. So a court lit itself for a member
        // who never arrived, for a booking that was never paid for, and for a no-show whose
        // credits were about to be refunded — every one of them, every fifteen seconds.
        //
        // Lights-on now belongs to CourtActivationService, which fires it when somebody
        // actually identifies themselves at the court AND the charge succeeds. That is
        // what CLAUDE.md means by "the at-court identification event is the source of
        // truth for attendance", and it is why LightsOnCuedAt carries a comment warning it
        // is not an attendance proxy.
        //
        // The OFF sweep stays, and matters more than it did: it is now the backstop that
        // releases a court whose session ended, including one this worker never lit.

        // Bookings that have just ended and we haven't cued off.
        //
        // Widened to include NoShow, so a no-show's lights stop too. Previously the sweep
        // only looked at Booked and Completed, and NoShowWorker sets NoShow — so a booking
        // swept as a no-show before this ran was never cued off at all. The court box's own
        // timer would eventually release it, but the backend would believe the lights were
        // still on and the event stream would never say otherwise.
        var dueOff = await db.Bookings.IgnoreQueryFilters()
            .Where(b => (b.Status == BookingStatus.Booked
                         || b.Status == BookingStatus.Completed
                         || b.Status == BookingStatus.NoShow)
                && b.LightsOffCuedAt == null
                && b.EndsAt <= now)
            .ToListAsync(ct);

        foreach (var b in dueOff)
        {
            await FireLightsAsync(db, tenant, b, on: false, ct);
            b.LightsOffCuedAt = now;

            // Only promote a booking that was actually attended. Flipping an
            // un-checked-in Booked row to Completed here is what raced NoShowWorker, whose
            // predicate is Status == Booked: whichever ran first decided whether the member
            // was a no-show or had simply finished, and the 15-second tick usually won.
            if (b.Status == BookingStatus.Booked && b.CheckedInAt is not null)
            {
                b.Status = BookingStatus.Completed;
            }
        }

        // A reversed no-show was cued off at the sweep, when it was NoShow with a truncated
        // end; the reversal put it back to Booked and checked in, and unless its restored
        // end was still ahead (in which case the marker was cleared and the sweep above
        // handles it) nothing would ever promote it: LightsOffCuedAt is set, so the
        // predicate above never sees it again, and it sat as Booked for ever — never
        // Completed, never anonymised by retention. Attended and over is Completed,
        // whether or not the lights-off was already cued.
        var attendedAndOver = await db.Bookings.IgnoreQueryFilters()
            .Where(b => b.Status == BookingStatus.Booked
                && b.CheckedInAt != null
                && b.LightsOffCuedAt != null
                && b.EndsAt <= now)
            .ToListAsync(ct);
        foreach (var b in attendedAndOver) b.Status = BookingStatus.Completed;

        if (dueOff.Count > 0 || attendedAndOver.Count > 0) await db.SaveChangesAsync(ct);
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
