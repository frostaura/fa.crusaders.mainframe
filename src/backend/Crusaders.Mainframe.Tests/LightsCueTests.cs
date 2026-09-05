using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Lights;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// What turns a court's lights on, and what does not.
///
/// <para>
/// <c>LightsCueWorker</c> used to cue lights ON from a pure clock: any <c>Booked</c> row
/// whose start had passed, with no reference to attendance, payment or balance. So a court
/// lit itself for a member who never arrived, for a booking nobody had paid for, and for a
/// no-show whose credits were about to be refunded — every fifteen seconds, for every such
/// booking.
/// </para>
///
/// <para>
/// It also promoted <c>Booked → Completed</c> at end time, which raced
/// <c>NoShowWorker</c>: that worker's predicate is <c>Status == Booked</c>, so whichever
/// ran first decided whether a member was a no-show or had simply finished. The 15-second
/// tick usually won, which is how a genuine no-show quietly became a completed session.
/// </para>
/// </summary>
public class LightsCueTests
{
    private static async Task<Booking> SeedBookingAsync(
        TestHost host, IServiceScope scope, DateTimeOffset startsAt, BookingStatus status = BookingStatus.Booked,
        DateTimeOffset? checkedInAt = null)
    {
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var booking = new Booking
        {
            TenantId = host.Tenant.Id,
            CourtId = host.Courts[0].Id,
            UserId = host.PlayerUser.Id,
            BookedByUserId = host.PlayerUser.Id,
            PaidByUserId = host.PlayerUser.Id,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(15),
            SliceCount = 1,
            AmountChargedCredits = 8m,
            Status = status,
            CheckedInAt = checkedInAt,
        };

        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking;
    }

    private static LightsCueWorker WorkerFor(TestHost host) =>
        new(host.Services,
            host.Services.GetRequiredService<IEventBus>(),
            NullLogger<LightsCueWorker>.Instance);

    // ---- The defect --------------------------------------------------------

    /// <summary>
    /// The governing rule. A booking that has started and whose holder never showed up
    /// must not light the court. Nothing on a clock alone may cue lights on.
    /// </summary>
    [Fact]
    public async Task A_started_booking_with_nobody_there_does_not_light_the_court()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();

        var booking = await SeedBookingAsync(host, scope, DateTimeOffset.UtcNow.AddMinutes(-2));

        await WorkerFor(host).TickAsync(default);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Entry(booking).ReloadAsync();

