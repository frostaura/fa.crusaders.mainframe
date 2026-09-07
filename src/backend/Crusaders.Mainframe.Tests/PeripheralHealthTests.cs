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
        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-20), true, null, 1, 2);
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // The box that actually drives the court, dark right across the grace window.
        var live = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90));
        await AddOutageAsync(host, db, live, booking.StartsAt.AddMinutes(-10), endedAt: null);

        // Switched off, on the same court, and heard from twenty seconds ago.
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20), enabled: false);

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
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
    /// A disabled box is refused 403 on every courtside endpoint —
    /// <c>DeviceIdentity.ResolveAsync</c> on <c>!device.IsActive</c>, with
    /// <c>Device.IsActive =&gt; Enabled</c> — so once the only box on a court is switched off
    /// nobody standing at that court can check in by heartbeat, activation, walk-up, PIN, QR or
    /// biometric. There is no path left. The sweep nevertheless read the court as "no enabled
    /// box, therefore no evidence, therefore not dark" and settled the booking as an ordinary
    /// no-show: refunded, less the full 30%.
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // The only box on the court, switched off by an admin and installed long enough ago to
        // speak for this deadline.
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90), enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddDays(-30));

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
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
    /// <b>What IS recorded is <c>LastSeenAt</c>, and it is not a weaker witness than a switch-off
    /// column would be.</b> A disabled box is refused 403 on every courtside endpoint, so the
    /// instant an admin throws the switch is the instant that box stops being heard from — a
    /// heartbeat at <c>T</c> is proof the board was still in service at <c>T</c>, because a
    /// board out of service cannot produce one. Here it called in twenty seconds ago and the
    /// deadline is fifty-five minutes old, so the club had a working door on that court when the
    /// member did not turn up. 97.60, penalty charged.
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20), enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddDays(-30));

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
    /// Everything else is held identical — the same court, the same single board, switched off,
    /// installed thirty days before the deadline, the same booking whose grace window closed
    /// fifty-five minutes ago. Only <c>LastSeenAt</c> moves, and it is the recorded shadow of the
    /// switch-off instant (a disabled board is refused 403, so it stops being heard from the
    /// moment the switch is thrown). Ninety minutes of silence at the deadline is past
    /// <c>offline_after_seconds</c>, so the door was already shut and the member owes nothing;
    /// one minute of silence is inside it, so the board was in service and the member owes the
    /// 30%.
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
        int lastSeenMinutes, decimal expectedBalance)
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(lastSeenMinutes), enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddDays(-30));

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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddSeconds(-20), enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddDays(-30));
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-30), enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddDays(-30));
        await AddOutageAsync(host, db, box,
            booking.StartsAt.AddMinutes(-10), endedAt: DateTimeOffset.UtcNow.AddMinutes(-30));

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        await AddBoxAsync(host, db, lastSeen: null, enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddDays(-30));

        await CreateNoShowWorker(host).TickAsync(default);

        Assert.Equal(100m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
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
    /// kept — the API answers 403 on every courtside endpoint, including <c>/device/events</c>,
    /// so nothing it holds will ever arrive and the refund is final. A member who did play and
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90), enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddDays(-30));
        host.EmailService.Sent.Clear();

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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        var box = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90),
            installedAt: DateTimeOffset.UtcNow.AddDays(-30));
        await AddOutageAsync(host, db, box, booking.StartsAt.AddMinutes(-10), endedAt: null);
        host.EmailService.Sent.Clear();

        await CreateNoShowWorker(host).TickAsync(default);

        var notice = Assert.Single(host.EmailService.Sent, m => m.To == host.PlayerUser.Email);
        Assert.Contains("offline", notice.Subject, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("when it reconnects", notice.HtmlBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("out of service", notice.HtmlBody, StringComparison.OrdinalIgnoreCase);
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // Switched off, installed long ago — but on the annex court, forty numbers away.
        var elsewhere = host.Courts[0].CourtNumber + 40;
        await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90), false,
            DateTimeOffset.UtcNow.AddDays(-30), elsewhere);

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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // Registered a minute ago, never heard from, already switched off. The booking's grace
        // window closed fifty-five minutes before this row existed.
        await AddBoxAsync(host, db, lastSeen: null, enabled: false,
            installedAt: DateTimeOffset.UtcNow.AddMinutes(-1));

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
        Assert.Equal(100m, await SpareBoardBalanceAsync(installedAt: null));
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

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var booking = await AddDueBookingAsync(host, db);
        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id, RelatedBookingId: booking.Id), default);

        // The court's own box, installed long ago and dark across the whole window.
        var live = await AddBoxAsync(host, db, DateTimeOffset.UtcNow.AddMinutes(-90),
            installedAt: DateTimeOffset.UtcNow.AddDays(-30));
        await AddOutageAsync(host, db, live, booking.StartsAt.AddMinutes(-10), endedAt: null);

        // An unknown MAC announces itself and lands on the club's first four courts, enabled,
        // with nobody having confirmed that it drives any of them.
        var spare = await scope.ServiceProvider.GetRequiredService<DeviceRegistryService>()
            .AutoRegisterAsync("5ccf7f9e9e9e", default);
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
