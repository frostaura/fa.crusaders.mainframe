using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 15, D15-1 (server half) and D15-3: a body the server cannot read.
///
/// <para>
/// The Mega passes any scanned byte, and the bridge put a scan's raw bytes into its bodies. A
/// subject of <c>41 E9 42</c> (invalid UTF-8) answered <c>POST /device/events</c> with 500, which the
/// firmware treats as transient: it retried the head of its queue for ever, its breaker tripped,
/// and the box sat <c>apiDown</c> with every later attendance event pinned behind one garbled scan.
/// Unreadable JSON on every route answered 500 too (the stable-error handler mapped every exception
/// there), and <c>malformed_body</c> was a device error code nothing ever raised.
/// </para>
/// <para>
/// Now: a device body's invalid UTF-8 is read leniently (each bad sequence becomes U+FFFD), so the
/// event is receipted and the drain moves on; a device body that still is not JSON is
/// <c>400 malformed_body</c> plus a server-detected <c>malformed_body</c> fault on the club's error
/// log; a member body that is not JSON is <c>400 invalid_body</c>. Never 500.
/// </para>
/// </summary>
public sealed class R15DeviceBodyHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private sealed record Rig(MemberCodeClub Club, WebApplicationFactory<Program> App, HttpClient Http, PinnedClock Clock);

    private async Task<Rig> RigAsync(string prefix)
    {
        var clock = new PinnedClock(DateTimeOffset.UtcNow.Storable());
        var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService(), clock);
        var club = await MemberCodeClub.SeedAsync(app, prefix, MemberCodeClub.SettingsAtNoon());
        return new Rig(club, app, app.CreateClient(), clock);
    }

    private static HttpRequestMessage Raw(Rig r, string path, byte[] body)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, path) { Content = new ByteArrayContent(body) };
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", r.Club.DeviceKey);
        return req;
    }

    /// <summary>The bytes of <paramref name="json"/>, with every <c>~</c> replaced by the raw byte 0xE9 — a lone Latin-1 é, invalid UTF-8.</summary>
    private static byte[] WithBadByte(string json) =>
        [.. Encoding.UTF8.GetBytes(json).Select(b => b == (byte)'~' ? (byte)0xE9 : b)];

    private static async Task<(HttpStatusCode Status, string Text)> SendAsync(Rig r, HttpRequestMessage req)
    {
        var response = await r.Http.SendAsync(req);
        return (response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    private static string? ErrorOf(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : null;
    }

    /// <summary>The club's open <c>malformed_body</c> rows, polled: the fault is filed off the request thread.</summary>
    private static async Task<List<DeviceError>> MalformedFaultsAsync(Rig r, int atLeast = 1)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (true)
        {
            var rows = await r.Club.ReadAsync(r.App, db => db.DeviceErrors.IgnoreQueryFilters().AsNoTracking()
                .Where(e => e.TenantId == r.Club.TenantId && e.Code == DeviceErrorCodes.MalformedBody).ToListAsync());
            if (rows.Count >= atLeast || DateTime.UtcNow > deadline) return rows;
            await Task.Delay(100);
        }
    }

    private string EventsBody(Rig r, string subjectRaw, int seqs = 1, string? secondSubject = null)
    {
        var events = new List<string>
        {
            $$"""{"seq":1,"uptime_ms":99999000,"kind":"activation","court":0,"method":"qr","subject":"{{subjectRaw}}","duration_ms":600000}""",
        };
        if (seqs > 1)
        {
            events.Add($$"""{"seq":2,"uptime_ms":99999500,"kind":"activation","court":0,"method":"qr","subject":"{{secondSubject}}","duration_ms":600000}""");
        }
        return $$"""{"mac":"{{r.Club.BoxMac}}","boot_id":7,"uptime_ms":100000000,"events":[{{string.Join(",", events)}}]}""";
    }

    // ------------------------------------------------------------------ D15-1: invalid UTF-8

    /// <summary>
    /// The finding's own repro: subject bytes <c>41 E9 42</c>. Receipted (200, <c>accepted_through</c>
    /// covers it), read as a code nobody holds — the drain moves on — and the box is not refused.
    /// </summary>
    [SkippableFact]
    public async Task An_event_whose_subject_is_invalid_utf8_is_receipted_not_500()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r15utf");
        await using var _ = r.App;

        var (status, text) = await SendAsync(r, Raw(r, "/api/v1/device/events", WithBadByte(EventsBody(r, "A~B"))));

        Assert.Equal(HttpStatusCode.OK, status);
        using var body = JsonDocument.Parse(text);
        Assert.Equal(1, body.RootElement.GetProperty("accepted_through").GetInt64());
        var rows = await r.Club.ReadAsync(r.App, db => db.AuditLogs.IgnoreQueryFilters().AsNoTracking()
            .Where(a => a.TenantId == r.Club.TenantId && a.Action.StartsWith("device.activation")).Select(a => a.Action).ToListAsync());
        Assert.Contains("device.activation_unresolved", rows);
    }

    /// <summary>
    /// Varied: the garbled scan is the HEAD of a two-event batch whose second event is a genuine
    /// offline activation. Both are receipted, and the genuine one is attendance — the evidence
    /// behind a garbled byte is never lost with it.
    /// </summary>
    [SkippableFact]
    public async Task A_garbled_head_does_not_cost_the_genuine_activation_behind_it()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r15utf2");
        await using var _ = r.App;
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -5, minutes: 60);
        var genuine = c.Code(c.Olga, at: r.Clock.Now.AddMilliseconds(-500));

        var (status, text) = await SendAsync(r, Raw(r, "/api/v1/device/events", WithBadByte(EventsBody(r, "A~B", 2, genuine))));

        Assert.Equal(HttpStatusCode.OK, status);
        using var body = JsonDocument.Parse(text);
        Assert.Equal(2, body.RootElement.GetProperty("accepted_through").GetInt64());
        var row = await c.ReadAsync(r.App, db => db.Bookings.IgnoreQueryFilters().AsNoTracking().SingleAsync(b => b.Id == booking.Id));
        Assert.NotNull(row.CheckedInAt);
    }

    /// <summary>The online routes read a garbled token as a code nobody holds: a refusal the box can show, never 500.</summary>
    [SkippableTheory]
    [InlineData("activate")]
    [InlineData("walkup")]
    [InlineData("pay-for")]
    [InlineData("gate")]
    public async Task An_online_scan_with_invalid_utf8_is_refused_not_500(string route)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r15on{route[..2]}");
        await using var _ = r.App;
        var c = r.Club;
        var mac = route == "gate" ? c.DoorMac : c.BoxMac;
        var json = route switch
        {
            "walkup" => $$"""{"mac":"{{mac}}","minutes":15,"method":"qr","token":"A~B","court":1,"nonce":"0123456789abcdef"}""",
            "pay-for" => $$"""{"mac":"{{mac}}","method":"qr","token":"A~B","court":1,"nonce":"0123456789abcdef","confirm":false}""",
            _ => $$"""{"mac":"{{mac}}","method":"qr","token":"A~B"}""",
        };

        var (status, text) = await SendAsync(r, Raw(r, $"/api/v1/device/{route}", WithBadByte(json)));

        Assert.True((int)status < 500, $"{route}: {(int)status} {text}");
        Assert.NotEqual(DeviceErrorCodes.MalformedBody, ErrorOf(text));
    }

    // ------------------------------------------------------------------ D15-1 / D15-3: not JSON

    /// <summary>
    /// A body that is not JSON at all — an unescaped quote inside a token, as the bridge's bare %s
    /// produced — on every device route: <c>400 malformed_body</c>, and one server-detected
    /// <c>malformed_body</c> fault naming the route, against the board when its MAC can be read.
    /// </summary>
    [SkippableTheory]
    [InlineData("events")]
    [InlineData("activate")]
    [InlineData("walkup")]
    [InlineData("pay-for")]
    [InlineData("heartbeat")]
    [InlineData("gate")]
    public async Task A_device_body_that_is_not_json_is_400_malformed_body_and_a_fault(string route)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r15mb{route[..2]}");
        await using var _ = r.App;
        var mac = route == "gate" ? r.Club.DoorMac : r.Club.BoxMac;
        var json = $$"""{"mac":"{{mac}}","method":"qr","token":"A"B","court":1}""";

        var (status, text) = await SendAsync(r, Raw(r, $"/api/v1/device/{route}", Encoding.UTF8.GetBytes(json)));

        Assert.Equal(HttpStatusCode.BadRequest, status);
        Assert.Equal(DeviceErrorCodes.MalformedBody, ErrorOf(text));
        var fault = Assert.Single(await MalformedFaultsAsync(r));
        Assert.Equal(DeviceErrorSource.Server, fault.Source);
        Assert.Contains(route, fault.Detail);
        var device = await r.Club.ReadAsync(r.App, db => db.Devices.IgnoreQueryFilters().AsNoTracking().SingleAsync(d => d.MacAddress == mac));
        Assert.Equal(device.Id, fault.DeviceId);
    }

    /// <summary>
    /// Varied: a cut body naming no readable MAC is still 400 <c>malformed_body</c>; its fault is
    /// folded into ONE row for the club, however many arrive (anything holding the key could
    /// otherwise open a row per invented body).
    /// </summary>
    [SkippableFact]
    public async Task Cut_bodies_with_no_mac_fold_into_one_fault()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r15cut");
        await using var _ = r.App;

        foreach (var cut in new[] { "{\"mac\":", "{\"events\":[{\"seq\":1,", "" })
        {
            var (status, text) = await SendAsync(r, Raw(r, "/api/v1/device/events", Encoding.UTF8.GetBytes(cut)));
            Assert.Equal(HttpStatusCode.BadRequest, status);
            Assert.Equal(DeviceErrorCodes.MalformedBody, ErrorOf(text));
        }

        var deadline = DateTime.UtcNow.AddSeconds(10);
        List<DeviceError> rows;
        do
        {
            rows = await MalformedFaultsAsync(r);
            if (rows.Sum(x => x.Count) >= 3) break;
            await Task.Delay(100);
        }
        while (DateTime.UtcNow < deadline);
        var row = Assert.Single(rows);
        Assert.Null(row.DeviceId);
        Assert.Equal(3, row.Count);
    }

    /// <summary>A device key that is wrong never reaches the body: 401, and nothing is filed against any club.</summary>
    [SkippableFact]
    public async Task An_unauthenticated_garbled_body_is_401_and_files_nothing()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r15anon");
        await using var _ = r.App;
        var req = Raw(r, "/api/v1/device/events", Encoding.UTF8.GetBytes("{\"mac\":"));
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "not-the-key");

        var (status, _) = await SendAsync(r, req);

        Assert.Equal(HttpStatusCode.Unauthorized, status);
        await Task.Delay(300);
        Assert.Empty(await r.Club.ReadAsync(r.App, db => db.DeviceErrors.IgnoreQueryFilters().AsNoTracking()
            .Where(e => e.TenantId == r.Club.TenantId).ToListAsync()));
    }

    // ------------------------------------------------------------------ D15-3: member routes

    private static HttpClient Anonymous(Rig r)
    {
        var client = r.App.CreateClient();
        client.DefaultRequestHeaders.Host = $"{r.Club.Slug}.crusaders.test";
        return client;
    }

    /// <summary>
    /// A member route given a body it cannot read — cut JSON, a wrong type, invalid UTF-8 — is
    /// <c>400 invalid_body</c>, signed in or not. It answered 500 <c>internal_error</c> on the live
    /// (Development) stack and an empty 400 elsewhere.
    /// </summary>
    [SkippableTheory]
    [InlineData("cut")]
    [InlineData("type")]
    [InlineData("utf8")]
    public async Task A_member_body_that_cannot_be_read_is_400_invalid_body(string shape)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r15ib{shape}");
        await using var _ = r.App;
        var bytes = shape switch
        {
            "cut" => Encoding.UTF8.GetBytes("{\"courtId\":"),
            "type" => Encoding.UTF8.GetBytes("{\"courtId\":5,\"startsAt\":true,\"email\":5}"),
            _ => WithBadByte("{\"courtId\":\"~\",\"email\":\"~\"}"),
        };

        foreach (var (path, client) in new[]
        {
            ("/api/v1/bookings", r.Club.Member(r.App, r.Club.Olga)),
            ("/api/v1/auth/login", Anonymous(r)),
        })
        {
            var content = new ByteArrayContent(bytes);
            content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            var response = await client.PostAsync(path, content);
            var text = await response.Content.ReadAsStringAsync();

            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"{path}: {(int)response.StatusCode} {text}");
            Assert.Equal("invalid_body", ErrorOf(text));
        }
    }

    // ------------------------------------------------------------------ D15-1: the bridge 2.2.5 corpus

    /// <summary>
    /// The vector's path and body — or, for pay-for, the same escaped body INLINE. D10 pay-for left
    /// the court box's image in v3, so its vector left the <c>http/</c> family the firmware reads
    /// (<c>membercode/payfor.json</c> holds the server's bodies); the server still answers the route,
    /// and its escape coverage is kept here byte for byte as the removed vector had it.
    /// </summary>
    private static (string Path, string Body) EscapedScan(string id)
    {
        if (id == "payfor-request-escaped-scan")
        {
            return ("/api/v1/device/pay-for",
                """{"mac":"5ccf7f0a1b2c","method":"qr","token":"Q\"\\X\u00e9\u00ff","court":2,"nonce":"9f2a4c6e8b0d1f3a","confirm":false}""");
        }
        var vector = CourtBoxRequest(id);
        return (vector.GetProperty("path_and_query").GetString()!,
            Encoding.UTF8.GetString(Convert.FromHexString(vector.GetProperty("body_hex").GetString()!)));
    }

    private static JsonElement CourtBoxRequest(string id)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src", "contracts", "device-protocol", "http")))
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir.FullName, "src", "contracts", "device-protocol", "http", "cases.json")));
        return doc.RootElement.GetProperty("requests").EnumerateArray().Single(c => c.GetProperty("id").GetString() == id).Clone();
    }

    /// <summary>
    /// The two halves of D15-1 agreeing, end to end: the four bodies bridge 2.2.5 sends for a scan
    /// carrying a quote, a backslash and two bytes above 0x7F (FW15's corpus vectors, verbatim but
    /// for the MAC) are answered as an unknown code (the walk-up's long-standing 400 <c>not_recognised</c>; 200 refusals elsewhere) — never 5xx, never <c>malformed_body</c> — and the
    /// queued event is receipted, so the drain moves on.
    /// </summary>
    [SkippableTheory]
    [InlineData("activate-request-escaped-scan")]
    [InlineData("walkup-request-escaped-scan")]
    [InlineData("payfor-request-escaped-scan")]
    [InlineData("events-request-escaped-subject")]
    public async Task The_bridge_225_escaped_scan_vectors_are_answered_as_an_unknown_code(string id)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync($"r15v{id[..4]}");
        await using var _ = r.App;
        var (path, raw) = EscapedScan(id);
        var body = raw.Replace("5ccf7f0a1b2c", r.Club.BoxMac, StringComparison.Ordinal);

        var (status, text) = await SendAsync(r, Raw(r, path, Encoding.UTF8.GetBytes(body)));

        Assert.True((int)status < 500, $"{id}: {(int)status} {text}");
        Assert.NotEqual(DeviceErrorCodes.MalformedBody, ErrorOf(text));
        if (id.StartsWith("events", StringComparison.Ordinal))
        {
            Assert.Equal(HttpStatusCode.OK, status);
            using var json = JsonDocument.Parse(text);
            Assert.Equal(7, json.RootElement.GetProperty("accepted_through").GetInt64());
        }
        else if (id.StartsWith("walkup", StringComparison.Ordinal))
        {
            // The walk-up's refusal of a code nobody holds has always been 400 not_recognised.
            Assert.Equal(HttpStatusCode.BadRequest, status);
            Assert.Equal("not_recognised", ErrorOf(text));
        }
        else
        {
            Assert.Equal(HttpStatusCode.OK, status);
        }
    }
}
