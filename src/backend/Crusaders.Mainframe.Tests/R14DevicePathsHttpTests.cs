using System.Net;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 14, the device paths over HTTP on Postgres.
///
/// <para>
/// D14-4: one device decision, one clock. <c>/activate</c> and pay-for checked the member code at
/// the injected clock and then handed the activation <c>OccurredAt: null</c>, which read the wall
/// clock — so a code could pass at one instant and the cue gate answer <c>too_early</c> at another,
/// and <c>CheckedInAt</c> was a third instant. <c>/events</c> timed its upload, and the heartbeat its
/// roster and liveness, on the wall clock too.
/// </para>
/// <para>
/// D14-3: an offline activation at a relay the box does not have names its member.
/// E14-6: pay-for at a court whose running session ends inside the cue window, while the next
/// booking's cue window is open, pays for the NEXT booking — the one about to start.
/// </para>
/// </summary>
public sealed class R14DevicePathsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private sealed record Rig(MemberCodeClub Club, WebApplicationFactory<Program> App, HttpClient Device, PinnedClock Clock);

    private async Task<Rig> RigAsync(string prefix, TimeSpan clockFromWall)
    {
        var clock = new PinnedClock(DateTimeOffset.UtcNow.Add(clockFromWall).Storable());
        var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService(), clock);
        var club = await MemberCodeClub.SeedAsync(app, prefix, MemberCodeClub.SettingsAtNoon());
        return new Rig(club, app, app.CreateClient(), clock);
    }

    private static async Task<(HttpStatusCode Status, JsonElement Body)> SendAsync(Rig r, HttpRequestMessage req)
    {
        var response = await r.Device.SendAsync(req);
        var text = await response.Content.ReadAsStringAsync();
        return (response.StatusCode, text.Length > 0 ? JsonDocument.Parse(text).RootElement.Clone() : default);
    }

    private static Task<Booking> RowAsync(Rig r, Guid id) =>
        r.Club.ReadAsync(r.App, db => db.Bookings.IgnoreQueryFilters().AsNoTracking().SingleAsync(b => b.Id == id));

    private static void Near(DateTimeOffset expected, DateTimeOffset? actual, string what) =>
        Assert.True(actual is { } a && (a - expected).Duration() < TimeSpan.FromSeconds(1), $"{what}: {actual:o}, expected {expected:o}");

    // ------------------------------------------------------------------ D14-4

    /// <summary>
    /// The club's clock an hour AHEAD of the wall: the booking's cue window is open at the club's
    /// instant and an hour away at the wall's. The code passes at the club's instant — and the
    /// activation must too. Before R14 it answered <c>too_early</c> from the wall. BEHIND: the scan
    /// is stamped at the club's instant, not the wall's an hour later.
    /// </summary>
    [SkippableTheory]
    [InlineData(60)]
    [InlineData(-60)]
    public async Task An_activation_is_decided_and_stamped_at_one_instant(int clockMinutesFromWall)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r14clk", TimeSpan.FromMinutes(clockMinutesFromWall));
        await using var _ = r.App;
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: clockMinutesFromWall + 5, minutes: 60);

        var (status, body) = await SendAsync(r, c.Activate(c.Code(c.Olga, at: r.Clock.Now)));

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.True(body.GetProperty("activated").GetBoolean(), body.ToString());
        var row = await RowAsync(r, booking.Id);
        Near(r.Clock.Now, row.CheckedInAt, "CheckedInAt");
        // The grant runs from the club's instant to the end: about 65 minutes (the booking was placed by
        // the wall a few seconds after the clock was pinned), never five or 125.
        Assert.InRange(body.GetProperty("granted_seconds").GetInt32(), 64 * 60, 66 * 60);
    }

    /// <summary>The same at pay-for: a confirm that lights the court decides its cue window at the club's instant.</summary>
    [SkippableFact]
    public async Task A_pay_for_that_lights_the_court_is_decided_at_the_clubs_instant()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r14clkp", TimeSpan.FromMinutes(60));
        await using var _ = r.App;
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: 65, minutes: 60);
        var code = c.Code(c.Pam, at: r.Clock.Now);
        const string nonce = "a1b2c3d4e5f60718";

        var quote = await SendAsync(r, c.PayFor(code, 2, nonce, confirm: false));
        Assert.Equal("ok", quote.Body.GetProperty("reason").GetString());
        var paid = await SendAsync(r, c.PayFor(code, 2, nonce, confirm: true, label: "60"));

        Assert.True(paid.Body.GetProperty("paid").GetBoolean(), paid.Body.ToString());
        Assert.True(paid.Body.GetProperty("granted_seconds").GetInt32() > 60 * 60, paid.Body.ToString());
        var row = await RowAsync(r, booking.Id);
        Assert.Equal(c.Pam, row.PaidByUserId);
        Near(r.Clock.Now, row.CheckedInAt, "CheckedInAt");
    }

    /// <summary>The upload's own clock: an event a second old is placed a second before the club's instant.</summary>
    [SkippableFact]
    public async Task An_upload_places_its_events_on_the_clubs_clock()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r14clke", TimeSpan.FromMinutes(60));
        await using var _ = r.App;
        var c = r.Club;
        var scan = r.Clock.Now.AddSeconds(-1);

        var (status, _) = await SendAsync(r, c.Events(c.BoxMac, 1, "activation", 9, c.Code(c.Olga, at: scan), agoMs: 1_000));

        Assert.Equal(HttpStatusCode.OK, status);
        var row = await WrongCourtRowAsync(r);
        using var details = JsonDocument.Parse(row.DetailsJson!);
        Near(scan, details.RootElement.GetProperty("occurred_at").GetDateTimeOffset(), "occurred_at");
        var device = await c.ReadAsync(r.App, db => db.Devices.IgnoreQueryFilters().AsNoTracking().SingleAsync(d => d.MacAddress == c.BoxMac));
        Near(r.Clock.Now, device.LastSeenAt, "LastSeenAt");
    }

    /// <summary>The heartbeat reads the same clock: liveness is the club's instant.</summary>
    [SkippableTheory]
    [InlineData(60)]
    [InlineData(-60)]
    public async Task A_heartbeat_is_on_the_clubs_clock(int clockMinutesFromWall)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r14clkh", TimeSpan.FromMinutes(clockMinutesFromWall));
        await using var _ = r.App;
        var c = r.Club;

        var (status, body) = await SendAsync(r, c.Heartbeat(c.BoxMac, m1: true));

        Assert.Equal(HttpStatusCode.OK, status);
        var device = await c.ReadAsync(r.App, db => db.Devices.IgnoreQueryFilters().AsNoTracking().SingleAsync(d => d.MacAddress == c.BoxMac));
        Near(r.Clock.Now, device.LastSeenAt, "LastSeenAt");
        Assert.NotEqual(JsonValueKind.Undefined, body.ValueKind);
    }

    private static Task<Device> BoxAsync(Rig r) =>
        r.Club.ReadAsync(r.App, db => db.Devices.IgnoreQueryFilters().AsNoTracking().SingleAsync(d => d.MacAddress == r.Club.BoxMac));

    /// <summary>
    /// A shut board's 403 records that it was heard (<c>ShutHeardAt</c>) and that it called
    /// (<c>LastSeenAt</c>) — at the club's instant, on the route that resolves (activate) and the one
    /// that registers (heartbeat). They were the wall clock's.
    /// </summary>
    [SkippableTheory]
    [InlineData("activate")]
    [InlineData("heartbeat")]
    public async Task A_shut_board_is_heard_at_the_clubs_instant(string route)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r14shut{route[..2]}", TimeSpan.FromMinutes(-60));
        await using var _ = r.App;
        var c = r.Club;
        await c.WriteAsync(r.App, async db => (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == c.BoxMac)).Enabled = false);

        var (status, _) = await SendAsync(r, route == "activate" ? c.Activate(c.Code(c.Olga, at: r.Clock.Now)) : c.Heartbeat(c.BoxMac, m1: true));

        Assert.Equal(HttpStatusCode.Forbidden, status);
        var box = await BoxAsync(r);
        Near(r.Clock.Now, box.ShutHeardAt, "ShutHeardAt");
        Near(r.Clock.Now, box.LastSeenAt, "LastSeenAt");
    }

    /// <summary>
    /// The use a code's online activation claims is stamped at the club's instant — and that is what
    /// the box's offline twin of the SAME scan is matched against (<c>SameActTolerance</c>). With the
    /// claim on the wall clock an hour away, the twin read as a second use of the code.
    /// </summary>
    [SkippableFact]
    public async Task A_code_use_is_claimed_at_the_clubs_instant_and_its_offline_twin_is_the_same_act()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r14use", TimeSpan.FromMinutes(-60));
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -55, minutes: 60);
        var code = c.Code(c.Olga, at: r.Clock.Now);

        var (_, body) = await SendAsync(r, c.Activate(code));
        Assert.True(body.GetProperty("activated").GetBoolean(), body.ToString());
        var use = await c.ReadAsync(r.App, db => db.MemberCodeUses.IgnoreQueryFilters().AsNoTracking().SingleAsync(u => u.TenantId == c.TenantId));
        Near(r.Clock.Now, use.UsedAt, "UsedAt");

        var (status, _) = await SendAsync(r, c.Events(c.BoxMac, 1, "activation", 0, code, agoMs: 0));
        Assert.Equal(HttpStatusCode.OK, status);
        var actions = await c.ReadAsync(r.App, db => db.AuditLogs.IgnoreQueryFilters().AsNoTracking()
            .Where(a => a.TenantId == c.TenantId && a.Action.StartsWith("device.activation")).Select(a => a.Action).ToListAsync());
        Assert.DoesNotContain(actions, a => a.Contains("forgery") || a.Contains("code_used"));
    }

    /// <summary>The control board's live frame for a lit court is timed at the club's instant, and its countdown runs from it.</summary>
    [SkippableFact]
    public async Task The_control_board_frame_is_timed_on_the_clubs_clock()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r14cbf", TimeSpan.FromMinutes(-60));
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -55, minutes: 60);
        var bus = r.App.Services.GetRequiredService<IRealtimeBus>();
        var topic = RealtimeTopic.ControlBoard(c.TenantId);
        var frames = bus.Subscribe(topic);
        try
        {
            var (_, body) = await SendAsync(r, c.Activate(c.Code(c.Olga, at: r.Clock.Now)));
            Assert.True(body.GetProperty("activated").GetBoolean(), body.ToString());

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            RealtimeMessage frame;
            do frame = await frames.Reader.ReadAsync(cts.Token);
            while (frame.Event != "court");
            using var json = JsonDocument.Parse(frame.JsonPayload);
            Near(r.Clock.Now, json.RootElement.GetProperty("at").GetDateTimeOffset(), "at");
            var remaining = json.RootElement.GetProperty("lights").GetProperty("seconds_remaining").GetInt32();
            Assert.InRange(remaining, 64 * 60, 66 * 60);
        }
        finally
        {
            bus.Unsubscribe(topic, frames);
        }
    }

    /// <summary>The door's route resolves its board at the same instant: a shut door is heard at the club's clock too.</summary>
    [SkippableFact]
    public async Task A_shut_door_is_heard_at_the_clubs_instant()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r14shutg", TimeSpan.FromMinutes(-60));
        await using var _ = r.App;
        var c = r.Club;
        await c.WriteAsync(r.App, async db => (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == c.DoorMac)).Enabled = false);

        var (status, _) = await SendAsync(r, c.Gate(c.Code(c.Olga, at: r.Clock.Now)));

        Assert.Equal(HttpStatusCode.Forbidden, status);
        var door = await c.ReadAsync(r.App, db => db.Devices.IgnoreQueryFilters().AsNoTracking().SingleAsync(d => d.MacAddress == c.DoorMac));
        Near(r.Clock.Now, door.ShutHeardAt, "ShutHeardAt");
        Near(r.Clock.Now, door.LastSeenAt, "LastSeenAt");
    }

    /// <summary>
    /// The control board's snapshot reads the same clock as the light it shows: generated at the
    /// club's instant, the countdown from it, and a court lit a moment ago is not stale.
    /// </summary>
    [SkippableTheory]
    [InlineData(60)]
    [InlineData(-60)]
    public async Task The_control_board_snapshot_is_on_the_clubs_clock(int clockMinutesFromWall)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r14cbs{(clockMinutesFromWall > 0 ? "a" : "b")}", TimeSpan.FromMinutes(clockMinutesFromWall));
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: clockMinutesFromWall + 5, minutes: 60);
        var (_, activated) = await SendAsync(r, c.Activate(c.Code(c.Olga, at: r.Clock.Now)));
        Assert.True(activated.GetProperty("activated").GetBoolean(), activated.ToString());

        var response = await c.Member(r.App, c.AdminId, "admin").GetAsync("/api/v1/admin/control-board");
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, text);
        using var json = JsonDocument.Parse(text);
        Near(r.Clock.Now, json.RootElement.GetProperty("generated_at").GetDateTimeOffset(), "generated_at");
        var lights = json.RootElement.GetProperty("courts").EnumerateArray()
            .Single(t => t.GetProperty("court_number").GetInt32() == 1).GetProperty("lights");
        Assert.InRange(lights.GetProperty("seconds_remaining").GetInt32(), 64 * 60, 66 * 60);
        Assert.False(lights.GetProperty("stale").GetBoolean(), lights.ToString());
    }

    // ------------------------------------------------------------------ D14-3

    private static async Task<AuditLog> WrongCourtRowAsync(Rig r)
    {
        var rows = await r.Club.ReadAsync(r.App, db => db.AuditLogs.IgnoreQueryFilters().AsNoTracking()
            .Where(a => a.TenantId == r.Club.TenantId).ToListAsync());
        return Assert.Single(rows, a => a.Action == "device.activation_wrong_court");
    }

    /// <summary>
    /// A v1 code at a relay the box does not have is refused <c>wrong_court</c> — and the row names
    /// the member whose code it was, as the <c>unresolved</c> refusal beside it already did.
    /// </summary>
    [SkippableTheory]
    [InlineData(4)]
    [InlineData(9)]
    public async Task A_wrong_court_upload_names_its_member(int relay)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r14wc", TimeSpan.Zero);
        await using var _ = r.App;
        var c = r.Club;

        var (status, _) = await SendAsync(r, c.Events(c.BoxMac, 1, "activation", relay, c.Code(c.Olga, at: r.Clock.Now.AddSeconds(-1)), agoMs: 1_000));

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(c.Olga, (await WrongCourtRowAsync(r)).SubjectUserId);
    }

    // ------------------------------------------------------------------ E14-6

    /// <summary>
    /// Court 2: Olga's 60-minute session is running and ends in five minutes; the admin's 30-minute
    /// booking starts then, its cue window open. The payer at the box is paying for the court about
    /// to start, not the one about to end: the quote names 30, and the confirm lights the next one.
    /// </summary>
    [SkippableFact]
    public async Task Pay_for_beside_a_dying_session_pays_for_the_next_booking()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r14pfn", TimeSpan.Zero);
        await using var _ = r.App;
        var c = r.Club;
        var running = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -55, minutes: 60, checkedIn: true);
        var next = await c.BookAsync(r.App, c.AdminId, courtIndex: 1, startsInMinutes: 5, minutes: 30);
        var code = c.Code(c.Pam, at: r.Clock.Now);
        const string nonce = "0f1e2d3c4b5a6978";

        var quote = await SendAsync(r, c.PayFor(code, 2, nonce, confirm: false));
        Assert.Equal(30, quote.Body.GetProperty("amount_minutes").GetInt32());
        var paid = await SendAsync(r, c.PayFor(code, 2, nonce, confirm: true, label: "30"));

        Assert.True(paid.Body.GetProperty("paid").GetBoolean(), paid.Body.ToString());
        Assert.True(paid.Body.GetProperty("granted_seconds").GetInt32() > 30 * 60, paid.Body.ToString());
        Assert.Equal(c.Pam, (await RowAsync(r, next.Id)).PaidByUserId);
        Assert.Equal(c.Olga, (await RowAsync(r, running.Id)).PaidByUserId);
    }

    /// <summary>
    /// Varied: with nobody next — or the next booking's cue window not yet open — the running
    /// session is still the one paid for (§9.2 unchanged).
    /// </summary>
    [SkippableTheory]
    [InlineData(null)]
    [InlineData(20)]
    public async Task Pay_for_with_no_next_booking_in_its_cue_window_pays_for_the_running_one(int? nextStartsIn)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r14pfr", TimeSpan.Zero);
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -55, minutes: 60, checkedIn: true);
        if (nextStartsIn is { } at) await c.BookAsync(r.App, c.AdminId, courtIndex: 1, startsInMinutes: at, minutes: 30);

        var quote = await SendAsync(r, c.PayFor(c.Code(c.Pam, at: r.Clock.Now), 2, "1234567890abcdef", confirm: false));

        Assert.Equal(60, quote.Body.GetProperty("amount_minutes").GetInt32());
    }
}
