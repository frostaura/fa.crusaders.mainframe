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

    /// <summary>
    /// The alert must not open by sending an admin to the plug.
    ///
    /// <para>
    /// A box that has lost only its uplink keeps lighting courts from its cached roster and holds
    /// the scans in a RAM ring (<c>src/iot/lib/eventq/include/eventq/EventQueue.h</c>). Cutting
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
        host.EmailService.Sent.Clear();

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
        host.EmailService.Sent.Clear();

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

    private static async Task<Booking> AddDueBookingAsync(
        TestHost host, MainframeDbContext db, decimal amount = 8m, DateTimeOffset? startsAt = null)
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db, startsAt: startsAt);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // Dark since half an hour before the booking even started, and nothing has noticed.
        await AddBoxAsync(host, db, booking.StartsAt.AddMinutes(-30));
        Assert.Empty(await db.DeviceOutages.IgnoreQueryFilters().ToListAsync());

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db, startsAt: startsAt);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

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
        => Assert.Equal(100m, await DarkThenRecoveredBalanceAsync(order));

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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(
            host, db, startsAt: deadline.AddMinutes(-settings.GraceWindowMinutes));
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

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
    /// A box an admin decommissioned is not evidence of anything. It stops calling in by their
    /// own decision — the same reason <c>PeripheralHealthWorker</c> skips it — so a row left in
    /// the table beside its replacement must not waive every no-show on those courts for as
    /// long as it sits there. The live box is healthy and the member simply did not turn up.
    /// </summary>
    [Fact]
    public async Task A_decommissioned_box_left_in_the_table_does_not_waive_the_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // The box that actually drives the court, heart-beating normally.
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20));

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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // The box that actually drives the court, heart-beating normally.
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20));

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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var first = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90));
        await AddOutageAsync(host, db, first, booking.StartsAt.AddMinutes(-10), endedAt: null);
        var second = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90));
        await AddOutageAsync(host, db, second, booking.StartsAt.AddMinutes(-10), endedAt: null);

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.DoesNotContain(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.RelatedBookingId == booking.Id).ToListAsync(),
            l => l.Type == LedgerEntryType.NoShowPenalty);
    }
}
