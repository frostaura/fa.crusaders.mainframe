using System.Net.Http.Json;
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
/// Review round 14, lights cues on Postgres.
///
/// <para>
/// D14-1: a booking holds the court from <c>min(StartsAt, CheckedInAt)</c>. The off walk read only
/// bookings already STARTED, so a member scanned in early across a gap (A 11:39–11:54, B 11:59 lit at
/// 11:52) was not seen and A's off went out at 11:54 — inside B's lit session, by arrival and by
/// <c>occurred_at</c>.
/// </para>
/// <para>
/// D14-2: a lit booking that is then cancelled (admin or member; a club-cancelled walk-up) had a
/// <c>lights_on</c> and never a <c>lights_off</c>: the sweep closed Booked/Completed/NoShow only.
/// </para>
/// <para>
/// E14-4: a reversal's <c>lights_on</c> whose session is already covered by a lit survivor is not
/// sent (its off never would be), and the sweep respects a relit reversal still to be closed.
/// </para>
/// </summary>
public sealed class R14LightsCueHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
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

    /// <summary>One booking on the club's court, written straight to the table.</summary>
    private sealed record Slot(DateTimeOffset Start, int Minutes, Guid Organiser)
    {
        public DateTimeOffset? CheckedIn { get; init; }
        public BookingStatus Status { get; init; } = BookingStatus.Booked;
        public DateTimeOffset? CuedOff { get; init; }
        public DateTimeOffset? ReversedAt { get; init; }
    }

    private static async Task<Guid> SeedAsync(Rig r, Slot s)
    {
        var start = s.Start.Storable();
        var booking = new Booking
        {
            TenantId = r.Club.TenantId,
            CourtId = r.Club.CourtId,
            UserId = s.Organiser,
            BookedByUserId = s.Organiser,
            PaidByUserId = s.Organiser,
            ActorUserId = s.Organiser,
            StartsAt = start,
            EndsAt = start.AddMinutes(s.Minutes),
            SliceMinutes = s.Minutes,
            SliceCount = 1,
            AmountChargedMinutes = s.Minutes,
            Status = s.Status,
            ChargedAt = start.AddDays(-1),
            CheckedInAt = s.CheckedIn?.Storable(),
            LightsOffCuedAt = s.CuedOff?.Storable(),
            NoShowReversedAt = s.ReversedAt?.Storable(),
            CancelledAt = s.Status == BookingStatus.Cancelled ? start : null,
        };
        await r.Club.WriteAsync(r.App, db => db.Bookings.Add(booking));
        return booking.Id;
    }

    private static async Task TickAsync(Rig r, int times = 2)
    {
        var worker = new LightsCueWorker(r.App.Services, r.Bus, NullLogger<LightsCueWorker>.Instance);
        for (var i = 0; i < times; i++) await worker.TickAsync(default);
    }

    private static List<DomainEvent> Of(Rig r, string type, Guid booking) =>
        [.. r.Bus.Seen().Where(e => e.Type == type && Equals(e.Data["booking_id"], booking))];

    private static void AssertAt(DomainEvent e, DateTimeOffset expected) =>
        Assert.True((e.OccurredAt - expected.Storable()).Duration() < TimeSpan.FromMilliseconds(1),
            $"occurred_at {e.OccurredAt:o}, expected {expected.Storable():o}");

    // ------------------------------------------------------------------ D14-1

    /// <summary>
    /// A gap between A and B, and B's member scanned in early — before A's end. B holds the court
    /// from its scan, so A's end-of-slot off is not sent: B's own off closes the court.
    /// </summary>
    [SkippableTheory]
    [InlineData(5, -4)]    // the reviewer's shape: gap of five, scanned a minute before A's end
    [InlineData(2, -1)]
    [InlineData(0, -6)]    // back to back, scanned early — the case R13 already held
    public async Task An_early_scan_across_a_gap_holds_the_court(int gapMinutes, int scanFromAEnd)
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await RigAsync("r14gap");
        var aEnd = DateTimeOffset.UtcNow.AddMinutes(-1);
        var a = await SeedAsync(r, new Slot(aEnd.AddMinutes(-15), 15, r.Club.Organiser) { CheckedIn = aEnd.AddMinutes(-15) });
        var b = await SeedAsync(r, new Slot(aEnd.AddMinutes(gapMinutes), 15, r.Club.Sam) { CheckedIn = aEnd.AddMinutes(scanFromAEnd) });

        await TickAsync(r);

        Assert.Empty(Of(r, "booking.lights_off", a));
        Assert.Empty(Of(r, "booking.lights_off", b));
        Assert.Single(Of(r, "booking.completed", a));
    }

    /// <summary>
    /// Varied: B scanned AFTER A's end, inside the gap. The court was dark between them, so A's off
    /// is said — at A's end, before B's lights came on by <c>occurred_at</c>.
    /// </summary>
    [SkippableFact]
    public async Task A_scan_after_the_previous_end_leaves_the_gap_dark()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await RigAsync("r14gapl");
        var aEnd = DateTimeOffset.UtcNow.AddMinutes(-2);
        var a = await SeedAsync(r, new Slot(aEnd.AddMinutes(-15), 15, r.Club.Organiser) { CheckedIn = aEnd.AddMinutes(-15) });
        await SeedAsync(r, new Slot(aEnd.AddMinutes(4), 15, r.Club.Sam) { CheckedIn = aEnd.AddMinutes(1) });

        await TickAsync(r);

        AssertAt(Assert.Single(Of(r, "booking.lights_off", a)), aEnd);
    }

    /// <summary>
    /// A chain: A ended (the sweep is late), B — early-scanned across a gap after A — is over and
    /// cued off, and C is early-scanned across a gap after B and still to start. One-booking chain:
    /// C alone after A. Neither may darken C; with C unlit, A's off is at the end of B's holding.
    /// </summary>
    [SkippableTheory]
    [InlineData(true, true)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task A_chain_of_early_holders_is_walked_by_when_each_was_lit(bool withB, bool cLit)
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await RigAsync("r14chain");
        var now = DateTimeOffset.UtcNow;
        var aEnd = withB ? now.AddMinutes(-33) : now.AddMinutes(-2);
        var a = await SeedAsync(r, new Slot(aEnd.AddMinutes(-20), 20, r.Club.Organiser) { CheckedIn = aEnd.AddMinutes(-20) });
        var cuedB = now.AddMinutes(-2);
        if (withB)
        {
            // B 2 min after A, scanned 1 min BEFORE A's end, over at now−3 and already cued off.
            await SeedAsync(r, new Slot(aEnd.AddMinutes(2), 28, r.Club.Sam)
            {
                CheckedIn = aEnd.AddMinutes(-1),
                Status = BookingStatus.Completed,
                CuedOff = cuedB,
            });
        }
        var holdingEnd = withB ? aEnd.AddMinutes(30) : aEnd;
        // C 3 min after the holding ends, scanned 1 min before it ends (or not at all).
        await SeedAsync(r, new Slot(holdingEnd.AddMinutes(3), 15, r.Club.Alex)
        {
            CheckedIn = cLit ? holdingEnd.AddMinutes(-1) : null,
        });

        await TickAsync(r);

        var offs = Of(r, "booking.lights_off", a);
        if (cLit) Assert.Empty(offs);
        else AssertAt(Assert.Single(offs), holdingEnd);
    }

    // ------------------------------------------------------------------ D14-2

    /// <summary>
    /// Checks <paramref name="booking"/> in through the activation path (its lights_on goes out),
    /// as a member scanning at the box does — early when the start is still ahead.
    /// </summary>
    private static async Task LightAsync(Rig r, Guid booking, Guid who)
    {
        await r.Club.InClubAsync(r.App, async sp =>
        {
            var db = sp.GetRequiredService<MainframeDbContext>();
            var activation = sp.GetRequiredService<CourtActivationService>();
            var row = await db.Bookings.FirstAsync(x => x.Id == booking);
            var court = await db.Courts.FirstAsync(c => c.Id == row.CourtId);
            Assert.IsType<ActivationResult.Activated>(await activation.ActivateAsync(court, row, who, null, "qr", default));
            return 0;
        });
    }

    /// <summary>Moves a booking (and its check-in) back by <paramref name="by"/> — "its slot is now over".</summary>
    private static Task ShiftBackAsync(Rig r, Guid booking, TimeSpan by) => r.Club.WriteAsync(r.App, db =>
    {
        var row = db.Bookings.IgnoreQueryFilters().Single(x => x.Id == booking);
        row.StartsAt -= by;
        row.EndsAt -= by;
        row.CheckedInAt -= by;
        row.LightsOnCuedAt -= by;
        if (row.CancelledAt is not null) row.CancelledAt -= by;
    });

    private static async Task<DateTimeOffset> EndOfAsync(Rig r, Guid booking) =>
        await PlayersClub.ReadAsync(r.App, db => db.Bookings.IgnoreQueryFilters().Where(x => x.Id == booking).Select(x => x.EndsAt).SingleAsync());

    /// <summary>
    /// A lit booking cancelled by the desk mid-session, and one its own member cancelled after
    /// scanning in early (before its start, the only time a member may). Once the lit grant has run
    /// out the sweep says the off, once, at the grant's end.
    /// </summary>
    [SkippableTheory]
    [InlineData("admin")]
    [InlineData("member")]
    public async Task A_lit_booking_cancelled_afterwards_is_cued_off_at_its_end(string by)
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await RigAsync($"r14cx{by[..3]}");
        var start = by == "admin" ? DateTimeOffset.UtcNow.AddMinutes(-5) : DateTimeOffset.UtcNow.AddMinutes(3);
        var booking = await r.Club.InsertBookingAsync(r.App, start.Storable());
        await LightAsync(r, booking, r.Club.Organiser);
        Assert.Single(Of(r, "booking.lights_on", booking));

        var response = by == "admin"
            ? await r.Club.Client(r.App, r.Club.Admin, admin: true)
                .PostAsJsonAsync($"/api/v1/admin/bookings/{booking}/cancel", new { reason = "Court flooded" })
            : await r.Club.Client(r.App, r.Club.Organiser).PostAsync($"/api/v1/bookings/{booking}/cancel", null);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());

        await TickAsync(r);
        Assert.Empty(Of(r, "booking.lights_off", booking));   // still inside its grant

        await ShiftBackAsync(r, booking, TimeSpan.FromHours(1));
        await TickAsync(r);
        await TickAsync(r);

        AssertAt(Assert.Single(Of(r, "booking.lights_off", booking)), await EndOfAsync(r, booking));
        Assert.Empty(Of(r, "booking.completed", booking));
    }

    /// <summary>
    /// A cancelled booking nobody checked in on lit nothing and is never cued (varied from the
    /// lit case above), and a lit cancelled one follows the next-free rule: a lit booking holding
    /// the court at its end means no off of its own.
    /// </summary>
    [SkippableTheory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task A_cancelled_booking_is_cued_off_only_when_lit_and_only_when_the_court_is_free(bool lit, bool nextLit)
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await RigAsync("r14cxn");
        var end = DateTimeOffset.UtcNow.AddMinutes(-2);
        var cancelled = await SeedAsync(r, new Slot(end.AddMinutes(-15), 15, r.Club.Organiser)
        {
            Status = BookingStatus.Cancelled,
            CheckedIn = lit ? end.AddMinutes(-15) : null,
        });
        await SeedAsync(r, new Slot(end, 15, r.Club.Sam) { CheckedIn = nextLit ? end.AddMinutes(-1) : null });

        await TickAsync(r);

        var offs = Of(r, "booking.lights_off", cancelled);
        if (!lit || nextLit) Assert.Empty(offs);
        else AssertAt(Assert.Single(offs), end);
    }

    /// <summary>
    /// The mirror: a lit, cancelled booking still inside its grant holds the court — the booking
    /// before it ending now does not say the court is dark under it.
    /// </summary>
    [SkippableFact]
    public async Task A_lit_cancelled_booking_still_running_holds_the_court()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await RigAsync("r14cxh");
        var aEnd = DateTimeOffset.UtcNow.AddMinutes(-1);
        var a = await SeedAsync(r, new Slot(aEnd.AddMinutes(-15), 15, r.Club.Organiser) { CheckedIn = aEnd.AddMinutes(-15) });
        await SeedAsync(r, new Slot(aEnd.AddMinutes(3), 15, r.Club.Sam) { Status = BookingStatus.Cancelled, CheckedIn = aEnd.AddMinutes(-2) });

        await TickAsync(r);

        Assert.Empty(Of(r, "booking.lights_off", a));
    }

    // ------------------------------------------------------------------ E14-4

    /// <summary>A no-show reversed AFTER its off cue, restored to end at <paramref name="restoredEnd"/>, still Booked.</summary>
    private static Slot Relit(PlayersClub club, DateTimeOffset restoredEnd, DateTimeOffset scan) =>
        new(restoredEnd.AddMinutes(-15), 15, club.Organiser)
        {
            CheckedIn = scan,
            CuedOff = restoredEnd.AddMinutes(-10),
            ReversedAt = DateTimeOffset.UtcNow.AddSeconds(-5),
        };

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

    /// <summary>
    /// The collided reversal (E14-4's court 2): A's restored session ended where S's started, and S
    /// is lit. A's lights_on — occurred_at back at the scan, arriving after S's — would have no off
    /// of its own, ever (S holds the court at A's end). It is not sent, and A is never cued off,
    /// even after S's own off has closed the court. Varied: no survivor — the on IS sent, and the
    /// attended-and-over pass closes it at the restored end.
    /// </summary>
    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_reversal_covered_by_a_lit_survivor_sends_no_lights_on(bool survivorLit)
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await RigAsync("r14rev");
        var restoredEnd = DateTimeOffset.UtcNow.AddMinutes(-1);
        var a = await SeedAsync(r, Relit(r.Club, restoredEnd, restoredEnd.AddMinutes(-14)));
        var s = await SeedAsync(r, new Slot(restoredEnd, 15, r.Club.Sam) { CheckedIn = survivorLit ? restoredEnd.AddSeconds(10) : null });

        await EmitReversalAsync(r, a);
        await TickAsync(r);

        if (survivorLit)
        {
            Assert.Empty(Of(r, "booking.lights_on", a));
            // S plays out and is closed; A is still never said off (it was never said on).
            await r.Club.WriteAsync(r.App, db => db.Bookings.IgnoreQueryFilters().Single(x => x.Id == s).EndsAt = restoredEnd.AddSeconds(30).Storable());
            await TickAsync(r);
            Assert.Empty(Of(r, "booking.lights_off", a));
            Assert.Single(Of(r, "booking.lights_off", s));
        }
        else
        {
            Assert.Single(Of(r, "booking.lights_on", a));
            AssertAt(Assert.Single(Of(r, "booking.lights_off", a)), restoredEnd);
        }
    }

    /// <summary>
    /// A relit reversal still playing (its new off still to come) holds the court: the booking
    /// before it ending now must not stamp an off at all — before R14 the walk took the reversal's
    /// old cue for "already closed" and said the previous slot's off at the reversal's end.
    /// </summary>
    [SkippableFact]
    public async Task The_sweep_respects_a_relit_reversal_still_to_be_closed()
    {
        Skip.IfNot(pg.Available, Skipped);
        var r = await RigAsync("r14resp");
        var xEnd = DateTimeOffset.UtcNow.AddMinutes(-1);
        var x = await SeedAsync(r, new Slot(xEnd.AddMinutes(-15), 15, r.Club.Sam) { CheckedIn = xEnd.AddMinutes(-15) });
        // A: from x's end, 20 min, scanned 2 min before x's end, swept and cued, then reversed.
        await SeedAsync(r, new Slot(xEnd, 20, r.Club.Organiser)
        {
            CheckedIn = xEnd.AddMinutes(-2),
            CuedOff = xEnd.AddSeconds(20),
            ReversedAt = DateTimeOffset.UtcNow.AddSeconds(-5),
        });

        await TickAsync(r);

        Assert.Empty(Of(r, "booking.lights_off", x));
    }
}