        Assert.Null(booking.LightsOnCuedAt);
    }

    /// <summary>The same, stated as the absence of the event.</summary>
    [Fact]
    public async Task The_worker_emits_no_lights_on_event_at_all()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();

        await SeedBookingAsync(host, scope, DateTimeOffset.UtcNow.AddMinutes(-2));
        await WorkerFor(host).TickAsync(default);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var stillUncued = await db.Bookings.CountAsync(b => b.LightsOnCuedAt == null);

        Assert.Equal(1, stillUncued);
    }

    // ---- The off sweep, which matters more now -----------------------------

    [Fact]
    public async Task A_finished_booking_is_cued_off()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();

        var booking = await SeedBookingAsync(
            host, scope, DateTimeOffset.UtcNow.AddMinutes(-30), checkedInAt: DateTimeOffset.UtcNow.AddMinutes(-29));

        await WorkerFor(host).TickAsync(default);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Entry(booking).ReloadAsync();

        Assert.NotNull(booking.LightsOffCuedAt);
    }

    /// <summary>
    /// A no-show's lights must stop too. The sweep previously matched only Booked and
    /// Completed, and NoShowWorker sets NoShow — so a booking swept as a no-show first was
    /// never cued off. The court box's own timer would release it, but the backend would
    /// believe the lights were still on and the event stream would never say otherwise.
    /// </summary>
    [Fact]
    public async Task A_no_show_booking_is_still_cued_off()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();

        var booking = await SeedBookingAsync(
            host, scope, DateTimeOffset.UtcNow.AddMinutes(-30), status: BookingStatus.NoShow);

        await WorkerFor(host).TickAsync(default);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Entry(booking).ReloadAsync();

        Assert.NotNull(booking.LightsOffCuedAt);
        Assert.Equal(BookingStatus.NoShow, booking.Status);   // not promoted
    }

    // ---- The race with NoShowWorker ----------------------------------------

    /// <summary>
    /// An un-attended booking must NOT be promoted to Completed. Promoting it is what raced
    /// NoShowWorker out of ever seeing it, turning a genuine no-show into a completed
    /// session — and with it, silently cancelling the penalty and the refund.
    /// </summary>
    [Fact]
    public async Task An_unattended_booking_is_not_promoted_to_completed()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();

        var booking = await SeedBookingAsync(host, scope, DateTimeOffset.UtcNow.AddMinutes(-30));

        await WorkerFor(host).TickAsync(default);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Entry(booking).ReloadAsync();

        // Still Booked, so NoShowWorker's predicate can still find it.
        Assert.Equal(BookingStatus.Booked, booking.Status);
        Assert.NotNull(booking.LightsOffCuedAt);
    }

    /// <summary>An attended booking is promoted, which is the case the promotion exists for.</summary>
    [Fact]
    public async Task An_attended_booking_is_promoted_to_completed()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();

        var booking = await SeedBookingAsync(
            host, scope, DateTimeOffset.UtcNow.AddMinutes(-30), checkedInAt: DateTimeOffset.UtcNow.AddMinutes(-29));

        await WorkerFor(host).TickAsync(default);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Entry(booking).ReloadAsync();

        Assert.Equal(BookingStatus.Completed, booking.Status);
    }

    [Fact]
    public async Task A_booking_still_running_is_left_alone()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();

        var booking = await SeedBookingAsync(
            host, scope, DateTimeOffset.UtcNow.AddMinutes(-5), checkedInAt: DateTimeOffset.UtcNow.AddMinutes(-4));

        await WorkerFor(host).TickAsync(default);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Entry(booking).ReloadAsync();

        Assert.Null(booking.LightsOffCuedAt);
        Assert.Equal(BookingStatus.Booked, booking.Status);
    }

    /// <summary>The sweep is idempotent — a second tick must not re-cue.</summary>
    /// <summary>
    /// A reversed no-show was cued off at the sweep (NoShow, truncated end); the reversal
    /// put it back to Booked and checked in. With the cue-off marker already set it was
    /// never promoted — parked as Booked for ever, never Completed, never anonymised by
    /// retention. Attended and over is Completed.
    /// </summary>
    [Fact]
    public async Task A_reversed_no_show_that_is_over_is_promoted_to_completed()
    {
        await using var host = await TestHost.CreateAsync();
        using var seed = host.NewScope();
        var booking = await SeedBookingAsync(host, seed, DateTimeOffset.UtcNow.AddMinutes(-30), BookingStatus.NoShow);

        var worker = WorkerFor(host);
        await worker.TickAsync(default);   // cues the no-show off

        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.Bookings.FirstAsync(b => b.Id == booking.Id);
            Assert.NotNull(row.LightsOffCuedAt);
            // What ReverseNoShowAsync leaves behind for a slot already over: Booked, checked
            // in, the cue-off marker still set.
            row.Status = BookingStatus.Booked;
            row.CheckedInAt = DateTimeOffset.UtcNow.AddMinutes(-25);
            await db.SaveChangesAsync();
        }

        await worker.TickAsync(default);

        using var check = host.NewScope();
        var after = await check.ServiceProvider.GetRequiredService<MainframeDbContext>().Bookings.AsNoTracking().FirstAsync(b => b.Id == booking.Id);
        Assert.Equal(BookingStatus.Completed, after.Status);
    }

    /// <summary>
    /// Settlement model I12. The sweep cued the lights off at the truncated end; the
    /// reversal used to clear <c>LightsOffCuedAt</c> so the sweep would fire again at the
    /// restored end — a <b>second</b> <c>booking.lights_off</c> for one booking, carrying a
    /// different <c>ends_at</c>, to a webhook consumer with no way to tell which was real.
    /// The marker stays; the attended-and-over pass is what promotes the row.
    /// </summary>
    [Fact]
    public async Task A_reversal_does_not_cue_the_lights_off_a_second_time()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();
        var bus = host.Services.GetRequiredService<IEventBus>();

        // Sold 18:00–19:00, swept five minutes in: NoShow with the end truncated.
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(-30);
        var booking = new Booking
        {
            TenantId = host.Tenant.Id,
            CourtId = host.Courts[0].Id,
            UserId = host.PlayerUser.Id,
            BookedByUserId = host.PlayerUser.Id,
            PaidByUserId = host.PlayerUser.Id,
            StartsAt = startsAt,
            EndsAt = DateTimeOffset.UtcNow.AddMinutes(-25),
            SliceMinutes = 15,
            SliceCount = 4,
            AmountChargedCredits = 32m,
            Status = BookingStatus.NoShow,
            ChargedAt = startsAt,
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();

        var worker = WorkerFor(host);
        await worker.TickAsync(default);
        await db.Entry(booking).ReloadAsync();
        var cuedAt = booking.LightsOffCuedAt;
        Assert.NotNull(cuedAt);

        Assert.IsType<NoShowReversalResult.Ok>(
            await bookings.ReverseNoShowAsync(booking, startsAt.AddMinutes(1), Guid.Empty, default));

        await db.Entry(booking).ReloadAsync();
        Assert.True(booking.EndsAt > DateTimeOffset.UtcNow, "the reversal restores the end past now");
        Assert.Equal(cuedAt, booking.LightsOffCuedAt);

        await worker.TickAsync(default);

        var emitted = new List<DomainEvent>();
        while (bus.Reader.TryRead(out var evt)) emitted.Add(evt);
        Assert.Single(emitted, e => e.Type == "booking.lights_off" && Equals(e.Data["booking_id"], booking.Id));
    }

    [Fact]
    public async Task Cueing_off_happens_once()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();

        var booking = await SeedBookingAsync(
            host, scope, DateTimeOffset.UtcNow.AddMinutes(-30), checkedInAt: DateTimeOffset.UtcNow.AddMinutes(-29));

        var worker = WorkerFor(host);
        await worker.TickAsync(default);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Entry(booking).ReloadAsync();
        var first = booking.LightsOffCuedAt;

        await worker.TickAsync(default);
        await db.Entry(booking).ReloadAsync();

        Assert.Equal(first, booking.LightsOffCuedAt);
    }
}

