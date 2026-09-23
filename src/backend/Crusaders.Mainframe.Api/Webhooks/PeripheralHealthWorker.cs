using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;

namespace Crusaders.Mainframe.Api.Webhooks;

/// <summary>
/// Notices a court box that has stopped heart-beating, and notices when it comes back.
/// Emits <c>peripheral.unhealthy</c> once per outage and <c>peripheral.recovered</c> once when
/// it ends, and tells every admin of the affected club — <c>feature-spec.md</c> §6a's
/// "admin gets a high-priority alert" and §9's peripheral events. The alert is an admin notice
/// (<c>device.offline</c> / <c>device.recovered</c>) staged in the same save as the outage row,
/// and mailed by the outbox (R23).
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
        Tenant Tenant,
        int OfflineAfterSeconds,
        DateTimeOffset Now)
    {
        /// <summary>
        /// The light-state projection a newly-opened outage sets to <c>unknown</c>.
        ///
        /// <para>
        /// Init-only rather than positional because this record is at the six-parameter gate,
        /// and — unlike the device route's services — there is exactly ONE construction site,
        /// in this file, a dozen lines above the only reader. A missing value here cannot hide.
        /// </para>
        /// </summary>
        public CourtLightStateService Lights { get; init; } = null!;

        /// <summary>The club's <c>device_alert_cooldown_minutes</c>. See <see cref="AnnouncedAsync"/>.</summary>
        public TimeSpan Cooldown { get; init; } = TimeSpan.FromMinutes(TenantSettingsView.DefaultDeviceAlertCooldownMinutes);
    }

    /// <summary>Internal so tests drive one tick directly rather than waiting on the timer.</summary>
    internal Task TickAsync(CancellationToken ct) => TickAsync(DateTimeOffset.UtcNow, ct);

    /// <summary>
    /// The same sweep at a stated instant. Every judgement here is a comparison against this
    /// one value, so threading it changes nothing the worker does and is the only way a test
    /// can drive the REAL worker across the hours a flapping board takes to misbehave.
    /// </summary>
    internal async Task TickAsync(DateTimeOffset now, CancellationToken ct)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        var settings = scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>();
        var lights = scope.ServiceProvider.GetRequiredService<CourtLightStateService>();

        var tenants = await db.Tenants.IgnoreQueryFilters().ToListAsync(ct);
        foreach (var tenant in tenants)
        {
            tenantContext.Set(tenant.Id, tenant.Slug);
            var s = await settings.GetAsync(ct);
            var health = new Health(db, tenant, HeartbeatCadence.OfflineAfterSeconds(s.HeartbeatSeconds), now)
            {
                Lights = lights,
                Cooldown = TimeSpan.FromMinutes(Math.Clamp(
                    s.DeviceAlertCooldownMinutes,
                    TenantSettingsView.MinDeviceAlertCooldownMinutes,
                    TenantSettingsView.MaxDeviceAlertCooldownMinutes)),
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
            if (await ResumedAsync(health, device, lastSeen, ct)) return;
            await OpenAsync(health, device, lastSeen, ct);
        }
        else if (!unreachable && outage is not null)
        {
            await CloseAsync(health, device, outage, lastSeen, ct);
        }
    }

    /// <summary>
    /// Re-opens the row for a silence that never actually ended, and answers whether it did.
    ///
    /// <para>
    /// <b>This is the other half of R3-2, and without it the fix for the first half makes four
    /// rows into four rows.</b> Taking a board out of service closes its open outage, for the
    /// reason <c>DeviceRegistryService.SwitchAsync</c> gives; put it back into service while it
    /// is still dark and this sweep sees an unreachable board with no open row and opens a new
    /// one — <c>StartedAt</c> at the same unmoved <see cref="Device.LastSeenAt"/> as the last.
    /// A club that shut and reopened a dead door three times while waiting for an electrician
    /// got four overlapping outages describing one continuous silence, three of them stamped
    /// with an <c>EndedAt</c> nobody was present for.
    /// </para>
    ///
    /// <para>
    /// The test is exact rather than approximate: the row must start at the same instant this
    /// silence starts, and must have been closed by something other than contact. Both together
    /// mean "this is the same silence, and it never ended" — a row closed by a real heartbeat
    /// describes a DIFFERENT, finished silence and is never touched.
    /// </para>
    ///
    /// <para>
    /// Nothing is announced. The club was told about this outage when it was opened, or was
    /// deliberately not told; a resume is the correction of a bookkeeping error, not a new
    /// incident, and <see cref="AnnouncedAsync"/> replays the same rows to the same answer
    /// afterwards because the row's <c>DetectedAt</c> is untouched.
    /// </para>
    /// </summary>
    private async Task<bool> ResumedAsync(
        Health health, Device device, DateTimeOffset lastSeen, CancellationToken ct)
    {
        var resumable = await health.Db.DeviceOutages
            .Where(o => o.DeviceId == device.Id && o.StartedAt == lastSeen && !o.EndedByContact)
            .OrderByDescending(o => o.DetectedAt)
            .FirstOrDefaultAsync(ct);
        if (resumable is null) return false;

        resumable.EndedAt = null;

        // Back to the default reading: whatever closes it NEXT will be a heartbeat unless
        // another switch says otherwise, and the row is once again the open-outage guard.
        resumable.EndedByContact = true;
        await health.Db.SaveChangesAsync(ct);

        _logger.LogInformation(
            "Outage for {DeviceCode} resumed — the board has not been heard from since {LastSeen}",
            device.DeviceCode, lastSeen);
        return true;
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
    /// <summary>
    /// Sets every court this board drives to <c>unknown</c>, and records the outage on the
    /// club's monitoring page.
    ///
    /// <para>
    /// A gate drives no courts, so this is a court box's step only. The scope is resolved from
    /// the sweep's own <c>DbContext</c>, which is already tenant-set for this tick.
    /// </para>
    /// </summary>
    private async Task DarkenAsync(Health health, Device device, CancellationToken ct)
    {
        // On its own scope, like every other write to this table: the sweep's context is
        // mid-tenant-loop and shared across every board in the club, and a monitoring write
        // that threw here would take the whole club's outage detection down with it.
        DeviceErrorService.InBackground(
            _services.GetRequiredService<IServiceScopeFactory>(), _logger,
            health.Tenant.Id, health.Tenant.Slug,
            new DeviceErrorReport(
                DeviceErrorCodes.OutageOpened, DeviceErrorSource.Server,
                DeviceId: device.Id, ClaimedDeviceCode: device.DeviceCode,
                Detail: $"no contact since {device.LastSeenAt:O}", At: health.Now));

        if (device.Kind != DeviceKind.CourtBox || device.CourtNumbers.Count == 0) return;

        var numbers = device.CourtNumbers;
        var courts = await health.Db.Courts
            .Where(c => numbers.Contains(c.CourtNumber))
            .Select(c => c.Id)
            .ToListAsync(ct);

        foreach (var courtId in courts)
        {
            await health.Lights.RecordUnknownAsync(courtId, device.Id, health.Now, ct);
        }

        await health.Db.SaveChangesAsync(ct);
    }

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

        // The admins' alert is staged BESIDE the row rather than sent after it (R23), so the one
        // save commits both: the row is still the once-per-outage guard, and a process that dies
        // after it can no longer lose the alert — the outbox delivers it on the next pass. The
        // announcement is decided before the save, from the rows already there plus this one,
        // which is the same replay AnnouncedAsync always ran.
        var minutes = (int)Math.Round((health.Now - lastSeen).TotalMinutes, MidpointRounding.AwayFromZero);
        var announce = Mailable(device) && await AnnouncedAsync(health, device, outage, ct);
        var notice = announce
            ? AdminNotices.Stage(health.Db, health.Tenant.Id,
                AdminNotices.DeviceOutage(outage.Id, device, minutes, recovered: false), health.Now)
            : null;

        try
        {
            await health.Db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // The filtered unique index refused a second open outage for this box — another
            // tick got there first. Nothing to announce and nothing wrong; the notice goes with
            // the row it belonged to.
            health.Db.Entry(outage).State = EntityState.Detached;
            if (notice is not null) health.Db.Entry(notice).State = EntityState.Detached;
            _logger.LogInformation("Peripheral outage for {DeviceCode} was already open", device.DeviceCode);
            return;
        }

        // THE SERVER CAN NO LONGER MAKE A CLAIM ABOUT THIS BOARD'S COURTS.
        //
        // Every belief in court_light_state about them was assembled from events THIS BOARD
        // sent, and a board that has stopped talking may have been cut by the same power event
        // that silenced it — or may be happily running a relay the server will never hear about
        // again. Writing "off" would be the server claiming to have seen something switched off
        // that it did not, which is how a club leaves a court lit all night believing the
        // software knows. Unknown is the honest third state, and it is the whole reason the
        // projection has one.
        await DarkenAsync(health, device, ct);

        if (device.Kind == DeviceKind.Gate)
        {
            _logger.LogWarning(
                "Door gate {DeviceCode} ({GateKey}) unreachable — last heartbeat {LastSeen}, threshold {Threshold}s, mailed {Mailed}",
                device.DeviceCode, device.GateKey, lastSeen, health.OfflineAfterSeconds, announce);
        }
        else
        {
            _logger.LogWarning(
                "Court box {DeviceCode} unreachable — last heartbeat {LastSeen}, threshold {Threshold}s, mailed {Mailed}",
                device.DeviceCode, lastSeen, health.OfflineAfterSeconds, announce);
        }

        await EmitAsync(health, device, "peripheral.unhealthy", new()
        {
            ["unreachable_since"] = lastSeen,
            ["silent_minutes"] = minutes,
            ["offline_after_seconds"] = health.OfflineAfterSeconds,
        }, ct);
    }

    /// <summary>
    /// The box called in again: close the row, tell the club it is back — the all-clear staged in
    /// the same save as the close, for the reason <see cref="OpenAsync"/> gives.
    /// </summary>
    private async Task CloseAsync(Health health, Device device, DeviceOutage outage, DateTimeOffset lastSeen, CancellationToken ct)
    {
        outage.EndedAt = lastSeen;
        var minutes = (int)Math.Round((lastSeen - outage.StartedAt).TotalMinutes, MidpointRounding.AwayFromZero);

        // An all-clear for an alarm nobody was given is noise about an event the club never
        // heard of. Same predicate, same rows, so the two decisions cannot disagree.
        var announce = Mailable(device) && await AnnouncedAsync(health, device, outage, ct);
        if (announce)
        {
            AdminNotices.Stage(health.Db, health.Tenant.Id,
                AdminNotices.DeviceOutage(outage.Id, device, minutes, recovered: true), health.Now);
        }
        await health.Db.SaveChangesAsync(ct);

        if (device.Kind == DeviceKind.Gate)
        {
            _logger.LogInformation(
                "Door gate {DeviceCode} is back after {Minutes} minutes, mailed {Mailed}", device.DeviceCode, minutes, announce);
        }
        else
        {
            _logger.LogInformation(
                "Court box {DeviceCode} is back after {Minutes} minutes, mailed {Mailed}", device.DeviceCode, minutes, announce);
        }

        await EmitAsync(health, device, "peripheral.recovered", new()
        {
            ["unreachable_since"] = outage.StartedAt,
            ["recovered_at"] = outage.EndedAt,
            ["outage_minutes"] = minutes,
        }, ct);
    }

    /// <summary>
    /// Whether this board is one the club has asked to hear about at all.
    ///
    /// <para>
    /// <b>A board no admin has acknowledged is not mailed about, whatever kind it is.</b>
    /// Auto-registration is the whole provisioning story and it is unbounded: anything holding
    /// the club's device key can heartbeat with a MAC it invented and a row appears. Each of
    /// those boards could then mail every admin of the club on every transition — a mail flood
    /// available on demand to anyone who had the key, which is the same capability D3 took the
    /// roster away for and for the same reason.
    /// </para>
    ///
    /// <para>
    /// <b>This used to exempt an unnamed GATE only, and the flood was never a door problem.</b>
    /// A gate is the one kind of board that has to be named before it does anything; a
    /// <c>kind</c>-less heartbeat auto-registers a COURT BOX with no naming step at all, and a
    /// court box was mailable the instant it existed. So the default path was still wide open:
    /// twelve invented MACs is twelve mails to every admin in one thirty-second tick, and the
    /// ceiling is the tenant rate limit rather than anything here. The acknowledgement itself
    /// is the right test — <see cref="Device.AutoRegistered"/> means exactly "nobody has looked
    /// at this row", it is already on every kind, and the first admin edit clears it.
    /// </para>
    ///
    /// <para>
    /// The gate's naming rule survives as the narrower of the two, because it is about a
    /// different thing: <c>gate_key</c> is what makes the message identify a door at all, and
    /// D3 keys the offline roster on it. An acknowledged but unnamed gate is therefore still
    /// silent.
    /// </para>
    ///
    /// <para>
    /// The outage ROW and the <c>peripheral.*</c> events are written either way. The Devices
    /// page reads those rows, and a board an admin is looking at should show its history
    /// whether or not anybody was mailed about it — what is withheld is the interruption, not
    /// the record. That is also what keeps this from hiding a real outage: the board a club
    /// genuinely installed is acknowledged the first time anybody edits it, and until then it
    /// is visible on the page they would be sent to anyway.
    /// </para>
    /// </summary>
    private static bool Mailable(Device device) =>
        !device.AutoRegistered
        && (device.Kind != DeviceKind.Gate || !string.IsNullOrWhiteSpace(device.GateKey));

    /// <summary>
    /// Whether this outage is one the club was, or is about to be, told about — at most one
    /// per board per <c>device_alert_cooldown_minutes</c>.
    ///
    /// <para>
    /// <b>Derived from the rows rather than stored on them</b>, which is what keeps this out
    /// of an EF migration for a notification decision. The board's outages are replayed in
    /// order and each is announced iff the cooldown has elapsed since the last ANNOUNCED one —
    /// not since the last outage, which would let a board flapping every fifty minutes chain
    /// its way past an hour's cooldown for ever. The rows are immutable once written, so the
    /// same replay at close time returns the same answer it did at open time and a recovery
    /// mail cannot be sent for an outage nobody was told about.
    /// </para>
    ///
    /// <para>
    /// The one thing that can move between the two is the SETTING: a club that shortens its
    /// cooldown mid-outage may get an all-clear for an alarm it did not get, or the reverse.
    /// That is the price of not adding a column, it is bounded to the boards in outage at the
    /// moment of the change, and it is stated rather than left to be discovered.
    /// </para>
    /// </summary>
    private static async Task<bool> AnnouncedAsync(
        Health health, Device device, DeviceOutage outage, CancellationToken ct)
    {
        var history = await health.Db.DeviceOutages.AsNoTracking()
            .Where(o => o.DeviceId == device.Id && o.DetectedAt <= outage.DetectedAt && o.Id != outage.Id)
            .Select(o => new { o.Id, o.DetectedAt })
            .ToListAsync(ct);

        // The row itself joins its own history from memory rather than from the table, because
        // OpenAsync asks BEFORE the row is saved — the alert is staged in the same save. Its
        // DetectedAt is immutable, so the replay is the one it always was, at open and at close.
        history.Add(new { outage.Id, outage.DetectedAt });

        var last = DateTimeOffset.MinValue;
        foreach (var row in history.OrderBy(o => o.DetectedAt).ThenBy(o => o.Id))
        {
            var announced = row.DetectedAt - last > health.Cooldown;
            if (announced) last = row.DetectedAt;
            if (row.Id == outage.Id) return announced;
        }

        return false;
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
