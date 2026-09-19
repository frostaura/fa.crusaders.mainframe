using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;

namespace Crusaders.Mainframe.Api.Webhooks;

/// <summary>
/// Notices a court box that has stopped heart-beating, and notices when it comes back.
/// Emits <c>peripheral.unhealthy</c> once per outage and <c>peripheral.recovered</c> once when
/// it ends, and mails every admin of the affected club — <c>feature-spec.md</c> §6a's
/// "admin gets a high-priority alert" and §9's peripheral events.
///
/// <para>
/// <b>Nothing here is invented.</b> The liveness signal already existed and the product already
/// used it: the box PUSHES <c>POST /api/v1/device/heartbeat</c>, which writes
/// <see cref="Device.LastSeenAt"/>; <see cref="HeartbeatCadence.OfflineAfterSeconds"/> already
/// computed how much silence is too much; the wire already carried it as
/// <c>offline_after_seconds</c>; and the Devices page already rendered "offline" from it. What
/// was missing was only a sweep — which is why §9 saying the event needed "a real peripheral
/// driver, or a device-side liveness signal, first" was false, and is corrected.
/// </para>
///
/// <para>
/// <b>Push, not poll, and that is the stronger signal.</b> The old
/// <c>lights-controller.md</c> design polled a <c>/health</c> endpoint on the board; the shipped
/// box has no inbound listener at all, which is what made that design Superseded. A box that
/// calls in on its own schedule tells you about its uplink, its power and its firmware loop in
/// one signal, and needs no route into the cupboard.
/// </para>
/// </summary>
public sealed class PeripheralHealthWorker : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly IEventBus _bus;
    private readonly ILogger<PeripheralHealthWorker> _logger;

    public PeripheralHealthWorker(IServiceProvider services, IEventBus bus, ILogger<PeripheralHealthWorker> logger)
    { _services = services; _bus = bus; _logger = logger; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await TickAsync(stoppingToken); }
            catch (Exception ex) { _logger.LogError(ex, "PeripheralHealthWorker tick failed"); }
            await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
        }
    }

    /// <summary>Everything one device's verdict needs, bundled — the six-parameter gate, as in the no-show sweep.</summary>
    private sealed record Health(
        MainframeDbContext Db,
        IEmailService Email,
        Tenant Tenant,
        int OfflineAfterSeconds,
        DateTimeOffset Now)
    {
        /// <summary>Console link for the alert, resolved once per tick rather than per device.</summary>
        public string ConsoleUrl { get; init; } = "/admin/devices";
    }

    /// <summary>Internal so tests drive one tick directly rather than waiting on the timer.</summary>
    internal async Task TickAsync(CancellationToken ct)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        var settings = scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>();
        var email = scope.ServiceProvider.GetRequiredService<IEmailService>();
        var config = scope.ServiceProvider.GetRequiredService<IConfiguration>();

        var now = DateTimeOffset.UtcNow;
        var baseUrl = config["App:PublicBaseUrl"] ?? "http://localhost:8088";

        var tenants = await db.Tenants.IgnoreQueryFilters().ToListAsync(ct);
        foreach (var tenant in tenants)
        {
            tenantContext.Set(tenant.Id, tenant.Slug);
            var s = await settings.GetAsync(ct);
            var health = new Health(db, email, tenant, HeartbeatCadence.OfflineAfterSeconds(s.HeartbeatSeconds), now)
            {
                ConsoleUrl = $"{baseUrl}/admin/devices",
            };

            // Disabled boxes are excluded deliberately. An admin who switches a box off has
            // said it is not expected to call in; alerting them every thirty seconds about a
            // silence they created is how a club learns to ignore the alert that matters.
            var devices = await db.Devices.Where(d => d.Enabled).ToListAsync(ct);
            var open = await db.DeviceOutages.Where(o => o.EndedAt == null).ToListAsync(ct);

            foreach (var device in devices)
            {
                await JudgeAsync(health, device, open.FirstOrDefault(o => o.DeviceId == device.Id), ct);
            }
        }
    }

    /// <summary>
    /// One box, one verdict: open an outage, close one, or leave things as they are.
    /// </summary>
    private async Task JudgeAsync(Health health, Device device, DeviceOutage? outage, CancellationToken ct)
    {
        // A box that has never called in has no outage to report. It is not silent, it is
        // unborn: every row is created BY a heartbeat, so LastSeenAt is null only in the
        // instant between auto-registration and its first save, and in seeded fixtures.
        if (device.LastSeenAt is not { } lastSeen)
        {
            return;
        }

        var silentFor = health.Now - lastSeen;
        var unreachable = silentFor.TotalSeconds > health.OfflineAfterSeconds;

        if (unreachable && outage is null)
        {
            await OpenAsync(health, device, lastSeen, ct);
        }
        else if (!unreachable && outage is not null)
        {
            await CloseAsync(health, device, outage, lastSeen, ct);
        }
    }

    /// <summary>
    /// Declares the outage: one row, one alert to every admin, one webhook.
    ///
    /// <para>
    /// The row is saved BEFORE anything is announced, for the same reason the lights-off cue
    /// claims its marker before it emits: the row is the once-per-outage guard, so a process
    /// that dies between the two loses one alert, whereas announcing first and saving second
    /// re-alerts the whole club every thirty seconds for as long as the box stays dark.
    /// </para>
    /// </summary>
    private async Task OpenAsync(Health health, Device device, DateTimeOffset lastSeen, CancellationToken ct)
    {
        var outage = new DeviceOutage
        {
            TenantId = health.Tenant.Id,
            DeviceId = device.Id,
            StartedAt = lastSeen,
            DetectedAt = health.Now,
        };
        health.Db.DeviceOutages.Add(outage);

        try
        {
            await health.Db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // The filtered unique index refused a second open outage for this box — another
            // tick got there first. Nothing to announce and nothing wrong.
            health.Db.Entry(outage).State = EntityState.Detached;
            _logger.LogInformation("Peripheral outage for {DeviceCode} was already open", device.DeviceCode);
            return;
        }

        var minutes = (int)Math.Round((health.Now - lastSeen).TotalMinutes, MidpointRounding.AwayFromZero);

        if (device.Kind == DeviceKind.Gate)
        {
            _logger.LogWarning(
                "Door gate {DeviceCode} ({GateKey}) unreachable — last heartbeat {LastSeen}, threshold {Threshold}s",
                device.DeviceCode, device.GateKey, lastSeen, health.OfflineAfterSeconds);

            await AlertAdminsAsync(health, m => EmailTemplates.AdminGateUnhealthy(m, GateAlertFor(health, device, minutes)), ct);
        }
        else
        {
            _logger.LogWarning(
                "Court box {DeviceCode} unreachable — last heartbeat {LastSeen}, threshold {Threshold}s",
                device.DeviceCode, lastSeen, health.OfflineAfterSeconds);

            var alert = new PeripheralAlert(
                device.Name, device.DeviceCode, device.CourtNumbers, minutes,
                health.Tenant.DisplayName, health.ConsoleUrl);
            await AlertAdminsAsync(health, m => EmailTemplates.AdminPeripheralUnhealthy(m, alert), ct);
        }

        await EmitAsync(health, device, "peripheral.unhealthy", new()
        {
            ["unreachable_since"] = lastSeen,
            ["silent_minutes"] = minutes,
            ["offline_after_seconds"] = health.OfflineAfterSeconds,
        }, ct);
    }

    /// <summary>The box called in again: close the row, tell the club it is back.</summary>
    private async Task CloseAsync(Health health, Device device, DeviceOutage outage, DateTimeOffset lastSeen, CancellationToken ct)
    {
        outage.EndedAt = lastSeen;
        await health.Db.SaveChangesAsync(ct);

        var minutes = (int)Math.Round((outage.EndedAt.Value - outage.StartedAt).TotalMinutes, MidpointRounding.AwayFromZero);

        if (device.Kind == DeviceKind.Gate)
        {
            _logger.LogInformation("Door gate {DeviceCode} is back after {Minutes} minutes", device.DeviceCode, minutes);
            await AlertAdminsAsync(health, m => EmailTemplates.AdminGateRecovered(m, GateAlertFor(health, device, minutes)), ct);
        }
        else
        {
            _logger.LogInformation("Court box {DeviceCode} is back after {Minutes} minutes", device.DeviceCode, minutes);

            var alert = new PeripheralAlert(
                device.Name, device.DeviceCode, device.CourtNumbers, minutes,
                health.Tenant.DisplayName, health.ConsoleUrl);
            await AlertAdminsAsync(health, m => EmailTemplates.AdminPeripheralRecovered(m, alert), ct);
        }

        await EmitAsync(health, device, "peripheral.recovered", new()
        {
            ["unreachable_since"] = outage.StartedAt,
            ["recovered_at"] = outage.EndedAt,
            ["outage_minutes"] = minutes,
        }, ct);
    }

    /// <summary>
    /// The alert for a door, which names the door rather than a court list.
    ///
    /// <para>
    /// The kind branch above it is the whole fix: this sweep took every enabled row with no
    /// filter on its kind, so a silent gate mailed the club "Court box not reporting", warned
    /// about members on "those courts" and promised refunds with no no-show penalty. A gate
    /// drives no courts, stamps no attendance and is invisible to <c>DeviceOutageIndex</c>, so
    /// none of that happens — the admin goes looking for a box that is working fine while the
    /// door stays shut.
    /// </para>
    ///
    /// <para>
    /// The outage ROW and the <c>peripheral.*</c> events are deliberately unchanged and shared:
    /// a door going dark is a real incident, it is once per outage like any other, and the
    /// Devices page reads the same rows. What differs is only what an admin is told to do
    /// about it.
    /// </para>
    /// </summary>
    private static GateAlert GateAlertFor(Health health, Device device, int minutes)
    {
        return new GateAlert(
            device.Name, device.DeviceCode, device.GateKey, minutes,
            health.Tenant.DisplayName, health.ConsoleUrl);
    }

    /// <summary>
    /// The club's own admins, and only them. Mail failures are logged, never thrown: an
    /// unreachable SMTP host must not stop the sweep for every other club on the deployment.
    /// </summary>
    private async Task AlertAdminsAsync(Health health, Func<string, EmailMessage> compose, CancellationToken ct)
    {
        var admins = await health.Db.Users.AsNoTracking()
            .Where(u => u.IsAdmin)
            .Select(u => u.Email)
            .ToListAsync(ct);

        foreach (var to in admins)
        {
            try { await health.Email.SendAsync(compose(to), ct); }
            catch (Exception ex) { _logger.LogWarning(ex, "Peripheral alert to {To} failed", to); }
        }
    }

    /// <summary>One shape for both peripheral events, so a template written against one works against the other.</summary>
    private async Task EmitAsync(Health health, Device device, string type, Dictionary<string, object?> data, CancellationToken ct)
    {
        data["device_id"] = device.Id;
        data["device_code"] = device.DeviceCode;
        data["device_name"] = device.Name;
        data["mac_address"] = device.MacAddress;
        data["court_numbers"] = device.CourtNumbers;
        data["last_seen_at"] = device.LastSeenAt;

        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: type,
            TenantId: health.Tenant.Id, TenantSlug: health.Tenant.Slug,
            OccurredAt: health.Now, ActorUserId: null, ActorIsAdmin: false, SubjectUserId: null,
            Data: data), ct);
    }
}
