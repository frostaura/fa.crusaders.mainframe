using System.Threading.Channels;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 13 (E13-1, last open race): the next member's check-in COMMITS between the lights-off
/// sweep reading the court and sending the off. The sweep saw the next booking unlit, decided to send
/// A's off, and the check-in's <c>lights_on</c> went out first — so the off arrived after it and a
/// per-court mirror read the new session dark. Driven deterministically: the sweep's test hook runs
/// the check-in at exactly that point, on Postgres, where the per-court lock is real.
/// </summary>
public sealed class R13LightsCueRaceHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    /// <summary>Records every event in ARRIVAL order — what a webhook consumer receives.</summary>
    private sealed class RecordingBus : IEventBus
    {
        private readonly Channel<DomainEvent> _channel = Channel.CreateUnbounded<DomainEvent>();
        private readonly List<DomainEvent> _seen = [];
        public ChannelReader<DomainEvent> Reader => _channel.Reader;

        public ValueTask EmitAsync(DomainEvent evt, CancellationToken ct = default)
        {
            lock (_seen) _seen.Add(evt);
            return _channel.Writer.WriteAsync(evt, ct);
        }

        public List<DomainEvent> Seen() { lock (_seen) return [.. _seen]; }
    }

    /// <summary>
    /// A ended a minute ago, checked in; B starts where A ended, unlit. Mid-sweep — after the read,
    /// before the send — B's member checks in (<paramref name="how"/>: an online activation, or a box
    /// upload's reversal emitting its lights_on). By arrival, A's off must come BEFORE B's on, and by
    /// occurred_at it must not fall inside B's lit session.
    /// </summary>
    [SkippableTheory]
    [InlineData("activation")]
    [InlineData("reversal_emit")]
    public async Task A_check_in_committing_mid_sweep_is_never_followed_by_the_previous_slots_off(string how)
    {
        Skip.IfNot(pg.Available, Skipped);
        var bus = new RecordingBus();
        var app = pg.SharedHost.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEventBus>();
            s.AddSingleton<IEventBus>(bus);
        }));
        var club = await PlayersClub.SeedAsync(app, $"r13race{how[..3]}");
        var end = DateTimeOffset.UtcNow.AddMinutes(-1).Storable();
        var a = await club.InsertBookingAsync(app, end.AddMinutes(-32));
        var b = await club.InsertBookingAsync(app, end, organiser: club.Sam);
        await club.WriteAsync(app, db => db.Bookings.IgnoreQueryFilters().Single(x => x.Id == a).CheckedInAt = end.AddMinutes(-31));

        Task? checkIn = null;
        var worker = new LightsCueWorker(app.Services, bus, NullLogger<LightsCueWorker>.Instance)
        {
            AfterOffDecidedForTests = async decided =>
            {
                if (decided.Id != a) return;
                checkIn = Task.Run(() => CheckInAsync(club, app, b, how));
                // Without a lock the check-in commits and announces itself inside this window. With
                // one it waits for the sweep, which is what the second second proves.
                await Task.WhenAny(checkIn, Task.Delay(TimeSpan.FromSeconds(3)));
            },
        };
        await worker.TickAsync(default);
        Assert.NotNull(checkIn);
        await checkIn!;

        var seen = bus.Seen();
        var on = seen.FindIndex(e => e.Type == "booking.lights_on" && Equals(e.Data["booking_id"], b));
        Assert.True(on >= 0, "B's lights_on was never sent");
        var offs = seen.Select((e, i) => (e, i)).Where(x => x.e.Type == "booking.lights_off" && Equals(x.e.Data["booking_id"], a)).ToList();
        // By arrival: nothing for A after B's on.
        Assert.All(offs, x => Assert.True(x.i < on, $"A's lights_off arrived at {x.i}, after B's lights_on at {on}"));
        // By occurred_at: no off inside B's lit session.
        var bLitFrom = seen[on].OccurredAt < end ? seen[on].OccurredAt : end;
        Assert.All(offs, x => Assert.True(x.e.OccurredAt <= bLitFrom, $"A's off at {x.e.OccurredAt:o} inside B's session from {bLitFrom:o}"));
    }

    private static async Task CheckInAsync(PlayersClub club, WebApplicationFactory<Program> app, Guid bookingId, string how)
    {
        await club.InClubAsync(app, async sp =>
        {
            var db = sp.GetRequiredService<MainframeDbContext>();
            var activation = sp.GetRequiredService<CourtActivationService>();
            var booking = await db.Bookings.FirstAsync(x => x.Id == bookingId);
            var court = await db.Courts.FirstAsync(c => c.Id == booking.CourtId);
            if (how == "activation")
            {
                Assert.IsType<ActivationResult.Activated>(await activation.ActivateAsync(court, booking, club.Sam, null, "qr", default));
                return 0;
            }
            // The upload's reversal commits the check-in first, then emits (DeviceEventEndpoints).
            var at = DateTimeOffset.UtcNow.Storable();
            booking.CheckedInAt = at;
            await db.SaveChangesAsync();
            await activation.EmitReversedLightsOnAsync(court, booking, (club.Sam, at), "offline", default);
            return 0;
        });
    }
}
