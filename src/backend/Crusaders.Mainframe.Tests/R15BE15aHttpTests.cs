using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 15, lane BE15a, on Postgres.
///
/// <list type="bullet">
/// <item>D14-4 remnants: the lights-off sweep, the no-show sweep, a walk-up's and a reversal's money
/// and a device fault were stamped on the WALL clock while the device routes decided on the injected
/// one — a pinned clock an hour away put a booking's off, its refund and its cue an hour apart.</item>
/// <item>D15-5: a member who checked in early could cancel, get nothing back (attendance) and free the
/// slot for resale. Refused 409 <c>already_checked_in</c>; the desk is unaffected.</item>
/// <item>J15-2 (server): the desk cancels a started session — including its own booking.</item>
/// <item>E15-5: <c>minutes.sold_at_desk</c> says what the desk took and whether it was a gift.</item>
/// <item>X15-6 / E15-2 / J15-3 (server half): the named balance frame is sent before its unnamed twin.</item>
/// </list>
/// </summary>
public sealed class R15BE15aHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    /// <summary>Records every event in arrival order.</summary>
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

    private sealed record Rig(MemberCodeClub Club, WebApplicationFactory<Program> App, PinnedClock Clock, RecordingBus Bus);

    private async Task<Rig> RigAsync(string prefix, int clockMinutesFromWall)
    {
        var clock = new PinnedClock(DateTimeOffset.UtcNow.AddMinutes(clockMinutesFromWall).Storable());
        var bus = new RecordingBus();
        var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService(), clock).WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEventBus>();
            s.AddSingleton<IEventBus>(bus);
        }));
        var club = await MemberCodeClub.SeedAsync(app, prefix, MemberCodeClub.SettingsAtNoon());
        return new Rig(club, app, clock, bus);
    }

    private static void Near(DateTimeOffset expected, DateTimeOffset? actual, string what) =>
        Assert.True(actual is { } a && (a - expected).Duration() < TimeSpan.FromSeconds(2), $"{what}: {actual:o}, expected {expected:o}");

    private static Task<Booking> RowAsync(Rig r, Guid id) =>
        r.Club.ReadAsync(r.App, db => db.Bookings.IgnoreQueryFilters().AsNoTracking().SingleAsync(b => b.Id == id));

    private static Task<List<LedgerEntry>> LedgerAsync(Rig r, Guid bookingId) =>
        r.Club.ReadAsync(r.App, db => db.LedgerEntries.IgnoreQueryFilters().AsNoTracking()
            .Where(l => l.RelatedBookingId == bookingId).OrderBy(l => l.CreatedAt).ToListAsync());

    // ------------------------------------------------------------------ D14-4

    /// <summary>
    /// The off sweep decides "ended" on the club's clock and stamps its cue there. The booking ends
    /// half an hour after the club's clock (ahead or behind the wall by an hour): not due on the
    /// club's clock — and, varied the other way, due on it while the wall says it is still running.
    /// </summary>
    [SkippableTheory]
    [InlineData(-60, false)]
    [InlineData(60, true)]
    public async Task The_lights_off_sweep_runs_on_the_clubs_clock(int clockFromWall, bool due)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r15lc{(clockFromWall > 0 ? "a" : "b")}", clockFromWall);
        await using var _ = r.App;
        // Ends 30 min from the club's clock, on the side that makes it due (or not) there and the other on the wall.
        var endFromWall = clockFromWall + (due ? -30 : 30);
        var booking = await r.Club.BookAsync(r.App, r.Club.Olga, courtIndex: 0, startsInMinutes: endFromWall - 60, minutes: 60, checkedIn: true);

        await new LightsCueWorker(r.App.Services, r.Bus, NullLogger<LightsCueWorker>.Instance).TickAsync(default);

        var row = await RowAsync(r, booking.Id);
        if (due) Near(r.Clock.Now, row.LightsOffCuedAt, "LightsOffCuedAt");
        else Assert.Null(row.LightsOffCuedAt);
    }

    /// <summary>
    /// The no-show sweep (its own timer's tick, no instant handed in) decides on the club's clock and
    /// stamps its refund there: a booking 20 minutes into its slot by the club's clock is swept, and
    /// its refund row is the club's instant, not the wall's an hour away.
    /// </summary>
    [SkippableTheory]
    [InlineData(-60)]
    [InlineData(60)]
    public async Task The_no_show_sweep_runs_and_posts_on_the_clubs_clock(int clockFromWall)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r15ns{(clockFromWall > 0 ? "a" : "b")}", clockFromWall);
        await using var _ = r.App;
        var booking = await r.Club.BookAsync(r.App, r.Club.Olga, courtIndex: 0, startsInMinutes: clockFromWall - 20, minutes: 60);

        await new NoShowWorker(r.App.Services, r.Bus, NullLogger<NoShowWorker>.Instance).TickAsync(default);

        Assert.Equal(BookingStatus.NoShow, (await RowAsync(r, booking.Id)).Status);
        var refund = Assert.Single(await LedgerAsync(r, booking.Id), l => l.Type == LedgerEntryType.CancellationRefund);
        Near(r.Clock.Now, refund.CreatedAt, "refund CreatedAt");
    }

    /// <summary>A walk-up is sold at the club's instant, and so is the money it costs and the event that says so.</summary>
    [SkippableTheory]
    [InlineData(-60)]
    [InlineData(60)]
    public async Task A_walk_up_charge_is_on_the_clubs_clock(int clockFromWall)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r15wu{(clockFromWall > 0 ? "a" : "b")}", clockFromWall);
        await using var _ = r.App;
        var c = r.Club;

        var response = await r.App.CreateClient().SendAsync(c.WalkUp(c.Code(c.Olga, at: r.Clock.Now), court: 3, nonce: "a1b2c3d4e5f60718"));
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, text);

        var charge = await c.ReadAsync(r.App, db => db.LedgerEntries.IgnoreQueryFilters().AsNoTracking()
            .SingleAsync(l => l.TenantId == c.TenantId && l.Type == LedgerEntryType.LightsPurchase));
        Near(r.Clock.Now, charge.CreatedAt, "LightsPurchase CreatedAt");
        Near(r.Clock.Now, Assert.Single(r.Bus.Seen(), e => e.Type == "booking.created").OccurredAt, "booking.created occurred_at");
    }

    /// <summary>
    /// A late offline scan reverses a no-show the club's-clock sweep settled: the reversal's two legs
    /// are the club's instant too (the reversal stamp already was, R14) — and so is the minutes webhook
    /// that mirrors them.
    /// </summary>
    [SkippableFact]
    public async Task A_reversal_posts_its_legs_on_the_clubs_clock()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r15rev", -60);
        await using var _ = r.App;
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -80, minutes: 60);
        await new NoShowWorker(r.App.Services, r.Bus, NullLogger<NoShowWorker>.Instance).TickAsync(default);
        Assert.Equal(BookingStatus.NoShow, (await RowAsync(r, booking.Id)).Status);

        // Scanned 19 minutes before the club's now — one minute into the slot — and uploaded now.
        var scan = r.Clock.Now.AddMinutes(-19);
        var upload = await r.App.CreateClient().SendAsync(c.Events(c.BoxMac, 1, "activation", 0, c.Code(c.Olga, at: scan), agoMs: 19 * 60_000));
        Assert.True(upload.IsSuccessStatusCode, await upload.Content.ReadAsStringAsync());

        var row = await RowAsync(r, booking.Id);
        Assert.NotNull(row.NoShowReversedAt);
        var legs = (await LedgerAsync(r, booking.Id)).Where(l => l.ExternalReference?.StartsWith("noshow-reversal:") == true).ToList();
        Assert.NotEmpty(legs);
        Assert.All(legs, l => Near(r.Clock.Now, l.CreatedAt, $"{l.Type} CreatedAt"));
        Assert.All(r.Bus.Seen().Where(e => e.Type == MinutesEvents.RefundReversed), e => Near(r.Clock.Now, e.OccurredAt, "minutes.refund_reversed"));
    }

    /// <summary>A device fault the server notices is first seen at the club's instant.</summary>
    [SkippableFact]
    public async Task A_device_fault_is_first_seen_on_the_clubs_clock()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r15flt", -60);
        await using var _ = r.App;
        var req = r.Club.Device("/api/v1/device/events", new System.Text.Json.Nodes.JsonObject());
        req.Content = new StringContent($$"""{"mac":"{{r.Club.BoxMac}}","events":[""", System.Text.Encoding.UTF8, "application/json");

        Assert.Equal(HttpStatusCode.BadRequest, (await r.App.CreateClient().SendAsync(req)).StatusCode);

        DeviceError? fault = null;
        for (var i = 0; i < 100 && fault is null; i++)
        {
            fault = await r.Club.ReadAsync(r.App, db => db.DeviceErrors.IgnoreQueryFilters().AsNoTracking()
                .FirstOrDefaultAsync(e => e.TenantId == r.Club.TenantId && e.Code == DeviceErrorCodes.MalformedBody));
            if (fault is null) await Task.Delay(100);
        }
        Assert.NotNull(fault);
        Near(r.Clock.Now, fault.FirstSeenAt, "FirstSeenAt");
    }

    // ------------------------------------------------------------------ D15-5 / J15-2

    private static async Task<(HttpStatusCode Status, string Error)> MemberCancelAsync(Rig r, Guid user, Guid bookingId)
    {
        var response = await r.Club.Member(r.App, user).PostAsync($"/api/v1/bookings/{bookingId}/cancel", null);
        var text = await response.Content.ReadAsStringAsync();
        var error = text.Length > 0 && JsonDocument.Parse(text).RootElement.TryGetProperty("error", out var e) ? e.GetString() ?? "" : "";
        return (response.StatusCode, error);
    }

    /// <summary>
    /// Olga scanned in early for a booking that starts in ten minutes: her own cancel is refused
    /// 409 <c>already_checked_in</c>, the booking stands and nothing moves. Varied: the same booking
    /// not checked in cancels as ever (refund).
    /// </summary>
    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_member_cannot_cancel_a_booking_they_have_checked_in_to(bool checkedIn)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r15ci{(checkedIn ? "y" : "n")}", 0);
        await using var _ = r.App;
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: 90, minutes: 60, checkedIn: checkedIn);
        var before = await c.BalanceAsync(r.App, c.Olga);

        var (status, error) = await MemberCancelAsync(r, c.Olga, booking.Id);

        if (checkedIn)
        {
            Assert.Equal(HttpStatusCode.Conflict, status);
            Assert.Equal("already_checked_in", error);
            Assert.Equal(BookingStatus.Booked, (await RowAsync(r, booking.Id)).Status);
            Assert.Equal(before, await c.BalanceAsync(r.App, c.Olga));
        }
        else
        {
            Assert.Equal(HttpStatusCode.OK, status);
            Assert.Equal(BookingStatus.Cancelled, (await RowAsync(r, booking.Id)).Status);
            Assert.Equal(before + 60, await c.BalanceAsync(r.App, c.Olga));
        }
    }

    /// <summary>
    /// J15-2: the desk cancels a STARTED session — a member's (lit or not) and the admin's own, which
    /// the member's started-refusal used to catch because the admin owns it. Lit: nothing back
    /// (cancelled_no_refund). D15-5 does not touch the desk: a checked-in booking cancels too.
    /// </summary>
    [SkippableTheory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task The_desk_cancels_a_started_session(bool checkedIn, bool adminsOwn)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r15dc{(checkedIn ? "y" : "n")}{(adminsOwn ? "a" : "m")}", 0);
        await using var _ = r.App;
        var c = r.Club;
        var owner = adminsOwn ? c.AdminId : c.Olga;
        var booking = await c.BookAsync(r.App, owner, courtIndex: 1, startsInMinutes: -10, minutes: 60, checkedIn: checkedIn);
        var before = await c.BalanceAsync(r.App, owner);

        var response = await c.Member(r.App, c.AdminId, "admin")
            .PostAsJsonAsync($"/api/v1/admin/bookings/{booking.Id}/cancel", new { reason = "Court flooded" });
        var text = await response.Content.ReadAsStringAsync();

        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{(int)response.StatusCode} {text}");
        Assert.Equal(BookingStatus.Cancelled, (await RowAsync(r, booking.Id)).Status);
        if (checkedIn) Assert.Equal(before, await c.BalanceAsync(r.App, owner));
    }

    // ------------------------------------------------------------------ E15-5

    /// <summary>
    /// A desk sale's webhook carries <c>zar_received</c> and <c>given</c>: a R0.00 give and a paid
    /// sale are told apart (the admin ledger, the Night and the mail already could).
    /// </summary>
    [SkippableTheory]
    [InlineData(0, true)]
    [InlineData(120, false)]
    public async Task The_desk_sale_webhook_says_what_was_taken_and_whether_it_was_given(int rand, bool given)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r15ds{rand}", 0);
        await using var _ = r.App;
        var c = r.Club;
        var package = new MinutePackage
        {
            TenantId = c.TenantId, Name = "One hour", Minutes = 60, PriceZar = 120m, SortOrder = 1, CreatedByUserId = c.AdminId,
        };
        await c.WriteAsync(r.App, db => { db.MinutePackages.Add(package); return Task.CompletedTask; });

        var response = await c.Member(r.App, c.AdminId, "admin").PostAsJsonAsync($"/api/v1/admin/minutes/{c.Pam}/sell", new
        {
            packageId = package.Id, reasonCode = "top_up_cash", reason = "Desk",
            quotedPriceZar = 120m, zarReceived = (decimal)rand,
        });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());

        DomainEvent? sale = null;
        for (var i = 0; i < 50 && sale is null; i++)
        {
            sale = r.Bus.Seen().FirstOrDefault(e => e.Type == MinutesEvents.SoldAtDesk);
            if (sale is null) await Task.Delay(100);
        }
        Assert.NotNull(sale);
        Assert.Equal((decimal)rand, Assert.IsType<decimal>(sale.Data["zar_received"]));
        Assert.Equal(given, Assert.IsType<bool>(sale.Data["given"]));
    }

    // ------------------------------------------------------------------ X15-6 / E15-2 / J15-3

    /// <summary>
    /// The wallet stream says a movement in its NAMED frame first and the legacy unnamed twin after
    /// it, at the same balance — so the twin is never the one a client hears as the movement. Varied
    /// across a refund (member cancel) and a charge (walk-up).
    /// </summary>
    [SkippableTheory]
    [InlineData("cancel")]
    [InlineData("walkup")]
    public async Task The_named_balance_frame_is_sent_before_its_unnamed_twin(string movement)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r15fr{movement[..2]}", 0);
        await using var _ = r.App;
        var c = r.Club;
        var booking = movement == "cancel" ? await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: 120, minutes: 60) : null;
        var bus = r.App.Services.GetRequiredService<IRealtimeBus>();
        var topic = RealtimeTopic.Wallet(c.TenantId, c.Olga);
        var frames = bus.Subscribe(topic);
        try
        {
            var response = booking is not null
                ? await c.Member(r.App, c.Olga).PostAsync($"/api/v1/bookings/{booking.Id}/cancel", null)
                : await r.App.CreateClient().SendAsync(c.WalkUp(c.Code(c.Olga, at: r.Clock.Now), court: 3, nonce: "0f1e2d3c4b5a6978"));
            Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var first = await frames.Reader.ReadAsync(cts.Token);
            var second = await frames.Reader.ReadAsync(cts.Token);
            Assert.Equal(LedgerService.BalanceEvent, first.Event);
            Assert.Equal(string.Empty, second.Event);
            using var a = JsonDocument.Parse(first.JsonPayload);
            using var b = JsonDocument.Parse(second.JsonPayload);
            Assert.Equal(a.RootElement.GetProperty("balance_minutes").GetInt32(), b.RootElement.GetProperty("balance_minutes").GetInt32());
        }
        finally
        {
            bus.Unsubscribe(topic, frames);
        }
    }
}
