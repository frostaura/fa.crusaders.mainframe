using System.Threading.Channels;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// F13 — one lost optimistic-concurrency race used to throw away a whole tick.
///
/// <para>
/// <c>Booking</c> carries a concurrency token and <c>NoShowWorker</c> writes <c>Status</c>
/// on rows matched by the same <c>Status == Booked</c> predicate this sweep uses, so a
/// lost race here is a NORMAL outcome, not an error — it means another writer decided the
/// booking first. The old shape emitted every <c>booking.lights_off</c> onto the bus and
/// then saved the entire batch in ONE <c>SaveChangesAsync</c>. One conflicting row
/// therefore threw, the catch-all in <c>ExecuteAsync</c> swallowed it, and every other
/// booking's marker went down with it — after their events had already gone out. The next
/// tick re-emitted all of them. Seen for real on a fresh Development seed
/// (<c>api.log</c>: "LightsCueWorker tick failed … expected to affect 1 row(s), but
/// actually affected 0").
/// </para>
///
/// <para>
/// Two properties are pinned here, and they are the two halves of the fix: the sweep
/// survives a losing row, and the marker is durable before the event is announced.
/// </para>
/// </summary>
public class LightsCueConcurrencyTests
{
    private static LightsCueWorker WorkerFor(TestHost host, IEventBus bus) =>
        new(host.Services, bus, NullLogger<LightsCueWorker>.Instance);

    private static Booking DueOff(TestHost host, Guid courtId, int minutesAgo) => new()
    {
        TenantId = host.Tenant.Id,
        CourtId = courtId,
        UserId = host.PlayerUser.Id,
        BookedByUserId = host.PlayerUser.Id,
        PaidByUserId = host.PlayerUser.Id,
        StartsAt = DateTimeOffset.UtcNow.AddMinutes(-minutesAgo - 15),
        EndsAt = DateTimeOffset.UtcNow.AddMinutes(-minutesAgo),
        SliceMinutes = 15,
        SliceCount = 1,
        AmountChargedCredits = 8m,
        Status = BookingStatus.Booked,
        CheckedInAt = DateTimeOffset.UtcNow.AddMinutes(-minutesAgo - 14),
    };

    /// <summary>
    /// A bus that lets a test act at exactly the moment the worker announces something —
    /// which is the only point inside one tick where another writer can realistically land.
    /// </summary>
    private sealed class InterceptingBus : IEventBus
    {
        private readonly Channel<DomainEvent> _channel = Channel.CreateUnbounded<DomainEvent>();
        private readonly Func<DomainEvent, Task> _onEmit;

        public InterceptingBus(Func<DomainEvent, Task> onEmit) => _onEmit = onEmit;

        public ChannelReader<DomainEvent> Reader => _channel.Reader;

        public List<DomainEvent> Emitted { get; } = [];

        public async ValueTask EmitAsync(DomainEvent evt, CancellationToken ct = default)
        {
            Emitted.Add(evt);
            await _onEmit(evt);
            await _channel.Writer.WriteAsync(evt, ct);
        }
    }

    [Fact]
    public async Task One_booking_lost_to_another_writer_does_not_take_the_rest_of_the_tick_with_it()
    {
        await using var host = await TestHost.CreateAsync();

        Booking first, contested, third;
        using (var seed = host.NewScope())
        {
            var db = seed.ServiceProvider.GetRequiredService<MainframeDbContext>();
            first = DueOff(host, host.Courts[0].Id, 30);
            contested = DueOff(host, host.Courts[1].Id, 30);
            third = DueOff(host, host.Courts[2].Id, 30);
            db.Bookings.AddRange(first, contested, third);
            await db.SaveChangesAsync();
        }

        // While the worker is announcing the FIRST booking — after it has read its due list
        // and before it reaches the second — another writer decides the second one. That is
        // the no-show sweeper, a cancellation or a check-in at the pad, arriving mid-tick.
        var interfered = false;
        var bus = new InterceptingBus(async _ =>
        {
            if (interfered) return;
            interfered = true;
            using var other = host.NewScope();
            var db = other.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.Bookings.FirstAsync(b => b.Id == contested.Id);
            row.Status = BookingStatus.Completed;
            await db.SaveChangesAsync();      // bumps Version — the worker's copy is now stale
        });

        await WorkerFor(host, bus).TickAsync(default);

        using var check = host.NewScope();
        var finalDb = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var rows = await finalDb.Bookings.ToDictionaryAsync(b => b.Id);

        // The two uncontested bookings were swept. Before the fix, BOTH of these were null:
        // the contested row's failure aborted the single batch save that carried all three.
        Assert.NotNull(rows[first.Id].LightsOffCuedAt);
        Assert.NotNull(rows[third.Id].LightsOffCuedAt);

        // And the contested one is left to the writer that won it, unharmed.
        Assert.Equal(BookingStatus.Completed, rows[contested.Id].Status);
    }

    [Fact]
    public async Task The_marker_is_durable_before_the_lights_off_event_is_announced()
    {
        await using var host = await TestHost.CreateAsync();

        Booking booking;
        using (var seed = host.NewScope())
        {
            var db = seed.ServiceProvider.GetRequiredService<MainframeDbContext>();
            booking = DueOff(host, host.Courts[0].Id, 30);
            db.Bookings.Add(booking);
            await db.SaveChangesAsync();
        }

        // Read the row through a SEPARATE context at the moment the event is emitted. If
        // the marker is not yet committed, a crash between the two re-announces the same
        // lights-off next tick — a duplicate a club's webhook consumer cannot tell from a
        // real one.
        DateTimeOffset? markerAtEmitTime = null;
        var bus = new InterceptingBus(async evt =>
        {
            if (evt.Type != "booking.lights_off") return;
            using var other = host.NewScope();
            var db = other.ServiceProvider.GetRequiredService<MainframeDbContext>();
            markerAtEmitTime = (await db.Bookings.AsNoTracking().FirstAsync(b => b.Id == booking.Id)).LightsOffCuedAt;
        });

        await WorkerFor(host, bus).TickAsync(default);

        Assert.Single(bus.Emitted, e => e.Type == "booking.lights_off");
        Assert.NotNull(markerAtEmitTime);
    }
}
