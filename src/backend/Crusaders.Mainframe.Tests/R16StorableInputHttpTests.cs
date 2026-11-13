using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 16, lane BE16a, D16-1 (and D16-5's server half): no 500 on a value the database cannot
/// store or the clock cannot represent.
///
/// <para>
/// The reviewer's fuzz on the live stack answered <c>500 internal_error</c> for: a heartbeat version past
/// 32 characters or carrying <c>\u0000</c>, a capability carrying one; an admin's board name or gate key
/// carrying one; a webhook's description or filter carrying one; an anonymous <c>POST /auth/login</c>
/// email carrying one; and an <c>/events</c> upload whose event uptime was 2^53 ms behind its batch
/// (<c>DateTimeOffset</c> overflow). Now each is a 400 with a code, or — on the device routes, where a
/// 400 drops the event and a heartbeat refused is a box with no roster — read leniently with the fault on
/// the club's error log.
/// </para>
/// </summary>
public sealed class R16StorableInputHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private sealed record Rig(MemberCodeClub Club, WebApplicationFactory<Program> App, HttpClient Http, PinnedClock Clock);

    private async Task<Rig> RigAsync(string prefix, TestWebAppFactory? host = null)
    {
        var clock = new PinnedClock(DateTimeOffset.UtcNow.Storable());
        var app = MemberCodeClub.Wired(host ?? pg.SharedHost, new StubEmailService(), clock);
        var club = await MemberCodeClub.SeedAsync(app, prefix, MemberCodeClub.SettingsAtNoon());
        return new Rig(club, app, app.CreateClient(), clock);
    }

    private static async Task<(HttpStatusCode Status, string Text)> SendAsync(HttpClient http, HttpRequestMessage req)
    {
        var response = await http.SendAsync(req);
        return (response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    private static string? ErrorOf(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : null;
    }

    /// <summary>The club's <c>malformed_body</c> rows, polled: the fault is filed off the request thread.</summary>
    private static async Task<List<DeviceError>> MalformedFaultsAsync(Rig r)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (true)
        {
            var rows = await r.Club.ReadAsync(r.App, db => db.DeviceErrors.IgnoreQueryFilters().AsNoTracking()
                .Where(e => e.TenantId == r.Club.TenantId && e.Code == DeviceErrorCodes.MalformedBody).ToListAsync());
            if (rows.Count > 0 || DateTime.UtcNow > deadline) return rows;
            await Task.Delay(100);
        }
    }

    /// <summary>D16-5: the headline the admin monitoring list serves for the club's one malformed_body row.</summary>
    private static async Task<string> HeadlineAsync(Rig r)
    {
        var admin = r.Club.Member(r.App, r.Club.AdminId, "admin");
        using var doc = JsonDocument.Parse(await admin.GetStringAsync("/api/v1/admin/monitoring/errors"));
        var row = doc.RootElement.GetProperty("rows").EnumerateArray().Single(e => e.GetProperty("code").GetString() == DeviceErrorCodes.MalformedBody);
        return row.GetProperty("headline").GetString()!;
    }

    private static Task<Device> BoxAsync(Rig r) =>
        r.Club.ReadAsync(r.App, db => db.Devices.IgnoreQueryFilters().AsNoTracking().SingleAsync(d => d.MacAddress == r.Club.BoxMac));

    // ------------------------------------------------------------------ heartbeat

    /// <summary>
    /// A version past the column (33 characters) under either name, or the Mega's: the heartbeat is
    /// answered (the roster with it — a diagnostic must not take the box out of service), the row KEEPS
    /// the version it had rather than a cut string, and the board's error log says why.
    /// </summary>
    [SkippableTheory]
    [InlineData("firmware_version")]
    [InlineData("running_version")]
    [InlineData("mega_version")]
    public async Task A_heartbeat_version_too_long_to_keep_is_answered_and_not_kept(string field)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r16av{field[..2]}");
        await using var _ = r.App;
        (await r.Http.SendAsync(r.Club.Device("/api/v1/device/heartbeat", new JsonObject
        {
            ["mac"] = r.Club.BoxMac, ["firmware_version"] = "2.2.6", ["mega_version"] = "2.0.0", ["uptime_ms"] = 1000,
        }))).EnsureSuccessStatusCode();

        var body = new JsonObject { ["mac"] = r.Club.BoxMac, ["uptime_ms"] = 2000, [field] = new string('9', 33) };
        var (status, text) = await SendAsync(r.Http, r.Club.Device("/api/v1/device/heartbeat", body));

        Assert.True(status == HttpStatusCode.OK, $"{(int)status} {text}");
        var box = await BoxAsync(r);
        Assert.Equal("2.2.6", box.RunningVersion);
        Assert.Equal("2.0.0", box.MegaVersion);
        var fault = Assert.Single(await MalformedFaultsAsync(r));
        Assert.Equal(box.Id, fault.DeviceId);
        Assert.Contains(DeviceEndpoints.VersionTooLongDetail, fault.Detail, StringComparison.Ordinal);
        Assert.Equal(DeviceErrorCodes.MalformedBodyVersionHeadline, await HeadlineAsync(r));
    }

    /// <summary>Varied: exactly 32 characters is a version, kept as sent, and files nothing.</summary>
    [SkippableFact]
    public async Task A_heartbeat_version_of_exactly_32_characters_is_kept()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r16av32");
        await using var _ = r.App;
        var version = new string('7', 32);

        (await r.Http.SendAsync(r.Club.Device("/api/v1/device/heartbeat", new JsonObject
        {
            ["mac"] = r.Club.BoxMac, ["firmware_version"] = version, ["mega_version"] = version, ["uptime_ms"] = 1000,
        }))).EnsureSuccessStatusCode();

        var box = await BoxAsync(r);
        Assert.Equal(version, box.RunningVersion);
        Assert.Equal(version, box.MegaVersion);
        await Task.Delay(300);
        Assert.Empty(await r.Club.ReadAsync(r.App, db => db.DeviceErrors.IgnoreQueryFilters().AsNoTracking()
            .Where(e => e.TenantId == r.Club.TenantId && e.Code == DeviceErrorCodes.MalformedBody).ToListAsync()));
    }

    /// <summary>
    /// A NUL in a version or a capability: read like a garbled byte (U+FFFD), the heartbeat answered with
    /// its roster, and a <c>malformed_body</c> fault in plain words — "some characters … replaced", never
    /// the "could not be read at all" of a body that is not JSON (D16-5).
    /// </summary>
    [SkippableTheory]
    [InlineData("firmware_version")]
    [InlineData("mega_version")]
    [InlineData("caps")]
    public async Task A_heartbeat_field_carrying_a_nul_is_read_with_a_replacement_not_500(string field)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r16an{field[..2]}");
        await using var _ = r.App;
        var nul = field == "caps" ? "[\"codes:m1\",\"x\\u0000y\"]" : "\"2.\\u00002\"";
        var json = $$"""{"mac":"{{r.Club.BoxMac}}","uptime_ms":1000,"{{field}}":{{nul}}}""";
        var req = r.Club.Device("/api/v1/device/heartbeat", new JsonObject());
        req.Content = new StringContent(json, Encoding.UTF8, "application/json");

        var (status, text) = await SendAsync(r.Http, req);

        Assert.True(status == HttpStatusCode.OK, $"{(int)status} {text}");
        using var doc = JsonDocument.Parse(text);
        Assert.True(doc.RootElement.TryGetProperty("roster", out var roster), text);
        Assert.Equal(JsonValueKind.Array, roster.ValueKind);
        var fault = Assert.Single(await MalformedFaultsAsync(r));
        Assert.Equal("heartbeat: " + DeviceBody.ReplacedDetail, fault.Detail);
        Assert.DoesNotContain("U+FFFD", fault.Detail, StringComparison.Ordinal);
        // D16-5: the title says the message WAS read — no "could not read", no jargon.
        var headline = await HeadlineAsync(r);
        Assert.Equal(DeviceErrorCodes.MalformedBodyReadAnywayHeadline, headline);
        foreach (var jargon in new[] { "could not read", "UTF", "FFFD", "JSON", "body" }) Assert.DoesNotContain(jargon, headline, StringComparison.OrdinalIgnoreCase);
        if (field != "caps")
        {
            var box = await BoxAsync(r);
            Assert.Equal("2.\uFFFD2", field == "mega_version" ? box.MegaVersion : box.RunningVersion);
        }
    }

    /// <summary>An escaped backslash followed by <c>u0000</c> is six characters of text, not a NUL: unchanged, nothing filed.</summary>
    [Fact]
    public void An_escaped_backslash_before_u0000_is_not_read_as_a_nul()
    {
        var text = Encoding.UTF8.GetBytes("""{"a":"\\u0000","b":"\u0000","c":"\\\u0000"}""");
        var copy = (byte[])text.Clone();

        Assert.True(DeviceBody.ReplaceNulEscapes(copy));

        Assert.Equal("""{"a":"\\u0000","b":"\uFFFD","c":"\\\uFFFD"}""", Encoding.UTF8.GetString(copy));
        Assert.False(DeviceBody.ReplaceNulEscapes(Encoding.UTF8.GetBytes("""{"a":"\\u0000x"}""")));
    }

    /// <summary>D16-5: a body that cannot be read at all says so in plain words, distinct from the replaced read.</summary>
    [SkippableFact]
    public async Task A_body_that_cannot_be_read_at_all_files_the_plain_unreadable_words()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r16anj");
        await using var _ = r.App;
        var req = r.Club.Device("/api/v1/device/heartbeat", new JsonObject());
        req.Content = new StringContent($$"""{"mac":"{{r.Club.BoxMac}}","uptime_ms":""", Encoding.UTF8, "application/json");

        var (status, text) = await SendAsync(r.Http, req);

        Assert.Equal(HttpStatusCode.BadRequest, status);
        Assert.Equal(DeviceErrorCodes.MalformedBody, ErrorOf(text));
        var fault = Assert.Single(await MalformedFaultsAsync(r));
        Assert.Equal("heartbeat: " + DeviceBody.NotJsonDetail, fault.Detail);
        Assert.NotEqual(DeviceBody.ReplacedDetail, DeviceBody.NotJsonDetail);
        Assert.DoesNotContain("JSON", fault.Detail, StringComparison.Ordinal);
        Assert.Equal("A board sent something the server could not read", await HeadlineAsync(r));
    }

    // ------------------------------------------------------------------ /events time arithmetic

    /// <summary>
    /// An event uptime 2^53 ms behind its batch (and, varied, 2^53 AHEAD, and a batch at long.MaxValue
    /// over an event at long.MinValue, which overflowed the subtraction): receipted, its time clamped to
    /// the upload as every broken counter is, the desk told by <c>clock_clamped</c> — never 500.
    /// </summary>
    [SkippableTheory]
    [InlineData(100_000_000L, 100_000_000L - 9_007_199_254_740_992L)]
    [InlineData(100_000_000L, 100_000_000L + 9_007_199_254_740_992L)]
    [InlineData(long.MaxValue, long.MinValue)]
    public async Task An_event_uptime_past_the_calendar_is_clamped_not_500(long batchUptime, long eventUptime)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r16up{(batchUptime == long.MaxValue ? "m" : eventUptime < 0 ? "b" : "f")}");
        await using var _ = r.App;
        var body = new JsonObject
        {
            ["mac"] = r.Club.BoxMac, ["boot_id"] = 7, ["uptime_ms"] = batchUptime,
            ["events"] = new JsonArray(new JsonObject
            {
                ["seq"] = 14, ["uptime_ms"] = eventUptime, ["kind"] = "activation", ["court"] = 0, ["method"] = "qr",
                ["subject"] = "NOBODY", ["duration_ms"] = 600_000,
            }),
        };

        var (status, text) = await SendAsync(r.Http, r.Club.Device("/api/v1/device/events", body));

        Assert.True(status == HttpStatusCode.OK, $"{(int)status} {text}");
        using var doc = JsonDocument.Parse(text);
        Assert.Equal(14, doc.RootElement.GetProperty("accepted_through").GetInt64());
        var clamped = await r.Club.ReadAsync(r.App, db => db.AuditLogs.IgnoreQueryFilters().AsNoTracking()
            .CountAsync(a => a.TenantId == r.Club.TenantId && a.Action == "device.event_time_clamped"));
        Assert.Equal(1, clamped);
    }

    /// <summary>
    /// A release whose duration is past the calendar, paired against a real lit session: the implied end
    /// saturates and does not pair (unpaired, receipted) — it overflowed <c>AddMilliseconds</c> and 500'd.
    /// </summary>
    [SkippableFact]
    public async Task A_release_whose_duration_is_past_the_calendar_is_receipted_not_500()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r16rel");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -5, minutes: 60);
        (await r.Http.SendAsync(c.Events(c.BoxMac, 1, "activation", 0, c.Code(c.Olga, at: r.Clock.Now.AddSeconds(-30)), agoMs: 30_000)))
            .EnsureSuccessStatusCode();

        var release = new JsonObject
        {
            ["mac"] = c.BoxMac, ["boot_id"] = 7, ["uptime_ms"] = 100_000_000,
            ["events"] = new JsonArray(new JsonObject
            {
                ["seq"] = 2, ["uptime_ms"] = 99_999_000, ["kind"] = "release", ["court"] = 0, ["method"] = "button",
                ["subject"] = "", ["duration_ms"] = long.MaxValue,
            }),
        };
        var (status, text) = await SendAsync(r.Http, c.Device("/api/v1/device/events", release));

        Assert.True(status == HttpStatusCode.OK, $"{(int)status} {text}");
        using var doc = JsonDocument.Parse(text);
        Assert.Equal(2, doc.RootElement.GetProperty("accepted_through").GetInt64());
    }

    /// <summary>The arithmetic itself: exact inside the calendar, saturated past either edge, no exception.</summary>
    [Fact]
    public void Device_time_saturates_at_the_calendar_edges()
    {
        var now = new DateTimeOffset(2026, 10, 5, 18, 0, 0, TimeSpan.Zero);
        Assert.Equal(now.AddMilliseconds(-1500), DeviceTime.Add(now, -1500));
        Assert.Equal(DateTimeOffset.MinValue, DeviceTime.Add(now, -DeviceTime.Ago(long.MaxValue, long.MinValue)));
        Assert.Equal(DateTimeOffset.MaxValue, DeviceTime.Add(now, long.MaxValue));
        Assert.Equal(18_446_744_073_709_551_615m, DeviceTime.Ago(long.MaxValue, long.MinValue));
    }

    // ------------------------------------------------------------------ admin and member routes

    private static HttpRequestMessage Json(HttpMethod method, string path, string json) =>
        new(method, path) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    /// <summary>An admin's board name or gate key carrying a NUL: 400 <c>invalid_body</c>, the row untouched.</summary>
    [SkippableTheory]
    [InlineData("name", false)]
    [InlineData("gate_key", true)]
    public async Task An_admin_board_field_carrying_a_nul_is_400_invalid_body(string field, bool door)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r16ad{field[..2]}");
        await using var _ = r.App;
        var mac = door ? r.Club.DoorMac : r.Club.BoxMac;
        var device = await r.Club.ReadAsync(r.App, db => db.Devices.IgnoreQueryFilters().AsNoTracking().SingleAsync(d => d.MacAddress == mac));
        var admin = r.Club.Member(r.App, r.Club.AdminId, "admin");

        var (status, text) = await SendAsync(admin, Json(HttpMethod.Patch, $"/api/v1/admin/devices/{device.Id}", $$"""{"{{field}}":"Fr\u0000ont"}"""));

        Assert.Equal(HttpStatusCode.BadRequest, status);
        Assert.Equal(InternalErrors.InvalidBody, ErrorOf(text));
        var after = await r.Club.ReadAsync(r.App, db => db.Devices.IgnoreQueryFilters().AsNoTracking().SingleAsync(d => d.Id == device.Id));
        Assert.Equal(device.Name, after.Name);
        Assert.Equal(device.GateKey, after.GateKey);
    }

    /// <summary>
    /// A webhook's description or filter carrying a NUL (admin and member routes): 400 <c>invalid_body</c>.
    /// Past its column: 400 with the field's own code and limit. Nothing is created either way.
    /// </summary>
    [SkippableTheory]
    [InlineData("/api/v1/admin/webhooks", "description", "x\\u0000y", "invalid_body")]
    [InlineData("/api/v1/admin/webhooks", "eventFilter", "booking.*\\u0000", "invalid_body")]
    [InlineData("/api/v1/admin/webhooks", "description", "LONG256", "description_too_long")]
    [InlineData("/api/v1/admin/webhooks", "eventFilter", "LONG1025", "event_filter_too_long")]
    public async Task A_webhook_field_that_cannot_be_stored_is_400_with_a_code(string path, string field, string value, string code)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r16wh{field[..2]}{code[..2]}");
        await using var _ = r.App;
        var raw = value.StartsWith("LONG", StringComparison.Ordinal) ? new string('a', int.Parse(value[4..])) : value;
        var client = path.Contains("admin") ? r.Club.Member(r.App, r.Club.AdminId, "admin") : r.Club.Member(r.App, r.Club.Olga);

        var (status, text) = await SendAsync(client, Json(HttpMethod.Post, path,
            $$"""{"urlTemplate":"https://hooks.example.com/x","{{field}}":"{{raw}}"}"""));

        Assert.True(status == HttpStatusCode.BadRequest, $"{(int)status} {text}");
        Assert.Equal(code, ErrorOf(text));
        Assert.Equal(0, await r.Club.ReadAsync(r.App, db => db.WebhookEndpoints.IgnoreQueryFilters().CountAsync(w => w.TenantId == r.Club.TenantId)));
    }

    /// <summary>Varied: a description of exactly 255 characters is stored.</summary>
    [SkippableFact]
    public async Task A_webhook_description_of_exactly_its_column_is_stored()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r16wh255");
        await using var _ = r.App;
        var admin = r.Club.Member(r.App, r.Club.AdminId, "admin");

        var (status, text) = await SendAsync(admin, Json(HttpMethod.Post, "/api/v1/admin/webhooks",
            $$"""{"urlTemplate":"https://hooks.example.com/x","description":"{{new string('a', 255)}}"}"""));

        Assert.True(status == HttpStatusCode.OK, $"{(int)status} {text}");
    }

    private static HttpClient Anonymous(Rig r)
    {
        var client = r.App.CreateClient();
        client.DefaultRequestHeaders.Host = $"{r.Club.Slug}.crusaders.test";
        return client;
    }

    /// <summary>
    /// Anonymous auth routes given a NUL — login (the lookup's parameter alone 500'd), forgot-password,
    /// resend and register: 400, never 500.
    /// </summary>
    [SkippableTheory]
    [InlineData("/api/v1/auth/login", """{"email":"a\u0000b@x.test","password":"whatever1"}""", "invalid_body")]
    [InlineData("/api/v1/auth/forgot-password", """{"email":"a\u0000b@x.test"}""", "invalid_body")]
    [InlineData("/api/v1/auth/resend-verification", """{"email":"a\u0000b@x.test"}""", "invalid_body")]
    [InlineData("/api/v1/auth/register", """{"email":"n@x.test","password":"Longenough1","fullName":"Nina New","membershipNumber":"M\u00001"}""", "invalid_body")]
    public async Task An_auth_input_carrying_a_nul_is_400(string path, string json, string code)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r16au{path[13..16]}");
        await using var _ = r.App;

        var (status, text) = await SendAsync(Anonymous(r), Json(HttpMethod.Post, path, json));

        Assert.True(status == HttpStatusCode.BadRequest, $"{path}: {(int)status} {text}");
        Assert.Equal(code, ErrorOf(text));
    }

    /// <summary>Register past either column: refused by name with the limit, before anything is written.</summary>
    [SkippableTheory]
    [InlineData("email", "email_too_long")]
    [InlineData("membershipNumber", "membership_number_too_long")]
    public async Task A_registration_field_past_its_column_is_400_by_name(string field, string code)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r16rg{field[..2]}");
        await using var _ = r.App;
        var email = field == "email" ? new string('e', 315) + "@x.test" : "fine@x.test";
        var number = field == "membershipNumber" ? new string('9', 65) : "M-1";

        var (status, text) = await SendAsync(Anonymous(r), Json(HttpMethod.Post, "/api/v1/auth/register",
            $$"""{"email":"{{email}}","password":"Longenough1","fullName":"Nina New","membershipNumber":"{{number}}"}"""));

        Assert.True(status == HttpStatusCode.BadRequest, $"{(int)status} {text}");
        Assert.Equal(code, ErrorOf(text));
    }

    // ------------------------------------------------------------------ the safety net

    /// <summary>
    /// Whatever route a value reaches PostgreSQL on, 22001 (too long) and 22021 (a NUL) are the caller's:
    /// 400 <c>invalid_body</c>, <c>malformed_body</c> on a device route — wrapped by EF or bare. Anything
    /// else still 500.
    /// </summary>
    [Theory]
    [InlineData("22001", "/api/v1/admin/webhooks", 400, "invalid_body")]
    [InlineData("22021", "/api/v1/auth/login", 400, "invalid_body")]
    [InlineData("22021", "/api/v1/device/heartbeat", 400, "malformed_body")]
    [InlineData("23514", "/api/v1/admin/webhooks", 500, "internal_error")]   // R18: 23505 is now 503 conflict_retry
    public void A_value_postgres_cannot_store_is_400_not_500(string sqlState, string path, int status, string code)
    {
        var pgError = new Npgsql.PostgresException("refused", "ERROR", "ERROR", sqlState);
        var ctx = new DefaultHttpContext();
        ctx.Request.Method = "POST";
        ctx.Request.Path = path;

        Assert.Equal((status, code), InternalErrors.Classify(new DbUpdateException("save failed", pgError), ctx.Request));
        Assert.Equal((status, code), InternalErrors.Classify(pgError, ctx.Request));
    }
}

