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
/// Review round 16, lane BE16a — a reversed no-show's lights, read by the documented consumer rule
/// (webhooks.md: order by <c>occurred_at</c>; a court is lit from an on until the next off).
/// <list type="bullet">
/// <item>E16-2: the no-show sweep's off (at the truncated end) reached consumers first; the reversal's
/// on, stamped back at the scan, sorted BEFORE it, and the replayed court read dark for the rest of a
/// session being played. Now, when an off for the court was already said after the scan and the
/// session is still running, the on is stamped at its emission and carries <c>scanned_at</c>.</item>
/// <item>D16-4: the desk cancelling a relit reversal before the next worker tick left its
/// <c>lights_on</c> with no off — the attended-and-over pass reads only Booked rows, and the lit-cancelled
/// sweep only uncued ones. A cancelled relit reversal is now swept like any other lit cancellation.</item>
/// </list>
/// </summary>
public sealed class R16LightsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
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

    /// <summary>A booking on the club's court. <paramref name="cuedOff"/> is when its off was cued (the sweep's).</summary>
    private sealed record Slot(DateTimeOffset Start, DateTimeOffset End, Guid Who)
    {
        public DateTimeOffset? CheckedIn { get; init; }
        public DateTimeOffset? CuedOff { get; init; }
        public DateTimeOffset? ReversedAt { get; init; }
    }

    private static async Task<Guid> SeedAsync(Rig r, Slot slot)
    {
        var s = slot.Start.Storable();
        var minutes = (int)(slot.End - slot.Start).TotalMinutes;
        var booking = new Booking
        {
            TenantId = r.Club.TenantId,
            CourtId = r.Club.CourtId,
            UserId = slot.Who,
            BookedByUserId = slot.Who,
            PaidByUserId = slot.Who,
            ActorUserId = slot.Who,
            StartsAt = s,
            EndsAt = slot.End.Storable(),
            SliceMinutes = minutes,
            SliceCount = 1,
            AmountChargedMinutes = minutes,
            Status = BookingStatus.Booked,
            ChargedAt = s.AddDays(-1),
            CheckedInAt = slot.CheckedIn?.Storable(),
            LightsOffCuedAt = slot.CuedOff?.Storable(),
            NoShowReversedAt = slot.ReversedAt?.Storable(),
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

    private static Task SetAsync(Rig r, Guid id, Action<Booking> change) =>
        r.Club.WriteAsync(r.App, db => change(db.Bookings.IgnoreQueryFilters().Single(x => x.Id == id)));

    private static Task DeskCancelAsync(Rig r, Guid id) =>
        r.Club.InClubAsync(r.App, async sp =>
            await sp.GetRequiredService<BookingService>().CancelAsync(id, r.Club.Admin, true, true, default, "Desk cancel"));

    private static List<DomainEvent> Of(Rig r, string type, Guid booking) =>
        [.. r.Bus.Seen().Where(e => e.Type == type && Equals(e.Data["booking_id"], booking))];

    /// <summary>
    /// The court as a consumer replays it: every lights event (plus offs already said before the test's
    /// window, which this bus never saw) ordered by <c>occurred_at</c>, the court lit from an on until
    /// the next off. Answers whether the court reads lit at <paramref name="at"/>.
    /// </summary>
    private static bool LitAt(Rig r, DateTimeOffset at, params DateTimeOffset[] offsAlreadySaid)
    {
        var events = r.Bus.Seen()
            .Where(e => e.Type is "booking.lights_on" or "booking.lights_off")
            .Select(e => (At: e.OccurredAt, On: e.Type == "booking.lights_on"))
            .Concat(offsAlreadySaid.Select(o => (At: o.Storable(), On: false)))
            .OrderBy(e => e.At)
            .ToList();
        var lit = false;
        foreach (var e in events.Where(e => e.At <= at)) lit = e.On;
        return lit;
    }

    // ------------------------------------------------------------------ E16-2

    /// <summary>
    /// The finding's own shape: scanned at 19:46 offline, swept a no-show (its off said at the truncated
    /// end, 19:50), the upload reversing it at 19:51 with the session running to 20:16. The reversal's on
    /// is stamped at its emission (after that off) and carries the scan as <c>scanned_at</c>; replayed by
    /// the plain rule, the court is lit from the reversal until the final off at the restored end.
    /// </summary>
    [SkippableFact]
    public async Task A_reversal_after_its_own_off_was_said_is_stamped_at_emission_and_lit_until_the_final_off()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await RigAsync("r16e2own");
        var now = DateTimeOffset.UtcNow;
        var scan = now.AddMinutes(-9);
        var sweptOff = now.AddMinutes(-2);
        var a = await SeedAsync(r, new Slot(now.AddMinutes(-10), now.AddMinutes(20), r.Club.Organiser)
        {
            CheckedIn = scan,
            CuedOff = sweptOff.AddSeconds(5),
            ReversedAt = now.AddSeconds(-1),
        });

        var before = DateTimeOffset.UtcNow.Storable();
        await EmitReversalAsync(r, a);

        var on = Assert.Single(Of(r, "booking.lights_on", a));
        Assert.True(on.OccurredAt >= before, $"on at {on.OccurredAt:o}, emitted after {before:o}, off said at {sweptOff:o}");
        Assert.Equal(scan.Storable(), Assert.IsType<DateTimeOffset>(on.Data["scanned_at"]));
        Assert.True(LitAt(r, on.OccurredAt.AddMilliseconds(1), sweptOff));

        // Played out: the attended-and-over pass closes it at the restored end, after the on.
        var end = DateTimeOffset.UtcNow.Storable();
        await SetAsync(r, a, b => b.EndsAt = end);
        await TickAsync(r);
        var off = Assert.Single(Of(r, "booking.lights_off", a));
        Assert.True(off.OccurredAt >= on.OccurredAt, $"off {off.OccurredAt:o} before on {on.OccurredAt:o}");
        Assert.True(LitAt(r, off.OccurredAt.AddTicks(-10), sweptOff));
        Assert.False(LitAt(r, off.OccurredAt, sweptOff));
    }

    /// <summary>
    /// Varied: the off said after the scan was ANOTHER booking's — the previous slot P, ended at A's start,
    /// after A's member scanned in early. Before, A's on at the scan sorted before P's off and the court
    /// replayed dark for A's whole session.
    /// </summary>
    [SkippableFact]
    public async Task A_reversal_after_the_previous_slots_off_is_stamped_at_emission()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await RigAsync("r16e2prev");
        var now = DateTimeOffset.UtcNow;
        var aStart = now.AddMinutes(-10);
        await SeedAsync(r, new Slot(aStart.AddMinutes(-15), aStart, r.Club.Sam) { CheckedIn = aStart.AddMinutes(-15), CuedOff = aStart.AddSeconds(10) });
        var scan = aStart.AddMinutes(-2);
        var a = await SeedAsync(r, new Slot(aStart, now.AddMinutes(20), r.Club.Organiser) { CheckedIn = scan, ReversedAt = now.AddSeconds(-1) });

        var before = DateTimeOffset.UtcNow.Storable();
        await EmitReversalAsync(r, a);

        var on = Assert.Single(Of(r, "booking.lights_on", a));
        Assert.True(on.OccurredAt >= before, $"on at {on.OccurredAt:o}");
        Assert.Equal(scan.Storable(), Assert.IsType<DateTimeOffset>(on.Data["scanned_at"]));
        Assert.True(LitAt(r, on.OccurredAt.AddMilliseconds(1), aStart));
    }

    /// <summary>
    /// Varied, unchanged behaviour: the off was said BEFORE the scan (the member scanned after the sweep's
    /// cue) — the on is at the scan, which already sorts after that off.
    /// </summary>
    [SkippableFact]
    public async Task A_reversal_whose_scan_came_after_the_off_keeps_the_scan_stamp()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await RigAsync("r16e2late");
        var now = DateTimeOffset.UtcNow;
        var scan = now.AddMinutes(-5);
        var a = await SeedAsync(r, new Slot(now.AddMinutes(-10), now.AddMinutes(20), r.Club.Organiser)
        {
            CheckedIn = scan,
            CuedOff = now.AddMinutes(-6),
            ReversedAt = now.AddSeconds(-1),
        });

        await EmitReversalAsync(r, a);

        var on = Assert.Single(Of(r, "booking.lights_on", a));
        Assert.Equal(scan.Storable(), on.OccurredAt);
        Assert.Equal(scan.Storable(), Assert.IsType<DateTimeOffset>(on.Data["scanned_at"]));
        Assert.True(LitAt(r, now, now.AddMinutes(-6).AddSeconds(-5)));
    }

    // ------------------------------------------------------------------ D16-4

    /// <summary>
    /// A relit reversal (on at the scan, the session already over) cancelled at the desk before the next
    /// tick: the sweep says its off, at its end, after its on — and only one.
    /// </summary>
    [SkippableFact]
    public async Task A_relit_reversal_cancelled_at_the_desk_before_the_tick_still_gets_its_off()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await RigAsync("r16d4over");
        var now = DateTimeOffset.UtcNow;
        var end = now.AddMinutes(-2);
        var a = await SeedAsync(r, new Slot(end.AddMinutes(-15), end, r.Club.Organiser)
        {
            CheckedIn = end.AddMinutes(-5),
            CuedOff = end.AddMinutes(-8),
            ReversedAt = now.AddSeconds(-5),
        });
        await EmitReversalAsync(r, a);
        var on = Assert.Single(Of(r, "booking.lights_on", a));

        await DeskCancelAsync(r, a);
        await TickAsync(r);
        await TickAsync(r);

        var off = Assert.Single(Of(r, "booking.lights_off", a));
        Assert.Equal(end.Storable(), off.OccurredAt);
        Assert.True(off.OccurredAt >= on.OccurredAt);
        Assert.False(LitAt(r, now));
    }

    /// <summary>
    /// Varied: the reversal re-lit a session still running (its on at emission, E16-2), the desk cancels it,
    /// and it plays out: one off, after the on, at its end.
    /// </summary>
    [SkippableFact]
    public async Task A_running_relit_reversal_cancelled_at_the_desk_gets_its_off_when_it_ends()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await RigAsync("r16d4run");
        var now = DateTimeOffset.UtcNow;
        var a = await SeedAsync(r, new Slot(now.AddMinutes(-10), now.AddMinutes(20), r.Club.Organiser)
        {
            CheckedIn = now.AddMinutes(-9),
            CuedOff = now.AddMinutes(-2),
            ReversedAt = now.AddSeconds(-1),
        });
        await EmitReversalAsync(r, a);
        var on = Assert.Single(Of(r, "booking.lights_on", a));
        await DeskCancelAsync(r, a);
        await TickAsync(r);
        Assert.Empty(Of(r, "booking.lights_off", a));

        var end = DateTimeOffset.UtcNow.Storable();
        await SetAsync(r, a, b => b.EndsAt = end);
        await TickAsync(r);

        var off = Assert.Single(Of(r, "booking.lights_off", a));
        Assert.Equal(end, off.OccurredAt);
        Assert.True(off.OccurredAt >= on.OccurredAt);
    }
}
