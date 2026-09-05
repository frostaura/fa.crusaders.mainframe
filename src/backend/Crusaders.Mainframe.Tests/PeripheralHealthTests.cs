using Crusaders.Mainframe.Api.Domain;
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
    private static PeripheralHealthWorker CreateWorker(TestHost host) =>
        new(host.Services, host.Services.GetRequiredService<IEventBus>(), NullLogger<PeripheralHealthWorker>.Instance);

    private static NoShowWorker CreateNoShowWorker(TestHost host) =>
        new(host.Services, host.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance);

    private static List<DomainEvent> Drain(TestHost host)
    {
        var bus = host.Services.GetRequiredService<IEventBus>();
        var emitted = new List<DomainEvent>();
        while (bus.Reader.TryRead(out var evt)) emitted.Add(evt);
        return emitted;
    }

    private static async Task<Device> AddBoxAsync(
        TestHost host, MainframeDbContext db, DateTimeOffset? lastSeen, bool enabled = true, params int[] courts)
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
        host.EmailService.Sent.Clear();

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
        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-20), true, 1, 2);
        host.EmailService.Sent.Clear();

        await CreateWorker(host).TickAsync(default);

        var alert = Assert.Single(host.EmailService.Sent);
        Assert.Equal(host.AdminUser.Email, alert.To);
        Assert.True(alert.HighPriority, "§6a calls this a high-priority alert; the message must carry the header");
        Assert.Contains(box.DeviceCode, alert.Subject, StringComparison.Ordinal);
        Assert.Contains("courts 1, 2", alert.HtmlBody, StringComparison.Ordinal);
        Assert.DoesNotContain(host.PlayerUser.Email, host.EmailService.Sent.Select(m => m.To));
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
        host.EmailService.Sent.Clear();

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

    // ----- money: §6a's "auto-credited (no penalty)" -----------------------------------

    private static async Task<Booking> AddDueBookingAsync(TestHost host, MainframeDbContext db, decimal amount = 8m)
    {
        var booking = new Booking
        {
            TenantId = host.Tenant.Id,
            CourtId = host.Courts[0].Id,
            UserId = host.PlayerUser.Id,
            BookedByUserId = host.PlayerUser.Id,
            PaidByUserId = host.PlayerUser.Id,
            StartsAt = DateTimeOffset.UtcNow.AddHours(-1),
            EndsAt = DateTimeOffset.UtcNow.AddMinutes(-45),
            SliceMinutes = 15,
            SliceCount = 1,
            AmountChargedCredits = amount,
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90));
        await AddOutageAsync(host, db, box, booking.StartsAt.AddMinutes(-10), endedAt: null);
        Drain(host);
        host.EmailService.Sent.Clear();

        await CreateNoShowWorker(host).TickAsync(default);

        // Owed(b) = 0: the charge is fully back and nothing was retained.
        Assert.Equal(100m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        var rows = await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync();
        Assert.Contains(rows, l => l.Type == LedgerEntryType.CancellationRefund && l.AmountCredits == 8m);
        Assert.DoesNotContain(rows, l => l.Type == LedgerEntryType.NoShowPenalty);

        var evt = Assert.Single(Drain(host), e => e.Type == "booking.no_show");
        Assert.Equal(0m, evt.Data["penalty_credits"]);
        Assert.Equal(8m, evt.Data["refund_credits"]);
        Assert.Equal(true, evt.Data["peripheral_outage"]);

        // §6a: "players in the affected window get an email explaining the situation" — the
        // explanation, not the accusation.
        var notice = Assert.Single(host.EmailService.Sent, m => m.To == host.PlayerUser.Email);
        Assert.Contains("offline", notice.Subject, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("no-show", notice.HtmlBody, StringComparison.OrdinalIgnoreCase);
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20));
        Drain(host);

        await CreateNoShowWorker(host).TickAsync(default);

        // 30% of 8 retained.
        Assert.Equal(97.60m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        var evt = Assert.Single(Drain(host), e => e.Type == "booking.no_show");
        Assert.Equal(2.40m, evt.Data["penalty_credits"]);
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var elsewhere = host.Courts[0].CourtNumber + 40;
        var annex = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90), true, elsewhere);
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // Back online right now, and dark across the booking's grace window.
        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-10));
        await AddOutageAsync(host, db, box, booking.StartsAt.AddMinutes(-10), booking.StartsAt.AddMinutes(30));

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-10));
        await AddOutageAsync(host, db, box,
            booking.StartsAt.AddMinutes(-30),
            booking.StartsAt.AddMinutes(settings.GraceWindowMinutes - 1));

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(97.60m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }
}
