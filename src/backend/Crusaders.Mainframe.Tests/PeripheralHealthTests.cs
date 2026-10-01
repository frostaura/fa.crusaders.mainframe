using System.Globalization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <c>peripheral.unhealthy</c> — the event <c>feature-spec.md</c> §9 said could not be built.
///
/// <para>
/// The claim in §9 was that reinstating it "needs a real peripheral driver, or a device-side
/// liveness signal, first". Both halves were false and these tests are what falsifies them: the
/// box pushes a heartbeat that writes <see cref="Device.LastSeenAt"/>, and
/// <see cref="HeartbeatCadence.OfflineAfterSeconds"/> already said how much silence is too much
/// — the same number the Devices page has been rendering "offline" from all along. The missing
/// piece was a sweep, and a sweep needs no hardware to test.
/// </para>
///
/// <para>
/// The money half lives at the bottom: §6a promises a booking during an outage is "auto-credited
/// (no penalty)", and until now the no-show sweep charged the club's members a 30% penalty for
/// the club's own dark hardware.
/// </para>
/// </summary>
public class PeripheralHealthTests
{
    private static SweepThenDeliver CreateWorker(TestHost host) =>
        new(host, new(host.Services, host.Services.GetRequiredService<IEventBus>(), NullLogger<PeripheralHealthWorker>.Instance));

    /// <summary>
    /// The real worker, followed by one pass of the admin notice outbox at the same instant.
    ///
    /// <para>
    /// The admin alert is no longer sent BY the sweep: it is staged beside the outage row and
    /// mailed by the outbox (R23). Every assertion in this file about what the club's admins
    /// were mailed is therefore an assertion about the pair, and delivering at the tick's own
    /// instant is what lets a test that drives the clock hours ahead still see its mail — a
    /// notice stamped three hours from now is not due at the wall clock.
    /// </para>
    /// </summary>
    private sealed class SweepThenDeliver(TestHost host, PeripheralHealthWorker worker)
    {
        public Task TickAsync(CancellationToken ct) => TickAsync(DateTimeOffset.UtcNow, ct);

        public async Task TickAsync(DateTimeOffset now, CancellationToken ct)
        {
            await worker.TickAsync(now, ct);
            await host.DeliverAdminNoticesAsync(now);
        }
    }

    private static NoShowWorker CreateNoShowWorker(TestHost host) =>
        new(host.Services, host.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance);

    private static List<DomainEvent> Drain(TestHost host)
    {
        var bus = host.Services.GetRequiredService<IEventBus>();
        var emitted = new List<DomainEvent>();
        while (bus.Reader.TryRead(out var evt)) emitted.Add(evt);
        return emitted;
    }

    /// <summary>
    /// One box. <paramref name="installedAt"/> is the row's <c>CreatedAt</c> — when the club
    /// got this hardware — and it is a separate question from when it was last heard from.
    ///
    /// <para>
    /// It matters to the money: <c>DeviceOutageIndex</c> will not let a board vote on a deadline
    /// it did not exist at, so a fixture that leaves it implicit is saying "this board arrived
    /// the instant it was last seen", which for a healthy box is seconds ago. Left null the row
    /// keeps the entity default of <c>UtcNow</c>, which is the right shape for a board that has
    /// just appeared and the wrong one for a board the club has had for months.
    /// </para>
    /// </summary>
    private static async Task<Device> AddBoxAsync(
        TestHost host, MainframeDbContext db, DateTimeOffset? lastSeen, bool enabled = true,
        DateTimeOffset? installedAt = null, params int[] courts)
        => await AddBoxAsync(host, db, lastSeen, enabled, installedAt, null, courts);