/// <summary>
/// Review round 16 (FW16's offer, the server half of D16-2): one board refused 403 must not spend the
/// club's device budget. Bridge 2.2.5 re-posted its head event every pass on a 403 (~5 ms each), the
/// device limiter was one bucket per CLUB, and every other box and the door gate were then answered 429
/// for the rest of the minute. The bucket is now per board (the body's MAC).
/// </summary>
public sealed class R16DeviceRateHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const int Budget = 5;

    private async Task<(MemberCodeClub Club, WebApplicationFactory<Program> App, HttpClient Http, TestWebAppFactory Host)> RigAsync(string prefix)
    {
        var host = new TestWebAppFactory
        {
            ConnectionString = pg.ConnectionString,
            RateLimits = new Dictionary<string, int> { ["DevicePerMinute"] = Budget },
        };
        var app = MemberCodeClub.Wired(host, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, prefix, MemberCodeClub.SettingsAtNoon());
        return (club, app, app.CreateClient(), host);
    }

    /// <summary>
    /// A disabled box spinning on 403 past the budget is 429'd itself — and the door gate (and, varied, a
    /// second court box) on the same club key still gets its answer.
    /// </summary>
    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_board_spinning_on_403_does_not_429_the_other_boards(bool secondIsABox)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var (club, app, http, host) = await RigAsync($"r16rl{(secondIsABox ? "b" : "g")}");
        await using var _h = host;
        await using var _ = app;
        await club.WriteAsync(app, async db =>
        {
            (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == club.BoxMac)).Enabled = false;
        });
        var otherMac = club.DoorMac;
        if (secondIsABox)
        {
            otherMac = Guid.NewGuid().ToString("N")[..12];
            await club.WriteAsync(app, db =>
            {
                db.Devices.Add(new Device
                {
                    TenantId = club.TenantId, DeviceCode = $"box-{otherMac[^6..]}", Name = "Box 2", Kind = DeviceKind.CourtBox,
                    MacAddress = otherMac, CourtNumbers = [1, 2, 3, 4], AutoRegistered = false,
                });
                return Task.CompletedTask;
            });
        }

        var spun = new List<HttpStatusCode>();
        for (var i = 0; i < Budget * 3; i++)
        {
            spun.Add((await http.SendAsync(club.Events(club.BoxMac, 1, "boot", 0, ""))).StatusCode);
        }

        Assert.Contains(HttpStatusCode.Forbidden, spun);
        Assert.Contains(HttpStatusCode.TooManyRequests, spun);
        var other = await http.SendAsync(club.Heartbeat(otherMac, m1: true, kind: secondIsABox ? null : "gate"));
        Assert.Equal(HttpStatusCode.OK, other.StatusCode);
    }

    /// <summary>Varied: one board is still held to its own budget — the per-board bucket is a bucket.</summary>
    [SkippableFact]
    public async Task One_board_past_its_own_budget_is_429()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var (club, app, http, host) = await RigAsync("r16rlown");
        await using var _h = host;
        await using var _ = app;

        var answers = new List<HttpStatusCode>();
        for (var i = 0; i <= Budget; i++) answers.Add((await http.SendAsync(club.Heartbeat(club.BoxMac, m1: true))).StatusCode);

        Assert.Equal(Enumerable.Repeat(HttpStatusCode.OK, Budget), answers.Take(Budget));
        Assert.Equal(HttpStatusCode.TooManyRequests, answers[Budget]);
    }
}