/// <summary>
/// The relay abstraction. Hardware abstractions ship before drivers, and CI must pass
/// without touching a relay.
/// </summary>
public class RelayClientTests
{
    private static NullRelayClient Client() => new(NullLogger<NullRelayClient>.Instance);

    [Fact]
    public async Task The_null_driver_reports_success_so_the_error_branch_is_not_the_default_path()
    {
        var on = await Client().TurnOnAsync(1, TimeSpan.FromMinutes(15), "key-1", default);
        var off = await Client().TurnOffAsync(1, "key-1", default);

        Assert.True(on.Ok);
        Assert.True(off.Ok);
    }

    /// <summary>
    /// The interface shape that matters: there is no overload that turns lights on without
    /// a duration. Today nothing in the hardware releases a court if the controller dies —
    /// the off command lives in a VBA macro on a Windows PC — so an indefinite-on must not
    /// be expressible.
    /// </summary>
    [Fact]
    public void There_is_no_way_to_ask_for_lights_on_without_a_duration()
    {
        var overloads = typeof(IRelayClient)
            .GetMethods()
            .Where(m => m.Name == nameof(IRelayClient.TurnOnAsync))
            .ToList();

        Assert.Single(overloads);
        Assert.Contains(overloads[0].GetParameters(), p => p.ParameterType == typeof(TimeSpan));
    }

    /// <summary>Every actuation carries an idempotency key, because a lost response is normal.</summary>
    [Fact]
    public void Every_actuation_takes_an_idempotency_key()
    {
        var methods = typeof(IRelayClient).GetMethods();

        Assert.All(methods, m =>
            Assert.Contains(m.GetParameters(), p => p.Name == "idempotencyKey"));
    }
}
