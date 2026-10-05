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
/// Review round 15, D15-2: a collided no-show reversal's <c>lights_on</c>.
///
/// <para>
/// A collision restores A's session to end where the survivor S begins, so the R14 walk always found
/// S holding the court at A's restored end and, whenever S was lit, suppressed A's on — even when S
/// was lit AFTER A's late scan. The court went dark-to-lit at A's scan and no event ever said so.
/// Now A's on is suppressed only when S was already lit at the scan (<c>min(StartsAt, CheckedInAt)
/// &lt;= scan</c>); otherwise it is sent at the scan and S's off closes the court — A is still never
/// owed an off of its own.
/// </para>
/// </summary>
public sealed class R15BE15aLightsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed class RecordingBus : IEventBus
    {
        private readonly System.Threading.Channels.Channel<DomainEvent> _channel = System.Threading.Channels.Channel.CreateUnbounded<DomainEvent>();
        private readonly List<DomainEvent> _seen = [];
        public System.Threading.Channels.ChannelReader<DomainEvent> Reader => _channel.Reader;

        public ValueTask EmitAsync(DomainEvent evt, CancellationToken ct = default)
        {
            lock (_seen) _seen.Add(evt);
            return _channel.Writer.WriteAsync(evt, ct);
        }

        public List<DomainEvent> Seen() { lock (_seen) return [.. _seen]; }
    }

    private sealed record Rig(WebApplicationFactory<Program> App, RecordingBus Bus, PlayersClub Club);

    private async Task<Rig> RigAsync(string prefix)
    {
        var bus = new RecordingBus();
        var app = pg.SharedHost.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEventBus>();
            s.AddSingleton<IEventBus>(bus);
        }));
        return new Rig(app, bus, await PlayersClub.SeedAsync(app, prefix));
    }

    private static async Task<Guid> SeedAsync(Rig r, DateTimeOffset start, int minutes, Guid who, DateTimeOffset? checkedIn,
        DateTimeOffset? cuedOff = null, DateTimeOffset? reversedAt = null)
    {
        var s = start.Storable();
        var booking = new Booking
        {
            TenantId = r.Club.TenantId,
            CourtId = r.Club.CourtId,
            UserId = who,
            BookedByUserId = who,
            PaidByUserId = who,
            ActorUserId = who,
            StartsAt = s,
            EndsAt = s.AddMinutes(minutes),
            SliceMinutes = minutes,
            SliceCount = 1,
            AmountChargedMinutes = minutes,
            Status = BookingStatus.Booked,
            ChargedAt = s.AddDays(-1),
            CheckedInAt = checkedIn?.Storable(),
            LightsOffCuedAt = cuedOff?.Storable(),
            NoShowReversedAt = reversedAt?.Storable(),
        };
        await r.Club.WriteAsync(r.App, db => db.Bookings.Add(booking));
        return booking.Id;
    }

    private static async Task EmitReversalAsync(Rig r, Guid booking)
    {
        await r.Club.InClubAsync(r.App, async sp =>
        {
            var db = sp.GetRequiredService<MainframeDbContext>();
            var row = await db.Bookings.FirstAsync(x => x.Id == booking);
            var court = await db.Courts.FirstAsync(c => c.Id == row.CourtId);
            await sp.GetRequiredService<CourtActivationService>()
                .EmitReversedLightsOnAsync(court, row, (r.Club.Organiser, row.CheckedInAt!.Value), "offline", default);
            return 0;
        });
    }

    private static async Task TickAsync(Rig r)
    {
        var worker = new LightsCueWorker(r.App.Services, r.Bus, NullLogger<LightsCueWorker>.Instance);
        for (var i = 0; i < 2; i++) await worker.TickAsync(default);
    }

    private static List<DomainEvent> Of(Rig r, string type, Guid booking) =>
        [.. r.Bus.Seen().Where(e => e.Type == type && Equals(e.Data["booking_id"], booking))];

    /// <summary>
    /// A (restored to end at S's start, scanned 14 minutes before that) and the survivor S. Lit AFTER
    /// the scan — at its start, or scanned in early but still after A's scan: A's on IS sent, at the
    /// scan. Lit BEFORE the scan (S scanned in very early): covered, no on. Either way A is never
    /// cued off by itself, and S's own off closes the court.
    /// </summary>
    [SkippableTheory]
    [InlineData(0, true)]      // S lit at its start, after A's scan
    [InlineData(-5, true)]     // S scanned in 5 minutes early — still after A's scan (-14)
    [InlineData(-20, false)]   // S scanned in 20 minutes early — before A's scan: covered
    public async Task A_collided_reversal_is_covered_only_by_a_survivor_lit_before_the_scan(int survivorLitFromStart, bool onSent)
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await RigAsync($"r15cov{Math.Abs(survivorLitFromStart)}");
        var restoredEnd = DateTimeOffset.UtcNow.AddMinutes(-1);
        var scan = restoredEnd.AddMinutes(-14);
        var a = await SeedAsync(r, restoredEnd.AddMinutes(-15), 15, r.Club.Organiser, scan,
            cuedOff: restoredEnd.AddMinutes(-10), reversedAt: DateTimeOffset.UtcNow.AddSeconds(-5));
        var s = await SeedAsync(r, restoredEnd, 15, r.Club.Sam, restoredEnd.AddMinutes(survivorLitFromStart).AddSeconds(1));

        await EmitReversalAsync(r, a);
        await TickAsync(r);

        var on = Of(r, "booking.lights_on", a);
        if (onSent)
        {
            var only = Assert.Single(on);
            Assert.True((only.OccurredAt - scan.Storable()).Duration() < TimeSpan.FromMilliseconds(1), $"on at {only.OccurredAt:o}, scan {scan:o}");
        }
        else
        {
            Assert.Empty(on);
        }

        // S plays out and is closed by its own off; A is never said off on its own.
        await r.Club.WriteAsync(r.App, db => db.Bookings.IgnoreQueryFilters().Single(x => x.Id == s).EndsAt = restoredEnd.AddSeconds(30).Storable());
        await TickAsync(r);
        Assert.Empty(Of(r, "booking.lights_off", a));
        Assert.Single(Of(r, "booking.lights_off", s));
    }
}