    /// <summary>
    /// <paramref name="outOfServiceSince"/> is the recorded instant an admin threw the switch —
    /// <see cref="Device.OutOfServiceSince"/>, which <c>DeviceRegistryService.UpdateAsync</c>
    /// stamps on the transition. It is a third, separate question from the two above: when the
    /// club got the hardware, when it was last heard from, and when it was taken out of service
    /// are three different instants, and the money turns on the gap between the last two.
    ///
    /// <para>
    /// Left null on a switched-off row it means "no record of when the door shut", which is what
    /// every row looked like before the column existed and is judged by the board's silence
    /// alone. A fixture that leaves it implicit is therefore testing the fallback, not the rule
    /// the product uses — see
    /// <see cref="A_switched_off_row_with_no_recorded_instant_is_judged_by_its_silence_alone"/>.
    /// </para>
    /// </summary>
    private static async Task<Device> AddBoxAsync(
        TestHost host, MainframeDbContext db, DateTimeOffset? lastSeen, bool enabled,
        DateTimeOffset? installedAt, DateTimeOffset? outOfServiceSince, params int[] courts)
    {
        var device = new Device
        {
            TenantId = host.Tenant.Id,
            DeviceCode = $"box-{Guid.NewGuid():N}"[..12],
            Name = "Front panel",
            MacAddress = Guid.NewGuid().ToString("N")[..12],
            CourtNumbers = courts.Length > 0 ? [.. courts] : [host.Courts[0].CourtNumber],
            Enabled = enabled,
            LastSeenAt = lastSeen,
            OutOfServiceSince = outOfServiceSince,
            CreatedAt = installedAt ?? DateTimeOffset.UtcNow,
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();
        return device;
    }

    // ----- detection -------------------------------------------------------------------

    /// <summary>
    /// The whole finding, in one test: a box that has stopped calling home produces the event
    /// §9 said nothing could produce.
    /// </summary>
    [Fact]
    public async Task A_box_that_has_stopped_heart_beating_raises_peripheral_unhealthy()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-20));
        Drain(host);

        await CreateWorker(host).TickAsync(default);

        var evt = Assert.Single(Drain(host), e => e.Type == "peripheral.unhealthy");
        Assert.Equal(box.DeviceCode, evt.Data["device_code"]);
        Assert.Equal(host.Tenant.Id, evt.TenantId);
        Assert.Equal(HeartbeatCadence.OfflineAfterSeconds(TenantSettingsView.DefaultHeartbeatSeconds),
            evt.Data["offline_after_seconds"]);
    }

    /// <summary>
    /// R23: the alert is an outbox row staged beside the outage row, keyed on that row — so each
    /// edge of each outage is one notice, and a second tick has nothing to add.
    /// </summary>
    [Fact]
    public async Task The_alert_is_an_admin_notice_keyed_on_the_outage_row()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-20));

        var worker = new PeripheralHealthWorker(host.Services, host.Services.GetRequiredService<IEventBus>(), NullLogger<PeripheralHealthWorker>.Instance);
        await worker.TickAsync(default);
        await worker.TickAsync(default);

        var outage = await db.DeviceOutages.AsNoTracking().SingleAsync(o => o.DeviceId == box.Id);
        var notice = await db.AdminNotifications.AsNoTracking().SingleAsync();
        Assert.Equal(AdminEventCatalogue.DeviceOffline, notice.Kind);
        Assert.Equal($"device.offline:{outage.Id:N}", notice.DedupeKey);
        Assert.Equal(AdminNotificationState.Pending, notice.State);
        // Nothing is mailed by the sweep itself any more — only by the outbox.
        Assert.Empty(host.EmailService.Sent);
    }

    /// <summary>
    /// Once per outage, not once per tick — the same discipline as the lights-off marker. A
    /// sweep every thirty seconds that re-alerted a club for as long as a box stayed dark is
    /// how an alert gets filtered into a folder nobody reads.
    /// </summary>
    [Fact]
    public async Task The_alert_fires_once_per_outage_and_not_once_per_tick()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-20));
        Drain(host);
        host.EmailService.Clear();

        var worker = CreateWorker(host);
        await worker.TickAsync(default);
        await worker.TickAsync(default);
        await worker.TickAsync(default);

        Assert.Single(Drain(host), e => e.Type == "peripheral.unhealthy");
        Assert.Single(host.EmailService.Sent, m => m.Subject.Contains("not reporting", StringComparison.Ordinal));
        Assert.Single(await db.DeviceOutages.IgnoreQueryFilters().ToListAsync());
    }

    /// <summary>A box calling in on schedule is not an incident.</summary>
    [Fact]
    public async Task A_box_still_within_the_threshold_is_not_reported()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-30));
        Drain(host);

        await CreateWorker(host).TickAsync(default);

        Assert.DoesNotContain(Drain(host), e => e.Type.StartsWith("peripheral.", StringComparison.Ordinal));
        Assert.Empty(await db.DeviceOutages.IgnoreQueryFilters().ToListAsync());
    }

    /// <summary>
    /// A box an admin switched off is silent by their own decision. Alerting on it teaches the
    /// club to ignore the alert that matters.
    /// </summary>
    [Fact]
    public async Task A_disabled_box_is_not_reported()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddDays(-3), enabled: false);
        Drain(host);

        await CreateWorker(host).TickAsync(default);

        Assert.DoesNotContain(Drain(host), e => e.Type.StartsWith("peripheral.", StringComparison.Ordinal));
    }

    /// <summary>§6a: "admin gets a high-priority alert" — a real header, to the club's own admins.</summary>
    [Fact]
    public async Task The_clubs_admins_get_a_high_priority_alert_naming_the_courts()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-20), true, null, 1, 2);
        host.EmailService.Clear();

        await CreateWorker(host).TickAsync(default);

        var alert = Assert.Single(host.EmailService.Sent);
        Assert.Equal(host.AdminUser.Email, alert.To);
        Assert.True(alert.HighPriority, "§6a calls this a high-priority alert; the message must carry the header");
        Assert.Contains(box.DeviceCode, alert.Subject, StringComparison.Ordinal);
        Assert.Contains("courts 1, 2", alert.HtmlBody, StringComparison.Ordinal);
        Assert.DoesNotContain(host.PlayerUser.Email, host.EmailService.Sent.Select(m => m.To));
    }

    /// <summary>
    /// The alert must not open by sending an admin to the plug.
    ///
    /// <para>
    /// A box that has lost only its uplink keeps lighting courts from its cached roster and holds
    /// the scans in a RAM ring (<c>src/iot/shared/lib/eventq/include/eventq/EventQueue.h</c>). Cutting
    /// the power discards them, and every court it lit during the outage then settles under S5a
    /// as a full refund the club carries — the one accepted I2 exception. The alert that reports
    /// the outage used to say "Check its power and its WiFi", i.e. it led with the single action
    /// that converts a recoverable outage into free courts.
    /// </para>
    /// </summary>
    [Fact]
    public async Task The_unhealthy_alert_does_not_send_the_admin_to_the_plug_first()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-20));
        host.EmailService.Clear();

        await CreateWorker(host).TickAsync(default);

        var alert = Assert.Single(host.EmailService.Sent);
        Assert.Contains("do not power-cycle it yet", alert.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Check its power", alert.HtmlBody, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// And the all-clear must not promise what the hardware cannot deliver. It used to state flatly
    /// that "anything the box recorded while it was offline uploads on its next few calls" — true
    /// only while the box stayed powered, and false in exactly the case that costs the club money.
    /// </summary>
    [Fact]
    public async Task The_recovery_mail_qualifies_the_upload_promise_with_the_power_cut()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-20));
        var worker = CreateWorker(host);
        await worker.TickAsync(default);
        host.EmailService.Clear();

        box.LastSeenAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();
        await worker.TickAsync(default);

        var allClear = Assert.Single(host.EmailService.Sent);
        Assert.Contains("if it stayed powered", allClear.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("those scans are gone", allClear.HtmlBody, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Recovery, so an admin sent to a cupboard knows to stop looking.</summary>
    [Fact]
    public async Task A_box_that_comes_back_closes_its_outage_and_says_so()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-20));
        var worker = CreateWorker(host);
        await worker.TickAsync(default);
        Drain(host);
        host.EmailService.Clear();

        // What the heartbeat endpoint does when the box calls in again.
        box.LastSeenAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();
        await worker.TickAsync(default);

        var evt = Assert.Single(Drain(host), e => e.Type == "peripheral.recovered");
        Assert.Equal(box.DeviceCode, evt.Data["device_code"]);
        Assert.Single(host.EmailService.Sent, m => m.Subject.Contains("back online", StringComparison.Ordinal));

        var outage = Assert.Single(await db.DeviceOutages.IgnoreQueryFilters().ToListAsync());
        Assert.NotNull(outage.EndedAt);

        // And a second outage is reportable afterwards — the marker is per outage, not per box.
        box.LastSeenAt = DateTimeOffset.UtcNow.AddMinutes(-20);
        await db.SaveChangesAsync();
        await worker.TickAsync(default);
        Assert.Single(Drain(host), e => e.Type == "peripheral.unhealthy");
    }

    // ----- a door is not a court box ---------------------------------------------------

    /// <summary>
    /// One door gate: no courts, one lock, and a name an admin gave it.
    ///
    /// <para>
    /// <c>CourtNumbers</c> is empty and that is not incidental — it is what keeps a gate out
    /// of <c>DeviceOutageIndex</c>'s court darkness, which the money pin below exists to hold.
    /// </para>
    /// </summary>
    private static async Task<Device> AddGateAsync(
        TestHost host, MainframeDbContext db, DateTimeOffset? lastSeen, string? gateKey = "front-door")
    {
        var device = new Device
        {
            TenantId = host.Tenant.Id,
            DeviceCode = $"gate-{Guid.NewGuid():N}"[..12],
            Name = "Door gate",
            Kind = DeviceKind.Gate,
            Hardware = DeviceHardware.Esp32,
            MacAddress = Guid.NewGuid().ToString("N")[..12],
            CourtNumbers = [],
            GateKey = gateKey,
            LastSeenAt = lastSeen,
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();
        return device;
    }

    /// <summary>
    /// <b>A silent door must not send the court-box outage mail.</b>
    ///
    /// <para>
    /// The sweep took every enabled device with no filter on its kind, so a gate that stopped
    /// reporting mailed the club's admins "Court box not reporting", told them members on
    /// "those courts" might not be able to check in, and promised that bookings past their
    /// grace window would be refunded with no no-show penalty. Every one of those sentences is
    /// false about a door: a gate drives no courts, stamps no attendance and is invisible to
    /// the settlement model, so nothing is refunded and no penalty is waived. An admin acting
    /// on that mail goes looking for a court box that is working fine, and the door stays shut.
    /// </para>
    ///
    /// <para>
    /// What is true about a silent door is worth saying instead, so the alert carries it:
    /// scans there fall back to booked members only, and to nobody once the cached roster goes
    /// stale six hours after it was fetched.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_silent_gate_gets_a_door_alert_and_none_of_the_court_boxs_sentences()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var gate = await AddGateAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-20));
        host.EmailService.Clear();

        await CreateWorker(host).TickAsync(default);

        var alert = Assert.Single(host.EmailService.Sent);
        Assert.Equal(host.AdminUser.Email, alert.To);
        Assert.Contains("Door gate not reporting", alert.Subject, StringComparison.Ordinal);
        Assert.Contains(gate.DeviceCode, alert.Subject, StringComparison.Ordinal);
        Assert.Contains("front-door", alert.HtmlBody, StringComparison.Ordinal);

        // The door's own truth.
        Assert.Contains("booked members", alert.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("6 hours", alert.HtmlBody, StringComparison.OrdinalIgnoreCase);

        // And none of the court box's. Each of these is a sentence an admin would act on.
        Assert.DoesNotContain("court box", alert.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("courts", alert.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("refund", alert.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("no-show", alert.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("check in", alert.HtmlBody, StringComparison.OrdinalIgnoreCase);

        // The outage row itself is the court box's, unchanged: a door going dark is still an
        // incident and still fires once per outage.
        Assert.Single(await db.DeviceOutages.IgnoreQueryFilters().ToListAsync());
        Assert.Single(Drain(host), e => e.Type == "peripheral.unhealthy");
    }

    /// <summary>
    /// The all-clear has the same problem from the other end: the court box's says scans
    /// recorded during the outage will upload and settle as attended, and that courts it lit
    /// are otherwise refunded. A door records no attendance and lights no court.
    /// </summary>
    [Fact]
    public async Task A_gate_that_comes_back_gets_a_door_all_clear_and_none_of_the_court_boxs()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var gate = await AddGateAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-20));
        var worker = CreateWorker(host);
        await worker.TickAsync(default);
        host.EmailService.Clear();

        gate.LastSeenAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();
        await worker.TickAsync(default);

        var allClear = Assert.Single(host.EmailService.Sent);
        Assert.Contains("Door gate back online", allClear.Subject, StringComparison.Ordinal);
        Assert.DoesNotContain("court", allClear.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("refund", allClear.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("attended", allClear.HtmlBody, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// A court box that is still a court box. The two tests above would both pass against a
    /// worker that sent the door's mail to everybody, which would be the same defect pointing
    /// the other way — and the court box's mail is the one carrying the money sentences.
    /// </summary>
    [Fact]
    public async Task A_silent_box_beside_a_silent_gate_still_gets_the_court_boxs_alert()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-20), true, null, 1, 2);
        var gate = await AddGateAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-20));
        host.EmailService.Clear();

        await CreateWorker(host).TickAsync(default);

        var boxAlert = Assert.Single(host.EmailService.Sent, m => m.Subject.Contains(box.DeviceCode, StringComparison.Ordinal));
        Assert.Contains("Court box not reporting", boxAlert.Subject, StringComparison.Ordinal);
        Assert.Contains("courts 1, 2", boxAlert.HtmlBody, StringComparison.Ordinal);
        Assert.Contains("no no-show penalty", boxAlert.HtmlBody, StringComparison.Ordinal);

        var gateAlert = Assert.Single(host.EmailService.Sent, m => m.Subject.Contains(gate.DeviceCode, StringComparison.Ordinal));
        Assert.Contains("Door gate not reporting", gateAlert.Subject, StringComparison.Ordinal);
    }

    /// <summary>
    /// <b>A silent door darkens no court.</b> <c>DeviceOutageIndex</c> attributes darkness
    /// through <see cref="Device.CourtNumbers"/> and a gate's is empty, so this holds today —
    /// it is pinned at the WORKER level because the worker is what opens the outage row the
    /// index reads, and because the obvious "fix" for the alert above is a kind column
    /// somewhere in that query.
    ///
    /// <para>
    /// The stake is a club's whole no-show income: a door in a corridor going dark for a week
    /// must not waive the penalty on every court in the building. The control makes the BOX
    /// silent too, so the test cannot pass against a sweep that waives nothing at all.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_silent_gate_darkens_no_court_and_waives_no_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // The court's own box is healthy; the door beside it has been dark for an hour.
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20));
        var gate = await AddGateAsync(host, db, DateTimeOffset.UtcNow.AddHours(-1));

        await CreateWorker(host).TickAsync(default);
        Assert.Single(await db.DeviceOutages.IgnoreQueryFilters().Where(o => o.DeviceId == gate.Id).ToListAsync());
        Drain(host);

        await CreateNoShowWorker(host).TickAsync(default);

        // 30% of 8 retained: the court was never dark.
        Assert.Equal(97.60m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        var evt = Assert.Single(Drain(host), e => e.Type == "booking.no_show");
        Assert.Equal(2.40m, evt.Data["penalty_minutes"]);
        Assert.Equal(false, evt.Data["peripheral_outage"]);
    }

    // ----- how often a board may mail the club about itself ----------------------------

    /// <summary>
    /// Writes <c>device_alert_cooldown_minutes</c> into the tenant's settings document, the
    /// way the admin PUT would. Merged rather than replaced, so a test that varies this one
    /// number is varying one number.
    /// </summary>
    private static async Task SetCooldownAsync(MainframeDbContext db, TestHost host, int minutes)
    {
        var row = await db.TenantSettings.FirstAsync(s => s.TenantId == host.Tenant.Id);
        using var doc = System.Text.Json.JsonDocument.Parse(
            string.IsNullOrWhiteSpace(row.SettingsJson) ? "{}" : row.SettingsJson);

        var merged = doc.RootElement.EnumerateObject()
            .ToDictionary(p => p.Name, p => System.Text.Json.JsonSerializer.Deserialize<object?>(p.Value.GetRawText()));
        merged["device_alert_cooldown_minutes"] = minutes;

        row.SettingsJson = System.Text.Json.JsonSerializer.Serialize(merged);
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// <b>A board flapping on a bad uplink is one message, not a hundred.</b>
    ///
    /// <para>
    /// The sweep had no cooldown and no minimum outage: every transition mailed every admin.
    /// A board on a marginal link going down and up every few minutes filled the club's
    /// mailboxes with "not reporting" and "back online" until somebody muted the sender — and
    /// an alert nobody reads is worse than no alert, because the club believes it has one.
    /// </para>
    ///
    /// <para>
    /// This drives the REAL worker across six simulated hours with an injected clock, which is
    /// the only way the behaviour is visible at all: the bug is not in any single tick.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_flapping_board_mails_the_club_once_per_cooldown_and_not_once_per_flap()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var worker = CreateWorker(host);

        var start = DateTimeOffset.UtcNow.AddHours(-6);
        var box = await AddBoxAsync(host, db, start, enabled: true, installedAt: start.AddDays(-30));
        host.EmailService.Clear();

        // Six flaps at nine-minute intervals, so every detection lands inside one
        // sixty-minute cooldown of the first — the first is detected at +4 and the last at
        // +49. Each flap is a real outage: silent past the threshold, then a heartbeat.
        const int Flaps = 6;
        for (var i = 0; i < Flaps; i++)
        {
            var quiet = start.AddMinutes(i * 9);
            var back = quiet.AddMinutes(5);

            await worker.TickAsync(quiet.AddMinutes(4), default);     // past offline_after_seconds
            box.LastSeenAt = back;
            await db.SaveChangesAsync();
            await worker.TickAsync(back.AddSeconds(1), default);      // the all-clear
        }

        // Every flap wrote its row — the Devices page still has the history.
        var outages = await db.DeviceOutages.IgnoreQueryFilters().Where(o => o.DeviceId == box.Id).ToListAsync();
        Assert.Equal(Flaps, outages.Count);
        Assert.True(
            outages.Max(o => o.DetectedAt) - outages.Min(o => o.DetectedAt)
                < TimeSpan.FromMinutes(TenantSettingsView.DefaultDeviceAlertCooldownMinutes),
            "the fixture must keep every flap inside ONE cooldown, or this tests nothing");

        // The club heard about the first one and nothing else inside the hour: one alert and
        // its all-clear. Not ten of each.
        Assert.Equal(2, host.EmailService.Sent.Count);
        Assert.Single(host.EmailService.Sent, m => m.Subject.Contains("not reporting", StringComparison.Ordinal));
        Assert.Single(host.EmailService.Sent, m => m.Subject.Contains("back online", StringComparison.Ordinal));

        // …and the cooldown is a cooldown, not a mute: past it the club is told again.
        var later = start.AddMinutes(200);
        await worker.TickAsync(later, default);
        Assert.Equal(3, host.EmailService.Sent.Count);
    }

    /// <summary>
    /// The cooldown is the club's setting, and it is read rather than assumed. Five minutes
    /// through the same ten-minute flaps means every flap is heard about; the probe is the
    /// same fixture with one number changed.
    /// </summary>
    [Fact]
    public async Task The_cooldown_is_the_clubs_setting()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var worker = CreateWorker(host);

        await SetCooldownAsync(db, host, 5);

        var start = DateTimeOffset.UtcNow.AddHours(-6);
        var box = await AddBoxAsync(host, db, start, enabled: true, installedAt: start.AddDays(-30));
        host.EmailService.Clear();

        for (var i = 0; i < 3; i++)
        {
            var quiet = start.AddMinutes(i * 10);
            await worker.TickAsync(quiet.AddMinutes(4), default);
            box.LastSeenAt = quiet.AddMinutes(5);
            await db.SaveChangesAsync();
            await worker.TickAsync(quiet.AddMinutes(5).AddSeconds(1), default);
        }

        // Three alerts and three all-clears: with a five-minute cooldown, ten minutes apart is
        // outside it. The same fixture on the default sixty gets two mails in total.
        Assert.Equal(6, host.EmailService.Sent.Count);
    }

    /// <summary>
    /// <b>A door nobody has named mails nobody.</b>
    ///
    /// <para>
    /// Auto-registration is unbounded: anything holding the club's device key can heartbeat
    /// with an invented MAC and <c>kind: "gate"</c> and a row appears. Before this, each of
    /// those rows could then mail every admin of the club on every transition — a mail flood
    /// available on demand to whoever had the key. It is the same capability D3 took the
    /// roster away for, and naming the door is the same acknowledgement.
    /// </para>
    ///
    /// <para>
    /// The row and the event are still written: the Devices page is where an admin looks at a
    /// board on purpose, and what is withheld is the interruption, not the record.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_gate_no_admin_has_named_alerts_nobody_and_still_records_its_outage()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var unnamed = await AddGateAsync(host, db, DateTimeOffset.UtcNow.AddHours(-1), gateKey: null);
        host.EmailService.Clear();

        await CreateWorker(host).TickAsync(default);

        Assert.Empty(host.EmailService.Sent);
        Assert.Single(await db.DeviceOutages.IgnoreQueryFilters().Where(o => o.DeviceId == unnamed.Id).ToListAsync());
        Assert.Single(Drain(host), e => e.Type == "peripheral.unhealthy");

        // It comes back while still unnamed: closed silently, because a recovery mail for an
        // alarm nobody was given is noise about an event the club never heard of.
        unnamed.LastSeenAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();
        await CreateWorker(host).TickAsync(default);
        Assert.Empty(host.EmailService.Sent);

        // The probe: ONE field. The same board, now named by an admin, goes dark again and
        // the club hears about it.
        unnamed.GateKey = "side-door";
        unnamed.LastSeenAt = DateTimeOffset.UtcNow.AddHours(-1);
        await db.SaveChangesAsync();
        await CreateWorker(host).TickAsync(DateTimeOffset.UtcNow.AddHours(3), default);
        Assert.Single(host.EmailService.Sent, m => m.Subject.Contains("not reporting", StringComparison.Ordinal));
    }

    /// <summary>
    /// <b>The naming gate was a door rule, and the flood was never a door problem.</b>
    ///
    /// <para>
    /// <c>Mailable</c> exempted only an unnamed GATE, and a gate is the one kind of board that
    /// has to be named before it does anything. A <c>kind</c>-less heartbeat from an invented
    /// MAC auto-registers a COURT BOX with no naming step at all — and a court box is mailable
    /// the instant it exists. So the capability D3 and G2's B5 were closing was still open,
    /// on the default path, to anything holding the club's device key: mint boards, wait for
    /// the threshold, and every admin of the club gets one mail per board per cooldown. Twelve
    /// boards is twelve mails per admin in a single thirty-second tick, and the ceiling is the
    /// tenant rate limit — thousands an hour, each one leaving a permanent row behind.
    /// </para>
    ///
    /// <para>
    /// The rule is therefore the acknowledgement itself and not the door's name:
    /// <c>AutoRegistered</c> is exactly "nobody has looked at this row", it is already on
    /// every kind, and the first admin edit clears it. A gate an admin has named has been
    /// edited, so it passes for free and the door rule stops needing to be a separate one.
    /// </para>
    ///
    /// <para>
    /// The boards here are made by the REAL <c>AutoRegisterAsync</c>, which is what the
    /// heartbeat calls. A hand-built fixture would be setting the very flag under test.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_board_no_admin_has_acknowledged_mails_nobody_however_many_of_them_appear()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var registry = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

        var silent = DateTimeOffset.UtcNow.AddHours(-1);
        var minted = new List<Device>();
        for (var i = 0; i < 12; i++)
        {
            var kind = i % 2 == 0 ? DeviceKind.CourtBox : DeviceKind.Gate;
            var board = await registry.AutoRegisterAsync(Guid.NewGuid().ToString("N")[..12], kind, default);

            // A court box auto-registers with NO gate key to withhold and, before this, was
            // mailable from its first heartbeat. Half the boards here are gates purely so the
            // rule is shown to be one rule rather than two.
            board.LastSeenAt = silent;
            minted.Add(board);
        }
        await db.SaveChangesAsync();
        host.EmailService.Clear();

        await CreateWorker(host).TickAsync(default);

        Assert.Empty(host.EmailService.Sent);

        // The record survives the silence: the Devices page is where an admin looks at a board
        // on purpose, and what is withheld is the interruption.
        Assert.Equal(12, await db.DeviceOutages.IgnoreQueryFilters()
            .CountAsync(o => minted.Select(m => m.Id).Contains(o.DeviceId)));
        Assert.Equal(12, Drain(host).Count(e => e.Type == "peripheral.unhealthy"));

        // The probe: ONE field on ONE board. An admin edits it — which is what clears
        // AutoRegistered — and the club hears about that board and no other.
        var acknowledged = minted[0];
        await registry.UpdateAsync(
            acknowledged, new UpdateDeviceCommand("Front panel", null, null), host.AdminUser.Id, default);
        Assert.False(acknowledged.AutoRegistered);

        foreach (var board in minted) board.LastSeenAt = silent;
        foreach (var outage in await db.DeviceOutages.IgnoreQueryFilters().ToListAsync())
        {
            outage.EndedAt = silent;
        }
        await db.SaveChangesAsync();
        host.EmailService.Clear();

        await CreateWorker(host).TickAsync(DateTimeOffset.UtcNow.AddHours(3), default);

        Assert.Single(host.EmailService.Sent, m => m.Subject.Contains("not reporting", StringComparison.Ordinal));
    }

    /// <summary>
    /// The gate's own naming rule still holds, and is now the narrower of two: a gate an admin
    /// HAS acknowledged but has not named still mails nobody. Naming is what starts the
    /// offline roster (D3), and an alert about a door the club cannot identify in the message
    /// is an alert nobody can act on.
    /// </summary>
    [Fact]
    public async Task An_acknowledged_but_unnamed_gate_still_mails_nobody()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        // AddGateAsync leaves AutoRegistered false — an admin has been here — and gateKey null.
        var gate = await AddGateAsync(host, db, DateTimeOffset.UtcNow.AddHours(-1), gateKey: null);
        Assert.False(gate.AutoRegistered);
        host.EmailService.Clear();

        await CreateWorker(host).TickAsync(default);

        Assert.Empty(host.EmailService.Sent);
        Assert.Single(await db.DeviceOutages.IgnoreQueryFilters().Where(o => o.DeviceId == gate.Id).ToListAsync());
    }

    /// <summary>
    /// <b>Re-enabling a long-disabled board must not mail "back after 43 200 minutes".</b>
    ///
    /// <para>
    /// The sweep skips disabled rows, so an outage open when an admin threw the switch stayed
    /// open for as long as the board was out of service. Switch it back on, let it report, and
    /// the first tick closed a row that had been open for a month and mailed the whole club an
    /// all-clear for an outage they had themselves created.
    /// </para>
    ///
    /// <para>
    /// The row is closed at the switch instant instead — the same instant
    /// <c>OutOfServiceSince</c> records, and therefore the last moment the club was
    /// accountable for this board.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Taking_a_board_out_of_service_closes_its_outage_silently()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var registry = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddHours(-1));
        host.EmailService.Clear();

        await CreateWorker(host).TickAsync(default);
        var outage = Assert.Single(await db.DeviceOutages.IgnoreQueryFilters().Where(o => o.DeviceId == box.Id).ToListAsync());
        Assert.Null(outage.EndedAt);
        Assert.Single(host.EmailService.Sent);
        host.EmailService.Clear();

        // The admin takes it out of service.
        await registry.UpdateAsync(box, new UpdateDeviceCommand(null, false, null, null, null), host.AdminUser.Id, default);

        await db.Entry(outage).ReloadAsync();
        Assert.NotNull(outage.EndedAt);
        Assert.Equal(box.OutOfServiceSince, outage.EndedAt);
        Assert.Empty(host.EmailService.Sent);

        // A month later it goes back into service and reports. Nothing is mailed about the
        // month the club had it switched off.
        box.Enabled = true;
        box.OutOfServiceSince = null;
        box.LastSeenAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();

        await CreateWorker(host).TickAsync(default);
        Assert.Empty(host.EmailService.Sent);
    }

    /// <summary>
    /// <b>…and it still darkens no court once somebody has put a court number on it.</b>
    ///
    /// <para>
    /// The test above passes for the wrong reason, and flipping one fixture field is what
    /// shows it: <c>DeviceOutageIndex</c> read every device row with no filter on kind at all,
    /// and a gate was left out of the court index only because auto-registration gives it an
    /// empty <c>CourtNumbers</c>. That is not a rule, it is a coincidence of the default —
    /// exactly the class of defect <c>memory/gotchas.md</c> records ("a test can be green
    /// because of its FIXTURE"), and exactly the sentence <c>GateAccess.NotACourtBox</c> was
    /// written for: a rule enforced by the emptiness of an unrelated list is not enforced.
    /// </para>
    ///
    /// <para>
    /// The court number is written <b>directly to the row</b>, because the product refuses to
    /// put one there: <c>PATCH /admin/devices/{id}</c> answers <c>court_fields_on_a_gate</c>.
    /// That is the point. Nothing stops a restore, a fixture or a later migration producing
    /// this row, and the money consequence is immediate in both directions — a silent door
    /// waiving penalties on a court it does not drive, and a healthy door vetoing the §6a
    /// waiver on a court whose box is genuinely dark.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_silent_gate_carrying_a_court_number_still_darkens_no_court()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20));
        var gate = await AddGateAsync(host, db, DateTimeOffset.UtcNow.AddHours(-1));

        // The one field. Written straight to the row: the API refuses to do this.
        gate.CourtNumbers = [host.Courts[0].CourtNumber];
        await db.SaveChangesAsync();

        await CreateWorker(host).TickAsync(default);
        Drain(host);
        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(97.60m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        var evt = Assert.Single(Drain(host), e => e.Type == "booking.no_show");
        Assert.Equal(2.40m, evt.Data["penalty_minutes"]);
        Assert.Equal(false, evt.Data["peripheral_outage"]);
    }

    /// <summary>
    /// The mirror, and the one that costs the MEMBER rather than the club: a HEALTHY door with
    /// a court number on it must not vote a genuinely dark court back into the light.
    ///
    /// <para>
    /// This is the direction the empty-list coincidence never protected against at all, and it
    /// is the one §6a exists to prevent — the club billing a member 30% for its own outage.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_healthy_gate_carrying_a_court_number_does_not_block_the_waiver()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // The instants matter and are stated. The booking started an hour ago, so its grace
        // deadline — the instant the waiver is judged at — is 55 minutes ago. The box had been
        // silent for over two hours by then; the door had been heard from a minute before it,
        // so at that instant the door was REACHABLE and would have voted the court Lit.
        //
        // The door's last heartbeat is deliberately not "twenty seconds ago": a board is only
        // evidence about an instant it existed at (DeviceOutageIndex.KnownToExistFrom), and a
        // board first heard from after the deadline is skipped rather than counted — which
        // would make this test pass without discriminating anything.
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddHours(-3));
        var gate = await AddGateAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-56));
        gate.CourtNumbers = [host.Courts[0].CourtNumber];
        await db.SaveChangesAsync();

        await CreateWorker(host).TickAsync(default);
        Drain(host);
        await CreateNoShowWorker(host).TickAsync(default);

        // Refunded in full, no penalty: §6a. A door is not a court's evidence either way.
        Assert.Equal(100, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        var evt = Assert.Single(Drain(host), e => e.Type == "booking.no_show");
        Assert.Equal(0, evt.Data["penalty_minutes"]);
        Assert.Equal(true, evt.Data["peripheral_outage"]);
    }

    // ----- money: §6a's "auto-credited (no penalty)" -----------------------------------

    private static async Task<Booking> AddDueBookingAsync(
        TestHost host, MainframeDbContext db, int amount = 8, DateTimeOffset? startsAt = null)
    {
        var starts = startsAt ?? DateTimeOffset.UtcNow.AddHours(-1);
        var booking = new Booking
        {
            TenantId = host.Tenant.Id,
            CourtId = host.Courts[0].Id,
            UserId = host.PlayerUser.Id,
            BookedByUserId = host.PlayerUser.Id,
            PaidByUserId = host.PlayerUser.Id,
            StartsAt = starts,
            EndsAt = starts.AddMinutes(15),
            SliceMinutes = 15,
            SliceCount = 1,
            AmountChargedMinutes = amount,
            Status = BookingStatus.Booked,
            CheckedInAt = null,
            ChargedAt = DateTimeOffset.UtcNow.AddHours(-2),
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking;
    }

    private static async Task AddOutageAsync(
        TestHost host, MainframeDbContext db, Device device, DateTimeOffset startedAt, DateTimeOffset? endedAt)
    {
        db.DeviceOutages.Add(new DeviceOutage
        {
            TenantId = host.Tenant.Id,
            DeviceId = device.Id,
            StartedAt = startedAt,
            DetectedAt = startedAt.AddMinutes(3),
            EndedAt = endedAt,
        });
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// §6a, and the reason it is money: a member standing at a court whose box is dark cannot
    /// check in, so the sweep called them a no-show and took 30% off them for the club's own
    /// hardware. Under S5a the booking is refunded in full and <c>Owed(b) = 0</c>.
    /// </summary>
    [Fact]
    public async Task A_no_show_swept_while_the_court_was_dark_is_refunded_with_no_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90));
        await AddOutageAsync(host, db, box, booking.StartsAt.AddMinutes(-10), endedAt: null);
        Drain(host);
        host.EmailService.Clear();

        await CreateNoShowWorker(host).TickAsync(default);

        // Owed(b) = 0: the charge is fully back and nothing was retained.
        Assert.Equal(100, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        var rows = await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync();
        Assert.Contains(rows, l => l.Type == LedgerEntryType.CancellationRefund && l.AmountMinutes == 8);
        Assert.DoesNotContain(rows, l => l.Type == LedgerEntryType.NoShowPenalty);

        var evt = Assert.Single(Drain(host), e => e.Type == "booking.no_show");
        Assert.Equal(0, evt.Data["penalty_minutes"]);
        Assert.Equal(8, evt.Data["refund_minutes"]);
        Assert.Equal(true, evt.Data["peripheral_outage"]);

        // §6a: "players in the affected window get an email explaining the situation" — the
        // explanation, not the accusation.
        var notice = Assert.Single(host.EmailService.Sent, m => m.To == host.PlayerUser.Email);
        Assert.Contains("offline", notice.Subject, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("no-show", notice.HtmlBody, StringComparison.OrdinalIgnoreCase);

        // THE FIGURE THE WORKER PASSED, not the figure a template renders when handed one. Every
        // other assertion here survives `Notice()` being changed to pass a constant: a verifier
        // substituted a hard-coded `0m` for `refundedMinutes` at the CALL SITE and the whole suite
        // stayed green at 1019, so a member whose ledger holds +8.00 would have been mailed
        // "Refunded 0.00 credits" with nothing to notice it. The templates are pinned letter by
        // letter one layer down; this is the wiring, which is where the money actually travels.
        //
        // `NoShowWorker`'s own doc records this exact slot shipping wrong once already — the net
        // figure passed into the gross slot, mailing "Refunded 35.00 credits" against a ledger
        // holding +50.00 and -15.00. It had no pin then either.
        var refund = Assert.Single(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id && l.Type == LedgerEntryType.CancellationRefund)
            .ToListAsync());
        Assert.Equal(8, refund.AmountMinutes);
        Assert.Contains(refund.AmountMinutes.ToString("0.00", CultureInfo.InvariantCulture), notice.HtmlBody);
        // …and the court and club it names are the ones this booking is on, which the same
        // substitution showed were equally free to be anything.
        Assert.Contains(host.Courts[0].Name, notice.HtmlBody);
    }

    /// <summary>
    /// The control. Without it the waiver could be "never charge a penalty" and every test
    /// above would still pass.
    /// </summary>
    [Fact]
    public async Task A_no_show_on_a_court_whose_box_was_reachable_still_pays_the_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20));
        Drain(host);

        await CreateNoShowWorker(host).TickAsync(default);

        // 30% of 8 retained.
        Assert.Equal(97.60m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        var evt = Assert.Single(Drain(host), e => e.Type == "booking.no_show");
        Assert.Equal(2.40m, evt.Data["penalty_minutes"]);
        Assert.Equal(false, evt.Data["peripheral_outage"]);
    }

    /// <summary>
    /// A club with two boxes: the annex box being dark says nothing about the main court, and
    /// waiving there would hand every member in the club a free no-show.
    /// </summary>
    [Fact]
    public async Task An_outage_on_a_box_that_drives_other_courts_does_not_waive_the_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var elsewhere = host.Courts[0].CourtNumber + 40;
        var annex = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90), true, null, elsewhere);
        await AddOutageAsync(host, db, annex, booking.StartsAt.AddMinutes(-10), endedAt: null);

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(97.60m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }

    /// <summary>
    /// The reason the outage is a row and not a flag on the device. By the time the sweep runs
    /// the box may be back, and <c>LastSeenAt</c> then says "healthy" about a window in which it
    /// was not. Money must not turn on how promptly a background worker happened to run.
    /// </summary>
    [Fact]
    public async Task An_outage_that_has_already_ended_still_waives_the_window_it_covered()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // Back online right now, and dark across the booking's grace window.
        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-10));
        await AddOutageAsync(host, db, box, booking.StartsAt.AddMinutes(-10), booking.StartsAt.AddMinutes(30));

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }

    /// <summary>
    /// The instant that decides it is the grace DEADLINE, not the slot start. A box that
    /// reconnected before the deadline uploaded whatever it queued through the outage, so if the
    /// member played we already know — and if they did not, they had a working court to scan at.
    /// </summary>
    [Fact]
    public async Task An_outage_that_ended_before_the_grace_deadline_does_not_waive_the_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var settings = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-10));
        await AddOutageAsync(host, db, box,
            booking.StartsAt.AddMinutes(-30),
            booking.StartsAt.AddMinutes(settings.GraceWindowMinutes - 1));

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(97.60m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }

    // ----- the waiver must not depend on when a worker happened to run ------------------

    /// <summary>
    /// One club, one due booking, one box that fell silent two minutes before that booking's
    /// grace deadline, and the two production workers run in the given order. Returns what the
    /// member is left with.
    ///
    /// <para>
    /// <paramref name="deadlineMinutesAgo"/> is how late the sweep is: 0 means it runs as the
    /// grace window closes, 5 means it runs five minutes afterwards. Nothing else differs
    /// between the cases — the silence, the booking and the price are identical relative to the
    /// deadline — so any difference in the balance is the worker schedule pricing the court.
    /// </para>
    /// </summary>
    private static async Task<decimal> SweptBalanceAsync(int deadlineMinutesAgo, bool healthFirst)
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var settings = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

        // A second's slack so the booking is unambiguously past its deadline for the sweep's
        // own UtcNow, which is read after this one.
        var deadline = DateTimeOffset.UtcNow.AddMinutes(-deadlineMinutesAgo).AddSeconds(-1);
        var startsAt = deadline.AddMinutes(-settings.GraceWindowMinutes);

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db, startsAt: startsAt);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // Two minutes of silence at the deadline. That is INSIDE offline_after_seconds (180 s at
        // the seeded heartbeat_seconds = 60), so at the deadline the box was still reachable by
        // the same definition the Devices page and the alert use.
        await AddBoxAsync(host, db, deadline.AddMinutes(-2));

        var health = CreateWorker(host);
        var sweep = CreateNoShowWorker(host);
        if (healthFirst)
        {
            await health.TickAsync(default);
            await sweep.TickAsync(default);
        }
        else
        {
            await sweep.TickAsync(default);
            await health.TickAsync(default);
        }

        return await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
    }

    /// <summary>
    /// The defect this class was rewritten to close. Identical facts settled at two different
    /// prices depending on how promptly the sweep ran: on time the 30% was charged, five minutes
    /// late it was waived, because by then <c>PeripheralHealthWorker</c> had written an outage row
    /// whose <c>StartedAt</c> reached back over the deadline and covered it retroactively.
    ///
    /// <para>
    /// Four runs: prompt and late, and each with the two workers in both orders. All four must
    /// agree, and they must agree on the answer the evidence at the deadline gives — two minutes
    /// of silence is not an outage, so the penalty stands.
    /// </para>
    /// </summary>
    [Fact]
    public async Task The_waiver_is_the_same_whichever_order_the_two_workers_run_in()
    {
        var promptHealthFirst = await SweptBalanceAsync(deadlineMinutesAgo: 0, healthFirst: true);
        var promptSweepFirst = await SweptBalanceAsync(deadlineMinutesAgo: 0, healthFirst: false);
        var lateHealthFirst = await SweptBalanceAsync(deadlineMinutesAgo: 5, healthFirst: true);
        var lateSweepFirst = await SweptBalanceAsync(deadlineMinutesAgo: 5, healthFirst: false);

        Assert.Equal(promptHealthFirst, promptSweepFirst);
        Assert.Equal(promptHealthFirst, lateHealthFirst);
        Assert.Equal(promptHealthFirst, lateSweepFirst);

        // Consistent AND right: 30% of 8 retained, because the box was inside its threshold at
        // the instant that decides it.
        Assert.Equal(97.60m, promptHealthFirst);
    }

    /// <summary>
    /// The other half of the same property. A box silent well past the threshold at the deadline
    /// waives the penalty even if <c>PeripheralHealthWorker</c> has never run and no
    /// <see cref="DeviceOutage"/> row exists — the evidence is the last heartbeat, not the row.
    /// Without this the sweep charges whoever it reaches first and waives for whoever it reaches
    /// after the health tick.
    /// </summary>
    [Fact]
    public async Task A_box_past_the_threshold_at_the_deadline_waives_before_any_outage_row_exists()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // Dark since half an hour before the booking even started, and nothing has noticed.
        await AddBoxAsync(host, db, booking.StartsAt.AddMinutes(-30));
        Assert.Empty(await db.DeviceOutages.IgnoreQueryFilters().ToListAsync());

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.DoesNotContain(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync(),
            l => l.Type == LedgerEntryType.NoShowPenalty);
    }

    /// <summary>
    /// The same club, the same booking, the same ten minutes of darkness across its grace
    /// deadline — and the three things that can happen afterwards, in every order they can
    /// happen in. <paramref name="order"/> is read left to right:
    /// <c>R</c> the box calls in again, <c>H</c> a <c>PeripheralHealthWorker</c> tick,
    /// <c>S</c> the no-show sweep. Returns what the member is left with.
    /// </summary>
    private static async Task<decimal> DarkThenRecoveredBalanceAsync(string order)
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var settings = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        var offlineAfter = HeartbeatCadence.OfflineAfterSeconds(settings.HeartbeatSeconds);

        // The deadline is five minutes ago, so the booking is unambiguously due whichever
        // instant the sweep reads for itself.
        var deadline = DateTimeOffset.UtcNow.AddMinutes(-5).AddSeconds(-1);
        var startsAt = deadline.AddMinutes(-settings.GraceWindowMinutes);

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db, startsAt: startsAt);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // Dark from ten minutes before the deadline — well past offline_after_seconds — and
        // back one minute after it.
        var box = await AddBoxAsync(host, db, deadline.AddMinutes(-10));
        var health = CreateWorker(host);
        var sweep = CreateNoShowWorker(host);

        foreach (var step in order)
        {
            switch (step)
            {
                case 'R':
                    // Exactly what the heartbeat endpoint does when the box calls in.
                    DeviceSilenceLog.NoteHeartbeat(db, box, deadline.AddMinutes(1), offlineAfter);
                    await db.SaveChangesAsync();
                    break;
                case 'H': await health.TickAsync(default); break;
                default: await sweep.TickAsync(default); break;
            }
        }

        return await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
    }

    /// <summary>
    /// The mirror of <c>The_waiver_is_the_same_whichever_order_the_two_workers_run_in</c>, and
    /// the half that was still open. A box dark across the deadline and back a minute later
    /// left no evidence at all when the health sweep's thirty-second stride missed it: no row
    /// was ever opened, and the recovery heartbeat overwrote <c>LastSeenAt</c>, the only other
    /// witness. The sweep then charged 30% if it ran after the box came back and waived if it
    /// ran before — the club power cut, priced two ways.
    ///
    /// <para>
    /// Five orders, one price. The waiver is right in all of them: the box was ten minutes
    /// silent at the instant that decides it, so the member could not have scanned.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData("HSR")]   // noticed while dark, swept, then back
    [InlineData("SHR")]   // swept while dark
    [InlineData("RHS")]   // back before anything noticed, then swept
    [InlineData("RSH")]   // back, swept, and only then a health tick
    [InlineData("HRS")]   // a row opened, the box back, and the sweep beats the closing tick
    public async Task The_waiver_is_the_same_whether_the_box_came_back_before_or_after_the_sweep(string order)
        => Assert.Equal(100, await DarkThenRecoveredBalanceAsync(order));

    /// <summary>
    /// A box that was dark, came back well BEFORE the booking's grace deadline, and has been
    /// heart-beating on schedule ever since. <paramref name="closingTickRan"/> says whether
    /// <c>PeripheralHealthWorker</c> has got round to closing the row it opened.
    /// </summary>
    private static async Task<decimal> RecoveredBeforeDeadlineBalanceAsync(bool closingTickRan)
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var settings = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        var offlineAfter = HeartbeatCadence.OfflineAfterSeconds(settings.HeartbeatSeconds);

        var now = DateTimeOffset.UtcNow;
        var deadline = now.AddMinutes(-6).AddSeconds(-1);

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(
            host, db, startsAt: deadline.AddMinutes(-settings.GraceWindowMinutes));
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // Dark since twenty minutes ago; the health sweep notices and opens its row.
        var box = await AddBoxAsync(host, db, now.AddMinutes(-20));
        var health = CreateWorker(host);
        await health.TickAsync(default);

        // Back eight minutes ago — two minutes before the deadline — and calling in every
        // minute since, which is what the club's heartbeat_seconds asks of it.
        for (var beat = now.AddMinutes(-8); beat <= now.AddSeconds(-30); beat = beat.AddMinutes(1))
        {
            DeviceSilenceLog.NoteHeartbeat(db, box, beat, offlineAfter);
            await db.SaveChangesAsync();
        }

        if (closingTickRan) await health.TickAsync(default);
        await CreateNoShowWorker(host).TickAsync(default);

        return await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
    }

    /// <summary>
    /// The other way the health sweep's schedule reached the money. Its row is opened at the
    /// last heartbeat before the silence and closed at whatever <c>LastSeenAt</c> says when a
    /// tick gets to it — so a row it has not reached is open-ended, and one it reaches two
    /// heartbeats late is stamped two heartbeats late. Either way the row claimed the box was
    /// still dark at a deadline it had been back for two minutes before, and waived a penalty
    /// the member owed.
    ///
    /// <para>
    /// Both runs must be 97.60: the box was heard from a minute before the deadline, which is
    /// inside <c>offline_after_seconds</c> — reachable to the Devices page, to the alert and
    /// therefore to the money.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_box_back_before_the_deadline_pays_the_penalty_whether_or_not_the_row_was_closed()
    {
        var closed = await RecoveredBeforeDeadlineBalanceAsync(closingTickRan: true);
        var stillOpen = await RecoveredBeforeDeadlineBalanceAsync(closingTickRan: false);

        Assert.Equal(closed, stillOpen);
        Assert.Equal(97.60m, closed);
    }

    /// <summary>
    /// The retired-box shape with the admin's tidying DONE: the replacement is healthy, the
    /// row beside it is switched off, and the member simply did not turn up.
    ///
    /// <para>
    /// <b>This test does not discriminate <c>Enabled</c>, and it used to be cited as though it
    /// did.</b> Once <c>CourtWasDark</c> came to require every box on the court to be dark, the
    /// healthy replacement alone decides the outcome here, so flipping this fixture's
    /// <c>enabled: false</c> to <c>true</c> changes nothing and the test becomes a duplicate of
    /// <see cref="A_stale_but_enabled_box_beside_a_healthy_one_does_not_waive_the_penalty"/>.
    /// What it still says is worth saying — the settlement is the same whether or not the admin
    /// tidied up — but the filter itself is pinned by
    /// <see cref="A_disabled_box_heard_from_seconds_ago_does_not_block_the_waiver"/>, which is
    /// the only shape where <c>Enabled</c> moves money.
    /// </para>
    ///
    /// <para>
    /// <b>And it was not carried by the replacement at all until the replacement was given an
    /// install date.</b> The claim above — "the healthy replacement alone decides the outcome
    /// here" — was false as written: <c>AddBoxAsync</c> defaults <c>CreatedAt</c> to now, so the
    /// replacement had not existed at a deadline fifty-five minutes old and was skipped by the
    /// existence rule. The test passed because NO box voted, which under the rule of the day
    /// meant "not dark". It went red the moment a court whose only surviving hardware is
    /// switched off became dark, which is what a fixture that is green for the wrong reason does
    /// eventually. The replacement now carries the same thirty-day <c>installedAt</c> its
    /// sibling above already carried, and the test asserts what its name says.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_decommissioned_box_left_in_the_table_does_not_waive_the_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // The box that actually drives the court, heart-beating normally — and installed a
        // month ago, so it can speak for a deadline that closed an hour before this fixture ran.
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20),
            installedAt: DateTimeOffset.UtcNow.AddDays(-30));

        // The one it replaced: switched off, silent for three days, still on the same court,
        // and carrying an outage row nobody ever closed.
        var retired = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddDays(-3), enabled: false);
        await AddOutageAsync(host, db, retired, booking.StartsAt.AddDays(-3), endedAt: null);

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(97.60m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.Contains(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync(),
            l => l.Type == LedgerEntryType.NoShowPenalty);
    }

    /// <summary>
    /// <b>The pin on <c>d.Enabled</c> in <c>DeviceOutageIndex.BuildAsync</c>, and the only
    /// shape in which that filter moves money.</b>
    ///
    /// <para>
    /// Every box the club expects to hear from on this court is dark across the deadline, and a
    /// box an admin switched off was heard from twenty seconds ago — the spare on the bench, or
    /// the replacement plugged in and not yet configured. A disabled box is not expected to call
    /// in and is not evidence that the court was lit, so the member still gets S5a: refunded in
    /// full, <c>Owed(b) = 0</c>. Drop the filter and that same bench spare is read as a live box
    /// on the court, the court stops being dark, and the member pays 30% for a court that had no
    /// working hardware on it.
    /// </para>
    ///
    /// <para>
    /// It is the mirror of <see cref="A_stale_but_enabled_box_beside_a_healthy_one_does_not_waive_the_penalty"/>,
    /// which holds the other direction — an ENABLED box heard from recently DOES block the
    /// waiver — so between them the fixture's <c>enabled</c> flag is what decides the outcome
    /// and not the fixture's luck: flip this one to <c>enabled: true</c> and it goes red.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_disabled_box_heard_from_seconds_ago_does_not_block_the_waiver()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // The box that actually drives the court, dark right across the grace window.
        var live = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90));
        await AddOutageAsync(host, db, live, booking.StartsAt.AddMinutes(-10), endedAt: null);

        // Switched off, on the same court, and heard from twenty seconds ago.
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20), enabled: false);

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.DoesNotContain(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync(),
            l => l.Type == LedgerEntryType.NoShowPenalty);
    }

    /// <summary>
    /// <b>Taking the LAST box off a court used to charge that court's members 30% for a door
    /// the club had shut.</b> The money half of finding M-F3, and the reason the out-of-service
    /// switch could not ship with the copy it shipped with.
    ///
    /// <para>
    /// A disabled box is refused 403 on all four <c>/api/v1/device/*</c> routes —
    /// <c>DeviceIdentity.ResolveAsync</c> on <c>!device.IsActive</c>, with
    /// <c>Device.IsActive =&gt; Enabled</c> — so once the only box on a court is switched off that
    /// court has no check-in of its own left: the box admits nobody, is no longer sent the roster
    /// that says which bookings it may open, and can never report anyone who played. (It is the
    /// BOX that is shut, not the court: the shared courtside terminal's own
    /// <c>/api/v1/court/{n}/…</c> PIN, QR and biometric routes never resolve a device row and are
    /// not refused. This comment said otherwise for two rounds; why the waiver survives that
    /// correction is argued in <c>settlement-model.md</c> S5a.) The sweep nevertheless read the
    /// court as "no enabled box, therefore no evidence, therefore not dark" and settled the
    /// booking as an ordinary no-show: refunded, less the full 30%.
    /// </para>
    ///
    /// <para>
    /// This fixture is the one an independent verifier proved it with, and the assertion is the
    /// inverse of what it used to make: <c>Assert.Contains(… NoShowPenalty)</c> passed here
    /// before the fix. Mutate <c>CourtWasDark</c>'s final clause back to <c>return false</c> and
    /// this goes red at 97.60.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_court_whose_only_box_is_out_of_service_waives_the_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // The only box on the court, switched off by an admin and installed long enough ago to
        // speak for this deadline.
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90), enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddDays(-30), outOfServiceSince: DateTimeOffset.UtcNow);

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.DoesNotContain(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync(),
            l => l.Type == LedgerEntryType.NoShowPenalty);
    }

    /// <summary>
    /// <b>The same court and the same switched-off box as the test above, with the one field
    /// varied that decides it: how long ago the club last heard from that box.</b>
    ///
    /// <para>
    /// This test used to assert the opposite, under the name
    /// <c>A_court_whose_only_box_was_just_switched_off_waives_the_penalty_too</c>, and it was the
    /// fixture that baked a money defect in rather than the one that caught it. Its reasoning was
    /// that the API refuses a disabled box "from the moment the switch is thrown", so the switch
    /// alone makes the court dark and heartbeats have nothing to do with it. The half it left out
    /// is that <c>Enabled</c> carries no history. The moment the switch is thrown is recorded in
    /// no column, so "dark because the switch is thrown" was read by the code as "dark for as far
    /// back as this board has existed": a board that ran perfectly for thirty days and was
    /// switched off five minutes ago retroactively waived every unsettled deadline in the
    /// lookback window, and the club lost penalty revenue it was owed on courts that were working
    /// when the member failed to turn up. Any sweep landing after the click settled them — a
    /// restart, a deploy, a backlog, or simply the next thirty-second tick.
    /// </para>
    ///
    /// <para>
    /// <b>That paragraph then argued <c>LastSeenAt</c> was as good as a switch-off column, and
    /// that was the next thing to be wrong.</b> The two instants are not the same: the switch
    /// lands after the board's last heartbeat, and a deadline in the gap is priced differently by
    /// the two readings. There is now a column — <see cref="Device.OutOfServiceSince"/>, stamped
    /// where the transition happens — and this fixture carries it: the board called in twenty
    /// seconds ago, the switch was thrown now, and the deadline is fifty-five minutes old, so it
    /// is judged by exactly the silence test an enabled board gets and the club had a working
    /// door on that court when the member did not turn up. 97.60, penalty charged. The window the
    /// column decides is pinned separately, by
    /// <see cref="A_court_is_out_of_service_from_the_instant_the_switch_was_thrown"/>.
    /// </para>
    ///
    /// <para>
    /// <b>Two rules can carry this fixture and only one of them is the point</b>, so read it with
    /// the theory below rather than alone. Drop the thirty-day <c>installedAt</c> and it still
    /// passes — on the existence floor, because the board would then not have existed at the
    /// deadline either. The theory below holds <c>installedAt</c> at thirty days in both rows, so
    /// the floor cannot answer it and only the silence bound can.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_court_whose_only_box_was_just_switched_off_still_charges_the_older_deadline()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20), enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddDays(-30), outOfServiceSince: DateTimeOffset.UtcNow);

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(97.60m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.Contains(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync(),
            l => l.Type == LedgerEntryType.NoShowPenalty);
    }

    /// <summary>
    /// <b>The pin the out-of-service clause did not have: one fixture, one field, and the field
    /// is when the board went quiet.</b>
    ///
    /// <para>
    /// Everything else is held identical — the same court, the same single board, switched off
    /// now, installed thirty days before the deadline, the same booking whose grace window closed
    /// fifty-five minutes ago. Only <c>LastSeenAt</c> moves. Both rows sit BEFORE the recorded
    /// switch-off instant, so both are judged by the silence test an enabled board gets, which is
    /// the whole point: the click must not re-price either of them. Ninety minutes of silence at
    /// the deadline is past <c>offline_after_seconds</c>, so the door was already shut and the
    /// member owes nothing; one minute of silence is inside it, so the board was in service and
    /// the member owes the 30%.
    /// </para>
    ///
    /// <para>
    /// <b>This theory says nothing about deadlines AFTER the switch</b>, which is where the next
    /// defect lived: both its rows are 55 minutes old against a switch thrown now, and the window
    /// that was wrong is the three minutes immediately after the click. See
    /// <see cref="A_court_is_out_of_service_from_the_instant_the_switch_was_thrown"/>.
    /// </para>
    ///
    /// <para>
    /// Nothing in the suite varied this field before, which is exactly how the regression got in:
    /// the R8 pin beside it in `settlement-model.md` varied <c>installedAt</c> — a board CREATED
    /// after the deadline — and was listed against a sentence about a board SWITCHED OFF after
    /// it. Two different facts, one of them unpinned.
    /// </para>
    ///
    /// <para>
    /// <b>What this theory does NOT discriminate, measured rather than assumed.</b> Flip its
    /// <c>enabled: false</c> to true and both rows still pass: an enabled board silent for ninety
    /// minutes is dark by the ordinary rule, and one heard from a minute ago is reachable by it,
    /// so the theory pins the silence arithmetic without proving which branch answered. That the
    /// out-of-service branch is the one carrying it is proved by mutation instead — delete the
    /// branch and the <c>-90</c> row goes red — and by
    /// <see cref="A_disabled_box_heard_from_seconds_ago_does_not_block_the_waiver"/>, which is
    /// where <c>Enabled</c> itself moves money.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(-90, 100.00)]
    [InlineData(-1, 97.60)]
    public async Task A_switch_off_darkens_only_the_deadlines_the_board_had_already_gone_quiet_for(
        int lastSeenMinutes, int expectedBalance)
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(lastSeenMinutes), enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddDays(-30), outOfServiceSince: DateTimeOffset.UtcNow);

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(expectedBalance, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        var rows = await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync();
        Assert.Equal(expectedBalance == 97.60m, rows.Any(l => l.Type == LedgerEntryType.NoShowPenalty));
    }

    /// <summary>
    /// The hardened form an independent verifier used to prove the regression: the board was
    /// heard from on BOTH sides of the deadline, so no reading of the evidence puts it out of
    /// service then.
    ///
    /// <para>
    /// A recorded silence five days long that ended four hours before the deadline, and a
    /// heartbeat twenty seconds ago. The board was demonstrably talking to the API before the
    /// deadline and after it; it has since been switched off. The penalty stands.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_switched_off_board_heard_from_on_both_sides_of_the_deadline_does_not_waive_it()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20), enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddDays(-30), outOfServiceSince: DateTimeOffset.UtcNow);
        await AddOutageAsync(host, db, box,
            DateTimeOffset.UtcNow.AddDays(-5), endedAt: DateTimeOffset.UtcNow.AddHours(-4));

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(97.60m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.Contains(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync(),
            l => l.Type == LedgerEntryType.NoShowPenalty);
    }

    /// <summary>
    /// The other direction of the same rule, and the one that protects the member: a switch-off
    /// must not DESTROY the evidence of a real outage either.
    ///
    /// <para>
    /// The board was dark right across the deadline — a recorded silence that opened ten minutes
    /// before the booking started and did not end until half an hour ago — and an admin has since
    /// taken it out of service, which is exactly what an admin does about a box that has stopped
    /// answering. Bounding the out-of-service clause by the board's own silence must keep that
    /// waiver, or the fix for the regression would have created its own: a member locked out by a
    /// genuine outage would lose the waiver the moment the club acted on the outage.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_board_dark_across_the_deadline_still_waives_it_after_an_admin_switches_it_off()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-30), enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddDays(-30), outOfServiceSince: DateTimeOffset.UtcNow);
        await AddOutageAsync(host, db, box,
            booking.StartsAt.AddMinutes(-10), endedAt: DateTimeOffset.UtcNow.AddMinutes(-30));

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.DoesNotContain(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync(),
            l => l.Type == LedgerEntryType.NoShowPenalty);
    }

    /// <summary>
    /// The board that was installed long before the deadline and has never once called in — the
    /// case the silence bound must not swallow.
    ///
    /// <para>
    /// There is no heartbeat to measure a silence from, so the arithmetic that judges every other
    /// board has nothing to work with; the honest reading is that this board was never in service
    /// at all, and its court has had no working door since the row appeared. Left unhandled it
    /// would read as "not silent, therefore reachable, therefore the court was lit", which is the
    /// same shape of wrong answer the existence floor exists to prevent, in the other direction.
    /// It differs from
    /// <see cref="A_box_switched_off_after_the_deadline_does_not_make_its_court_out_of_service"/>
    /// only in the install date.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_board_installed_before_the_deadline_and_never_heard_from_waives_the_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        await AddBoxAsync(host, db, lastSeen: null, enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddDays(-30), outOfServiceSince: DateTimeOffset.UtcNow);

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.DoesNotContain(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync(),
            l => l.Type == LedgerEntryType.NoShowPenalty);
    }

    /// <summary>
    /// <b>Standard 4 on the out-of-service waiver: what the member is actually told.</b>
    ///
    /// <para>
    /// The outage notice promises "the box uploads its record when it reconnects and the booking
    /// settles as attended". For a board an admin has taken out of service that promise cannot be
    /// kept — the API answers 403 on all four <c>/api/v1/device/*</c> routes, <c>/events</c>
    /// included, so nothing it holds will ever arrive and the refund is final. A member who did play and
    /// who sits waiting for the reversal that sentence describes is being told to wait for
    /// something that is not coming, which is the same class of defect as a false sentence.
    /// </para>
    ///
    /// <para>
    /// So the waiver mail names the state it was sent for. Break either branch and this goes red:
    /// the out-of-service mail must say the box is out of service and that the refund is final,
    /// and must not repeat the reconnect promise.
    /// </para>
    /// </summary>
    [Fact]
    public async Task The_out_of_service_waiver_mail_does_not_promise_a_box_that_will_never_reconnect()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90), enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddDays(-30), outOfServiceSince: DateTimeOffset.UtcNow);
        host.EmailService.Clear();

        await CreateNoShowWorker(host).TickAsync(default);

        var notice = Assert.Single(host.EmailService.Sent, m => m.To == host.PlayerUser.Email);
        Assert.Contains("out of service", notice.Subject, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("out of service", notice.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("this refund is final", notice.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("when it reconnects", notice.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("no-show", notice.HtmlBody, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// The mirror of the test above, so the two branches discriminate rather than one of them
    /// simply being reachable: a court whose ENABLED box was dark still gets the outage notice,
    /// with the reconnect promise intact, because that box can and does come back.
    /// </summary>
    [Fact]
    public async Task The_outage_waiver_mail_still_promises_the_upload_for_a_box_that_can_come_back()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90),
            installedAt: DateTimeOffset.UtcNow.AddDays(-30));
        await AddOutageAsync(host, db, box, booking.StartsAt.AddMinutes(-10), endedAt: null);
        host.EmailService.Clear();

        await CreateNoShowWorker(host).TickAsync(default);

        var notice = Assert.Single(host.EmailService.Sent, m => m.To == host.PlayerUser.Email);
        Assert.Contains("offline", notice.Subject, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("when it reconnects", notice.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("out of service", notice.HtmlBody, StringComparison.OrdinalIgnoreCase);

        // The figure the worker passed, for the same reason as its twin above: substituting a
        // constant at the CALL SITE left every other assertion in this file green. Both branches
        // need it, because they are two separate call sites into two separate templates.
        var refund = Assert.Single(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id && l.Type == LedgerEntryType.CancellationRefund)
            .ToListAsync());
        Assert.Equal(8, refund.AmountMinutes);
        Assert.Contains(refund.AmountMinutes.ToString("0.00", CultureInfo.InvariantCulture), notice.HtmlBody);
        Assert.Contains(host.Courts[0].Name, notice.HtmlBody);
    }

    /// <summary>
    /// The boundary the two tests above must not cross: a court the club has put <b>no box on
    /// at all</b> is still not dark, even while a switched-off box sits on another court.
    ///
    /// <para>
    /// S5a's reasoning is unchanged here — reading "no reachable box" literally at a club that
    /// has not installed hardware yet would waive every no-show it ever books. What the new
    /// clause reads is a court whose own relays are driven by a board the API now refuses, and
    /// this fixture proves it is keyed by the courts the board actually drives rather than by
    /// the mere existence of a disabled row somewhere in the club.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_court_with_no_box_of_its_own_pays_the_penalty_even_beside_an_out_of_service_box()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // Switched off, installed long ago — but on the annex court, forty numbers away.
        var elsewhere = host.Courts[0].CourtNumber + 40;
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90), false,
            DateTimeOffset.UtcNow.AddDays(-30), DateTimeOffset.UtcNow, elsewhere);

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(97.60m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.Contains(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync(),
            l => l.Type == LedgerEntryType.NoShowPenalty);
    }

    /// <summary>
    /// The existence floor, applied to a switched-off board for the same reason it is applied to
    /// an enabled one — and it is needed harder here, because <c>Enabled</c> carries no history.
    ///
    /// <para>
    /// A board switched off this afternoon looks, in the table, exactly like one that was off
    /// all week. Without a floor, registering a board on a court and switching it off would
    /// retroactively declare that court out of service at deadlines it did not exist at, and the
    /// sweep would waive penalties for bookings that were settled on real, working hardware.
    /// This board arrived after the deadline and has never heart-beat: it is the replacement an
    /// admin plugs in and immediately parks, and it says nothing about the hour before it
    /// appeared.
    /// </para>
    ///
    /// <para>
    /// The mirror of <see cref="A_court_whose_only_box_is_out_of_service_waives_the_penalty"/>,
    /// from which it differs only in the board's install date: move <c>installedAt</c> back
    /// thirty days and this test goes green at 100.00 instead.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_box_switched_off_after_the_deadline_does_not_make_its_court_out_of_service()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // Registered a minute ago, never heard from, already switched off. The booking's grace
        // window closed fifty-five minutes before this row existed.
        await AddBoxAsync(host, db, lastSeen: null, enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddMinutes(-1), outOfServiceSince: DateTimeOffset.UtcNow);

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(97.60m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.Contains(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync(),
            l => l.Type == LedgerEntryType.NoShowPenalty);
    }

    /// <summary>
    /// The same leak with the admin's one act of tidying left undone, which is the case the
    /// disabled test above does NOT cover. A replaced box that nobody switched off is silent
    /// forever, so it is past the threshold at every deadline there will ever be; if one dark
    /// box on the court were enough, every no-show on those courts would be waived for as long
    /// as the row sat in the table. §6a says the waiver belongs to a booking whose court had
    /// <b>no reachable box</b> at the deadline — and the live box beside it was reachable.
    /// </summary>
    [Fact]
    public async Task A_stale_but_enabled_box_beside_a_healthy_one_does_not_waive_the_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // The box that actually drives the court, heart-beating normally — and installed a
        // month ago, which is a separate fact from "last seen twenty seconds ago" and is now
        // load-bearing: a board cannot vote on a deadline it did not exist at, so leaving
        // CreatedAt at its default said this replacement arrived twenty seconds ago and could
        // not speak for a grace window that closed an hour before it.
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20),
            installedAt: DateTimeOffset.UtcNow.AddDays(-30));

        // The one it replaced — still ENABLED, because nobody switched it off — silent for
        // three days, on the same court, carrying an outage row nobody ever closed.
        var stale = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddDays(-3), enabled: true);
        await AddOutageAsync(host, db, stale, booking.StartsAt.AddDays(-3), endedAt: null);

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(97.60m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.Contains(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync(),
            l => l.Type == LedgerEntryType.NoShowPenalty);
    }

    /// <summary>
    /// <b>A board that did not exist at the deadline does not get to vote on it — and until it
    /// could not, auto-registration was quietly transferring the club's outage back onto its
    /// members.</b>
    ///
    /// <para>
    /// <c>DeviceRegistryService.AutoRegisterAsync</c> puts any unknown MAC straight onto the
    /// club's first four courts with <c>Enabled</c> defaulting true — that is the whole of
    /// provisioning, and it is what makes a box useful the moment it is switched on. Once S5a
    /// came to require EVERY box on a court to be dark, that default acquired a second meaning
    /// nobody chose: ONE healthy unconfigured board vetoed the §6a waiver on courts 1–4. The
    /// spare on the desk, or the replacement an admin plugs in while the dead one is still in
    /// the cupboard, and every member whose court was dark pays 30% for the club's own hardware.
    /// The old rule could only ever ADD waivers with an extra board; the all-boxes rule made an
    /// extra board able to remove them.
    /// </para>
    ///
    /// <para>
    /// The board here is created through the real auto-registration path, so the fixture cannot
    /// drift from what a board actually gets when it announces itself.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_board_that_appeared_after_the_deadline_does_not_block_the_waiver()
    {
        Assert.Equal(100, await SpareBoardBalanceAsync(installedAt: null));
    }

    /// <summary>
    /// The other direction, and the reason the rule is about existence rather than about being
    /// auto-registered: the same unconfigured board, on the same courts, heard from at the same
    /// instant — but already there when the grace window closed. It could have lit the court,
    /// so it blocks the waiver and the member owes the penalty.
    ///
    /// <para>
    /// Only the board's install date differs between this test and the one above. That is what
    /// makes the pair a pin on the rule and not on the fixture.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_board_already_installed_at_the_deadline_still_blocks_the_waiver()
    {
        Assert.Equal(97.60m, await SpareBoardBalanceAsync(installedAt: DateTimeOffset.UtcNow.AddDays(-7)));
    }

    /// <summary>
    /// A court whose own box is dark right across the grace window, plus one auto-registered
    /// board that is perfectly healthy, and the member's balance afterwards.
    /// </summary>
    private static async Task<decimal> SpareBoardBalanceAsync(DateTimeOffset? installedAt)
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // The court's own box, installed long ago and dark across the whole window.
        var live = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90),
            installedAt: DateTimeOffset.UtcNow.AddDays(-30));
        await AddOutageAsync(host, db, live, booking.StartsAt.AddMinutes(-10), endedAt: null);

        // An unknown MAC announces itself and lands on the club's first four courts, enabled,
        // with nobody having confirmed that it drives any of them.
        var spare = await scope.ServiceProvider.GetRequiredService<DeviceRegistryService>()
            .AutoRegisterAsync("5ccf7f9e9e9e", DeviceKind.CourtBox, default);
        Assert.Contains(host.Courts[0].CourtNumber, spare.CourtNumbers);
        Assert.True(spare.Enabled);
        spare.LastSeenAt = DateTimeOffset.UtcNow.AddSeconds(-20);
        if (installedAt is { } when) spare.CreatedAt = when;
        await db.SaveChangesAsync();

        await CreateNoShowWorker(host).TickAsync(default);

        return await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
    }

    /// <summary>
    /// The other side of the same rule, so the fix cannot be "never waive when two boxes share
    /// a court". Both boxes on the court are dark at the deadline — there is genuinely no
    /// reachable box — and S5a still refunds in full with no penalty.
    /// </summary>
    [Fact]
    public async Task Two_boxes_on_one_court_both_dark_still_waives_the_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var first = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90));
        await AddOutageAsync(host, db, first, booking.StartsAt.AddMinutes(-10), endedAt: null);
        var second = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90));
        await AddOutageAsync(host, db, second, booking.StartsAt.AddMinutes(-10), endedAt: null);

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.DoesNotContain(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync(),
            l => l.Type == LedgerEntryType.NoShowPenalty);
    }

    // ----- the switch-off instant ------------------------------------------------------

    /// <summary>
    /// One booking, one board, one court, and the only thing that moves is <b>when the admin
    /// threw the switch</b> relative to the grace deadline. Both rows sit inside the window
    /// where the board's own silence says "reachable", so the silence rule cannot answer either
    /// of them and only the recorded switch-off instant can.
    ///
    /// <para>
    /// <b>Why this window is money.</b> The board last called in two minutes ago and the
    /// deadline fell one minute ago — sixty seconds of silence, well inside
    /// <c>offline_after_seconds</c> (180 s at the shipped default). The rule this replaces
    /// bounded the out-of-service branch at that threshold, so a court an admin had switched off
    /// read <b>Lit</b> for up to three minutes after the click while the board itself already
    /// answered 403 on all four of its own routes. A member at that court could not check in at
    /// the box by any means, and was charged the full 30% and mailed the
    /// plain "Missed booking" notice for it — the exact direction <c>feature-spec.md</c> §6a
    /// exists to prevent, and proved end to end on a live stack before this test existed.
    /// </para>
    ///
    /// <para>
    /// <b>Why the obvious alternative is not the fix, measured rather than argued.</b> Bounding
    /// the branch at <c>LastSeenAt</c> exactly closes the same window and reopens the one round
    /// 9 shut: the second row here is a deadline that had ALREADY PASSED when the switch was
    /// thrown, and under that rule it flips from a 2.40 penalty to a full waiver on the click
    /// alone. That is <c>settlement-model.md</c> S5a's "the switch itself does not reach
    /// backwards", 180 seconds wide instead of seven days. It was run: with the exact-LastSeenAt
    /// bound in place this fixture's second row paid 100.00 instead of 97.60 and the whole
    /// backend suite stayed green, 1008 passed, 0 failed — which is why the fix is a recorded
    /// instant and not a different threshold.
    /// </para>
    ///
    /// <para>
    /// <b>The fixture variation that says which rule is answering.</b> Flip <c>enabled</c> to
    /// true on both rows and both pay the penalty (97.60), because sixty seconds of silence is
    /// reachable by the ordinary rule — so the waiver in the first row is carried by the
    /// out-of-service branch and by nothing else. Run, not assumed.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(-90, 100.00)]
    [InlineData(-30, 97.60)]
    public async Task A_court_is_out_of_service_from_the_instant_the_switch_was_thrown(
        int switchedOffSecondsAgo, int expectedBalance)
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var now = DateTimeOffset.UtcNow;

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);

        // Grace is 5 minutes, so the deadline is 60 seconds ago.
        var booking = await AddDueBookingAsync(host, db, startsAt: now.AddMinutes(-6));
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        await AddBoxAsync(host, db, now.AddMinutes(-2), enabled: false,
            installedAt: now.AddDays(-30), outOfServiceSince: now.AddSeconds(switchedOffSecondsAgo));

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(expectedBalance, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        var rows = await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync();
        Assert.Equal(expectedBalance == 97.60m, rows.Any(l => l.Type == LedgerEntryType.NoShowPenalty));
    }

    /// <summary>
    /// The same fixture as the theory above, read for the <b>mail</b> rather than the ledger,
    /// because the two halves of §6a.3 failed together: the member inside the window was mailed
    /// the plain no-show notice for a court the club had shut a minute earlier.
    /// </summary>
    [Fact]
    public async Task The_member_inside_that_window_gets_the_waiver_mail_and_not_the_no_show_notice()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var now = DateTimeOffset.UtcNow;

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db, startsAt: now.AddMinutes(-6));
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        await AddBoxAsync(host, db, now.AddMinutes(-2), enabled: false,
            installedAt: now.AddDays(-30), outOfServiceSince: now.AddSeconds(-90));
        host.EmailService.Clear();

        await CreateNoShowWorker(host).TickAsync(default);

        var notice = Assert.Single(host.EmailService.Sent, m => m.To == host.PlayerUser.Email);
        Assert.Contains("out of service", notice.Subject, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Missed booking", notice.Subject, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// A switched-off row carrying no recorded instant falls back to its silence alone — which
    /// is exactly what shipped before the column existed, and is the conservative direction: the
    /// club's own evidence decides and no click moves anything behind it.
    ///
    /// <para>
    /// It exists for rows a fixture, a seed or a restore disabled without going through
    /// <c>DeviceRegistryService.UpdateAsync</c>. Named and pinned rather than left implicit,
    /// because a silent fallback is how a rule stops being tested: several tests in this file
    /// leave the instant null, and this is the test that says what that means.
    /// </para>
    ///
    /// <para>
    /// Same sixty-second window as the theory above. With no instant recorded the deadline is
    /// judged by the board's silence, which is inside the threshold, so the penalty stands.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_switched_off_row_with_no_recorded_instant_is_judged_by_its_silence_alone()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var now = DateTimeOffset.UtcNow;

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db, startsAt: now.AddMinutes(-6));
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var box = await AddBoxAsync(host, db, now.AddMinutes(-2), enabled: false, installedAt: now.AddDays(-30));
        Assert.Null(box.OutOfServiceSince);

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(97.60m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }

    /// <summary>
    /// The stamp itself, at the one place in the product that writes it: taking a board out of
    /// service through the admin service records the instant, and putting it back in service
    /// clears it. Without this the rule above is answered from a column nothing fills.
    ///
    /// <para>
    /// The clear on the way back matters as much as the stamp. A board returned to service is
    /// not out of service since anything, and leaving a stale instant behind would let a court
    /// read dark for deadlines that fell while it was working again.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Taking_a_board_out_of_service_records_the_instant_and_returning_it_clears_it()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var registry = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20));
        Assert.Null(box.OutOfServiceSince);

        var before = DateTimeOffset.UtcNow;
        await registry.UpdateAsync(box, new UpdateDeviceCommand(null, false, null), host.AdminUser.Id, default);
        var after = DateTimeOffset.UtcNow;

        var stamped = Assert.IsType<DateTimeOffset>(box.OutOfServiceSince);
        Assert.InRange(stamped, before, after);

        // An edit that does not touch the switch leaves the instant where it was.
        await registry.UpdateAsync(box, new UpdateDeviceCommand("Renamed", null, null), host.AdminUser.Id, default);
        Assert.Equal(stamped, box.OutOfServiceSince);

        // And so does a REPEAT of the switch-off itself, which is the guard
        // (`enabled != device.Enabled`) rather than the stamp. The step above cannot see it:
        // it sends `Enabled = null`, so the guard is never reached. Removing the guard leaves
        // the whole suite green while an idempotent `PATCH {"enabled": false}` on an already
        // disabled board re-stamps the instant to now — which moves every unsettled deadline
        // between the real switch-off and the repeat out of the "dark at once" branch and back
        // into the silence test, reopening the `offline_after_seconds` hole this column exists
        // to close, across the sweep's whole lookback. The console happens not to send a
        // redundant `enabled`, but the admin API is a documented surface.
        await Task.Delay(5);
        await registry.UpdateAsync(box, new UpdateDeviceCommand(null, false, null), host.AdminUser.Id, default);
        Assert.Equal(stamped, box.OutOfServiceSince);

        await registry.UpdateAsync(box, new UpdateDeviceCommand(null, true, null), host.AdminUser.Id, default);
        Assert.Null(box.OutOfServiceSince);
    }

    /// <summary>
    /// <b>The boundary the whole out-of-service rule turns on, one tick wide.</b>
    /// <c>DoorWasShutFor</c> compares <c>instant &gt; switchedOffAt</c>, strictly — so a deadline
    /// landing EXACTLY on the recorded switch-off instant is on the near side of the click and is
    /// judged by the board's own silence, and a deadline one tick later is out of service at once.
    ///
    /// <para>
    /// It is here because weakening that comparison to <c>&gt;=</c> reddened nothing: an
    /// independent verifier ran the mutation across the whole backend suite and only the
    /// pre-existing wall-clock flake failed. One instant is a small amount of money, but it is the
    /// boundary both specs state ("strictly greater-than: a deadline landing exactly on `S` is on
    /// the near side"), and an unpinned boundary is how a strictly-greater comparison quietly
    /// becomes an inclusive one.
    /// </para>
    ///
    /// <para>
    /// Both rows sit sixty seconds after the board's last heartbeat, well inside
    /// <c>offline_after_seconds</c>, so the silence test alone answers "reachable" for both and
    /// the only thing that moves the price is which side of the switch the deadline falls on.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(0, 97.60)]    // the deadline IS the switch-off instant — near side, penalty stands
    [InlineData(-1, 100.00)]  // one tick later than the switch — out of service, waived
    public async Task A_deadline_exactly_on_the_recorded_switch_off_instant_is_judged_by_the_silence_test(
        long switchTicksBeforeDeadline, int expectedBalance)
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var settings = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        var now = DateTimeOffset.UtcNow;

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);

        var booking = await AddDueBookingAsync(host, db, startsAt: now.AddMinutes(-6));
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // The instant the sweep will ask about, computed the way the sweep computes it.
        var deadline = booking.StartsAt.AddMinutes(settings.GraceWindowMinutes);

        await AddBoxAsync(host, db, now.AddMinutes(-2), enabled: false,
            installedAt: now.AddDays(-30), outOfServiceSince: deadline.AddTicks(switchTicksBeforeDeadline));

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(expectedBalance, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        var rows = await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync();
        Assert.Equal(expectedBalance == 97.60m, rows.Any(l => l.Type == LedgerEntryType.NoShowPenalty));
    }

    /// <summary>
    /// <b>A FINISHED off-period does leave a record, and <c>settlement-model.md</c> S5a argued the
    /// opposite for a round.</b> That paragraph said "putting a board back in service clears the
    /// column, and <c>PeripheralHealthWorker</c> does not alert on a disabled board, so no
    /// <c>DeviceOutage</c> row covers it either". The first half is true and the second is not:
    /// the health sweep cannot open a row for a disabled board, but the board's own RETURN writes
    /// one. <c>DeviceSilenceLog.NoteHeartbeat</c> records a closed outage whenever the first
    /// heartbeat back lands more than <c>offline_after_seconds</c> after <c>LastSeenAt</c> — and
    /// <c>LastSeenAt</c> is still the last heartbeat BEFORE the switch was thrown, because the
    /// board was refused in between.
    /// </summary>
    /// <remarks>
    /// <para>
    /// So the recorded silence is WIDER than the off-period: it starts at that last pre-switch
    /// heartbeat, not at the click. What that leaves uncovered is narrower than the spec used to
    /// claim — not "off-periods shorter than the threshold" but "deadlines less than
    /// <c>offline_after_seconds</c> after the last pre-switch heartbeat" — and the paragraph now
    /// says so. This test is what makes it a claim anything can fail on.
    /// </para>
    /// <para>
    /// The board is back IN service by the time the sweep runs, and <c>OutOfServiceSince</c> is
    /// null, so nothing in the out-of-service branch is answering here: the waiver is carried by
    /// the outage row alone. Fixture variation that says so — move the recorded silence's start to
    /// after the deadline and the member pays the 30% instead.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_finished_off_period_is_covered_by_the_outage_row_the_boards_return_writes()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var registry = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();
        var settings = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        var offlineAfter = HeartbeatCadence.OfflineAfterSeconds(settings.HeartbeatSeconds);
        var now = DateTimeOffset.UtcNow;

        // The deadline sits 55 minutes ago, inside the off-period below.
        var deadline = now.AddMinutes(-55);
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(
            host, db, startsAt: deadline.AddMinutes(-settings.GraceWindowMinutes));
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // Last heard from 70 minutes ago; the admin then takes it out of service and, later,
        // puts it back. The column carries nothing about the finished off-period afterwards.
        var box = await AddBoxAsync(host, db, now.AddMinutes(-70), installedAt: now.AddDays(-30));
        await registry.UpdateAsync(box, new UpdateDeviceCommand(null, false, null), host.AdminUser.Id, default);
        await registry.UpdateAsync(box, new UpdateDeviceCommand(null, true, null), host.AdminUser.Id, default);
        Assert.Null(box.OutOfServiceSince);
        Assert.Empty(await db.DeviceOutages.IgnoreQueryFilters().ToListAsync());

        // The board calls in again. This is the whole of the correction: the row is written now,
        // for a period during which the board was switched off, by the heartbeat that ends it.
        DeviceSilenceLog.NoteHeartbeat(db, box, now, offlineAfter);
        await db.SaveChangesAsync();

        var recorded = Assert.Single(await db.DeviceOutages.IgnoreQueryFilters().ToListAsync());
        Assert.Equal(now.AddMinutes(-70), recorded.StartedAt);
        Assert.Equal(now, recorded.EndedAt);
        Assert.True(recorded.StartedAt < deadline && deadline < recorded.EndedAt,
            "the recorded silence must span the deadline inside the finished off-period");

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.DoesNotContain(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync(),
            l => l.Type == LedgerEntryType.NoShowPenalty);
    }

    // ----- the two waiver mails, sentence by sentence ----------------------------------

    /// <summary>
    /// <b>Every sentence of the out-of-service waiver mail, pinned to the letter.</b>
    ///
    /// <para>
    /// An independent verifier broke four of this template's five sentences one at a time —
    /// including both that state the money, "Penalty: None" inverted to "Penalty: 30% of the
    /// booking" and "nothing has been deducted" to "A penalty has been deducted and you have
    /// been marked down for missing it" — and the full backend suite stayed 991/991 green. A
    /// waiver mail that tells a member they were penalised, on a booking refunded in full with
    /// no penalty, is a promise the ledger does not keep, and every one of those sentences was
    /// guarding nothing. The two branch tests below it discriminate WHICH template is sent; this
    /// one is what makes the template's own words a promise anything can fail on.
    /// </para>
    ///
    /// <para>
    /// Read as a whole rather than by keyword: the substring assertions the branch tests use
    /// ("out of service", "this refund is final") survive an inverted money line, which is
    /// exactly how the gap stayed open. The court name and the club name are asserted where they
    /// appear, so dropping either from the sentence goes red too.
    /// </para>
    ///
    /// <para>
    /// <b>Asserted on the text part, not on the markup.</b> These sentences used to be pinned as
    /// HTML fragments — <c>&gt;Refunded&lt;/td&gt;&lt;td&gt;&lt;strong&gt;8.00 credits&lt;/strong&gt;</c> — which
    /// coupled a claim about what a member is PROMISED to a claim about which tag it sits in, so
    /// restyling the mail broke it for a reason that has nothing to do with money. Both bodies
    /// are rendered from one list of blocks and a separate test proves every figure in one
    /// appears in the other, so reading the text part is the same evidence about the same
    /// sentences, with none of the coupling — and it additionally pins the half a plain-text
    /// client is served, which nothing used to.
    /// </para>
    /// </summary>
    [Fact]
    public void Every_sentence_of_the_out_of_service_waiver_mail()
    {
        var mail = EmailTemplates.BookingRefundedForOutOfServiceBox(
            WaiverClub, "player@test.local", "Court 4", 8);
        // Unwrapped: a DoesNotContain against a 72-column body passes whenever the phrase
        // it forbids happens to straddle a break. See MailText.
        var body = MailText.Unwrap(mail.PlainBody);

        Assert.Equal("Refunded — the box on Court 4 is out of service", mail.Subject);
        Assert.Contains("Your booking has been refunded in full", body);
        Assert.Contains(
            "Nobody checked in on Court 4 at Riverside Racquet Club during your booking, and the " +
            "box on that court is out of service — it could not open the court, and it will never " +
            "send the club a record of anyone who played.",
            body);

        // The claim this sentence is NOT allowed to make any more, asserted absent as well as
        // replaced. Its two predecessors both said something false about the COURT rather than
        // about the box — "No court box was answering", then "no check-in on that court could
        // have reached the club" — and the second survived a whole round pinned to the letter,
        // which made the false sentence harder to remove rather than easier. The courtside
        // terminal's PIN, QR and biometric routes never resolve a device row and are not refused,
        // so a member at a court whose every box is out of service CAN still identify; the waiver
        // is argued from what the box can no longer do (settlement-model.md S5a).
        Assert.DoesNotContain("could have reached the club", body);
        Assert.DoesNotContain("No court box was answering", body);
        Assert.Contains("Refunded: 8.00 credits", body);
        Assert.Contains("Penalty: None", body);
        Assert.Contains("You have not been marked down for missing it, and nothing has been deducted.", body);
        Assert.Contains(
            "Because that box is out of service it will not send the club anything further, so " +
            "this refund is final. If you did get onto the court, tell the desk rather than " +
            "waiting for it to correct itself.",
            body);

        // The one sentence this template exists to NOT make. S6 cannot reach a board the API
        // refuses, so a member who did play must be sent to the desk, not told to wait.
        Assert.DoesNotContain("when it reconnects", body);
        Assert.DoesNotContain("settles as played", body);
        Assert.DoesNotContain("settles as attended", body);
    }

    /// <summary>
    /// <b>Every sentence of the outage waiver mail</b>, for the same reason and to the same
    /// standard. This is the branch that CAN be undone, so its reconnect promise is load-bearing
    /// rather than decorative: S6 reverses the sweep when the box uploads what it queued.
    /// </summary>
    [Fact]
    public void Every_sentence_of_the_outage_waiver_mail()
    {
        var mail = EmailTemplates.BookingRefundedForOutage(WaiverClub, "player@test.local", "Court 4", 8);
        // Unwrapped: a DoesNotContain against a 72-column body passes whenever the phrase
        // it forbids happens to straddle a break. See MailText.
        var body = MailText.Unwrap(mail.PlainBody);

        Assert.Equal("Refunded — Court 4 was offline", mail.Subject);
        Assert.Contains("Your booking has been refunded in full", body);
        Assert.Contains(
            "The court controller at Riverside Racquet Club was offline during your booking on " +
            "Court 4, so the lights could not be released against your name.",
            body);
        Assert.Contains("Refunded: 8.00 credits", body);
        Assert.Contains("Penalty: None", body);
        Assert.Contains("You have not been marked down for missing it, and nothing has been deducted.", body);
        Assert.Contains(
            "If you did get onto the court, the box uploads its record when it reconnects and the " +
            "booking settles as played — the refund is reversed and you are charged the original " +
            "price, with no penalty either way.",
            body);

        // The sentence this one must not make: its board is still in service, so telling the
        // member the refund is final would be false in the direction that costs them a court.
        Assert.DoesNotContain("out of service", body);
        Assert.DoesNotContain("this refund is final", body);
    }

    /// <summary>
    /// The amounts in both waiver mails are the booking's, not a constant. The verifier's
    /// aggregate mutation replaced the money lines with text; asserting one fixed figure would
    /// have let a template that hard-codes "8.00 credits" pass.
    /// </summary>
    [Theory]
    [InlineData(12.5, "12.50 credits")]
    [InlineData(0, "0.00 credits")]
    public void Both_waiver_mails_quote_the_bookings_own_refund(int refunded, string rendered)
    {
        Assert.Contains(
            $"Refunded: {rendered}",
            EmailTemplates.BookingRefundedForOutOfServiceBox(WaiverClub, "a@b.c", "Court 4", refunded).PlainBody!);
        Assert.Contains(
            $"Refunded: {rendered}",
            EmailTemplates.BookingRefundedForOutage(WaiverClub, "a@b.c", "Court 4", refunded).PlainBody!);
    }

    /// <summary>The club the two waiver mails are rendered for. Deliberately not Crusaders.</summary>
    private static readonly Crusaders.Mainframe.Api.Email.ClubIdentity WaiverClub =
        new("Riverside Racquet Club", "+27 31 555 0188", "desk@riverside.review.test");

}
