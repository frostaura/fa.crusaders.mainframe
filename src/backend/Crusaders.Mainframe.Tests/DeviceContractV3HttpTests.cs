using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Device contract v3 over real HTTP (docs/specs/device-api.md): the snapshot and what the server
/// records from the box's reconcile, release causes, the display and hardware settings, key
/// rotation, the club network, signed firmware and the member-code cut-over fixes. Each test
/// changes the one fixture field its finding is about.
/// </summary>
public sealed class DeviceContractV3HttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Hb = "/api/v1/device/heartbeat";
    private const string OwnerEmail = "owner-v3@device.review.test";

    /// <summary>The test deployment's OTA key pair. Generated per run, so nothing signed here is ever offered to a board.</summary>
    private static readonly RSA Signer = RSA.Create(2048);

    private static string ModulusHex => Convert.ToHexStringLower(Signer.ExportParameters(false).Modulus!);

    private WebApplicationFactory<Program> App() =>
        MemberCodeClub.Wired(pg.SharedHost, new StubEmailService()).WithWebHostBuilder(b =>
        {
            b.UseSetting("DeviceOta:PublicKeyModulus", ModulusHex);
            b.UseSetting("Admins:Emails:0", OwnerEmail);
        });

    private static readonly string[] V3Caps = ["codes:m1", "hb:3", "ota:1", "key:1", "net:1", "lcd:2"];

    /// <summary>A v3 box's heartbeat body; <paramref name="extra"/> adds or replaces fields, <c>caps</c> always last.</summary>
    private static JsonObject Beat(string mac, object? extra = null, string[]? caps = null)
    {
        var body = new JsonObject { ["mac"] = mac, ["firmware_version"] = "3.0.0", ["uptime_ms"] = 86_400_000 };
        if (extra is not null)
        {
            foreach (var (k, v) in JsonSerializer.SerializeToNode(extra)!.AsObject()) body[k] = v?.DeepClone();
        }
        body["caps"] = new JsonArray([.. (caps ?? V3Caps).Select(c => (JsonNode)c!)]);
        return body;
    }

    private static async Task<JsonElement> OkAsync(HttpResponseMessage response)
    {
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{(int)response.StatusCode} {text}");
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    private static async Task<JsonElement> BeatAsync(HttpClient device, MemberCodeClub club, JsonObject body, string? key = null)
    {
        var req = club.Device(Hb, body);
        if (key is not null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        return await OkAsync(await device.SendAsync(req));
    }

    private static string[] Courts(JsonElement body) => [.. body.GetProperty("courts").EnumerateArray().Select(e => e.GetString()!)];

    private static string Ref(Booking b) => b.Id.ToString("N")[..8];

    private static async Task<Booking> BookAtAsync(
        WebApplicationFactory<Program> app, MemberCodeClub club, Guid user, int courtIndex, DateTimeOffset startsAt, int minutes, bool checkedIn)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var booking = new Booking
        {
            TenantId = club.TenantId, CourtId = club.Courts[courtIndex], UserId = user, BookedByUserId = user, PaidByUserId = user,
            ActorUserId = user, StartsAt = startsAt.Storable(), EndsAt = startsAt.AddMinutes(minutes).Storable(), SliceMinutes = 15,
            SliceCount = minutes / 15, AmountChargedMinutes = minutes, Status = BookingStatus.Booked, ChargedAt = DateTimeOffset.UtcNow,
            CheckedInAt = checkedIn ? DateTimeOffset.UtcNow.AddMinutes(-1).Storable() : null,
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking;
    }

    private static async Task<List<DeviceError>> ErrorsAsync(WebApplicationFactory<Program> app, MemberCodeClub club, string code, int atLeast = 1)
    {
        for (var i = 0; i < 50; i++)
        {
            var rows = await club.ReadAsync(app, db => db.DeviceErrors.IgnoreQueryFilters()
                .Where(e => e.TenantId == club.TenantId && e.Code == code).ToListAsync());
            if (rows.Count >= atLeast) return rows;
            await Task.Delay(100);
        }
        return [];
    }

    // ---- §3–§4: the snapshot --------------------------------------------------------------------

    /// <summary>
    /// BD-1 / BR-04 / DL-11 / FSF-08: a paid extension is part of the run, so the snapshot's
    /// seconds run to the END of the chain — v2 stopped at the segment in play and an extended
    /// court went dark at the original end. And a hb:3 box is sent `courts`, never `relays`.
    /// </summary>
    [SkippableFact]
    public async Task The_snapshot_runs_to_the_end_of_a_chained_extension_and_replaces_relays()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3chain");
        var now = DateTimeOffset.UtcNow;
        var olga = await BookAtAsync(app, club, club.Olga, 1, now.AddMinutes(-10), 60, checkedIn: true);
        await BookAtAsync(app, club, club.Pam, 1, olga.EndsAt, 30, checkedIn: true);

        var body = await BeatAsync(app.CreateClient(), club, Beat(club.BoxMac));
        Assert.False(body.TryGetProperty("relays", out _));
        var courts = Courts(body);
        Assert.Equal(["0|0|0|-|-", "2|0|0|-|-", "3|0|0|-|-"], [courts[0], courts[2], courts[3]]);
        var element = courts[1].Split('|');
        Assert.Equal(["1", "1"], element[..2]);
        Assert.InRange(int.Parse(element[2]), (80 * 60) - 30, 80 * 60);
        Assert.Equal("b", element[3]);
        Assert.Equal(Ref(olga), element[4]);

        // The same club's 2.x box (no hb:3) still gets its one-shot `relays`, now chain-aware too.
        var legacy = await BeatAsync(app.CreateClient(), club, Beat(club.BoxMac, new { uptime_ms = 20_000 }, caps: ["codes:m1"]));
        Assert.False(legacy.TryGetProperty("courts", out _));
        var relay = Assert.Single(legacy.GetProperty("relays").EnumerateArray()).GetString()!.Split('|');
        Assert.InRange(int.Parse(relay[1]), (80 * 60) - 30, 80 * 60);
    }

    /// <summary>BR-13: an auto-registered box's court map is a guess until an admin confirms it — no `courts` at all.</summary>
    [SkippableFact]
    public async Task An_unacknowledged_box_gets_no_snapshot()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3unack");
        await BookAtAsync(app, club, club.Olga, 0, DateTimeOffset.UtcNow.AddMinutes(-5), 60, checkedIn: true);
        await club.WriteAsync(app, async db => (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == club.BoxMac)).AutoRegistered = true);

        var body = await BeatAsync(app.CreateClient(), club, Beat(club.BoxMac));
        Assert.False(body.TryGetProperty("courts", out _));
        Assert.False(body.TryGetProperty("relays", out _));
    }

    /// <summary>MCV1-05: a booking lit in its cue window (before StartsAt) is in play — v2's StartsAt &lt;= now left it dark after a power cut.</summary>
    [SkippableFact]
    public async Task A_booking_lit_in_its_cue_window_is_in_the_snapshot()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3cue");
        var early = await BookAtAsync(app, club, club.Olga, 2, DateTimeOffset.UtcNow.AddMinutes(5), 45, checkedIn: true);
        // The same booking NOT checked in is not lit by anybody: dark.
        await BookAtAsync(app, club, club.Pam, 3, DateTimeOffset.UtcNow.AddMinutes(5), 45, checkedIn: false);

        var courts = Courts(await BeatAsync(app.CreateClient(), club, Beat(club.BoxMac)));
        Assert.StartsWith("2|1|", courts[2]);
        Assert.EndsWith("|b|" + Ref(early), courts[2]);
        Assert.Equal("3|0|0|-|-", courts[3]);
    }

    /// <summary>
    /// BD-2 through the real event path: a release whose cause is <c>mega_reset</c> keeps the court
    /// in the snapshot; the member's own (no cause, as every 2.x box sends) takes it out. The cause
    /// is stored on the receipt as given.
    /// </summary>
    [SkippableTheory]
    [InlineData("mega_reset", true)]
    [InlineData(null, false)]
    public async Task A_mega_reset_release_keeps_the_snapshot_lit_and_a_member_release_does_not(string? cause, bool stillLit)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, cause ?? "v3member");
        var device = app.CreateClient();
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: -15, minutes: 60);

        // The box's own activation event, then its release ten minutes later: a session to pair with.
        var release = new JsonObject
        {
            ["seq"] = 2, ["uptime_ms"] = 99_990_000, ["kind"] = "release", ["court"] = 0, ["method"] = null,
            ["subject"] = "", ["duration_ms"] = 600_000,
        };
        if (cause is not null) release["cause"] = cause;
        await OkAsync(await device.SendAsync(club.Device("/api/v1/device/events", new JsonObject
        {
            ["mac"] = club.BoxMac, ["boot_id"] = 9, ["uptime_ms"] = 100_000_000,
            ["events"] = new JsonArray(Activation(club), release),
        })));

        var receipt = await club.ReadAsync(app, db => db.DeviceEventReceipts.IgnoreQueryFilters()
            .SingleAsync(r => r.TenantId == club.TenantId && r.Kind == "release"));
        Assert.Equal(cause, receipt.Cause);
        Assert.Equal(booking.Id, receipt.BookingId);

        var courts = Courts(await BeatAsync(device, club, Beat(club.BoxMac)));
        if (stillLit) Assert.StartsWith("0|1|", courts[0]);
        else Assert.Equal("0|0|0|-|-", courts[0]);
    }

    /// <summary>Olga's offline activation on relay 0, uploaded at uptime 99 390 000 (about ten minutes before the upload).</summary>
    private static JsonObject Activation(MemberCodeClub club) => new()
    {
        ["seq"] = 1, ["uptime_ms"] = 99_390_000, ["kind"] = "activation", ["court"] = 0, ["method"] = "qr",
        ["subject"] = club.Code(club.Olga, DateTimeOffset.UtcNow.AddMilliseconds(-610_000)), ["duration_ms"] = 0,
    };

    /// <summary>MCV1-01: a release longer than any relay can hold (a wrapped age) is receipted and audited, never paired.</summary>
    [SkippableFact]
    public async Task An_implausible_release_never_pairs_and_never_darkens_the_snapshot()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3wrap");
        var device = app.CreateClient();
        await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: -15, minutes: 60);

        await OkAsync(await device.SendAsync(club.Device("/api/v1/device/events", new JsonObject
        {
            ["mac"] = club.BoxMac, ["boot_id"] = 9, ["uptime_ms"] = 100_000_000,
            ["events"] = new JsonArray(Activation(club), new JsonObject
            {
                ["seq"] = 2, ["uptime_ms"] = 99_999_000, ["kind"] = "release", ["court"] = 0, ["method"] = null,
                ["subject"] = "", ["duration_ms"] = 4_294_967_272L,
            }),
        })));

        var receipt = await club.ReadAsync(app, db => db.DeviceEventReceipts.IgnoreQueryFilters()
            .SingleAsync(r => r.TenantId == club.TenantId && r.Kind == "release"));
        Assert.Equal(RelayRestorePlan.ImplausibleOutcome, receipt.Outcome);
        Assert.Null(receipt.BookingId);
        Assert.Equal(1, await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .CountAsync(a => a.TenantId == club.TenantId && a.Action == DeviceEventEndpoints.ReleaseImplausibleAction)));
        Assert.StartsWith("0|1|", Courts(await BeatAsync(device, club, Beat(club.BoxMac)))[0]);
    }

    /// <summary>
    /// BD-5: a v3 box's `relight` is recorded per court WHATEVER the uptime (v2 only inside a
    /// four-beat window, so a late first beat after a long outage was restored and never recorded);
    /// a relight naming a reference the server does not list records nothing.
    /// </summary>
    [SkippableFact]
    public async Task A_relight_reported_late_is_recorded_for_exactly_the_court_named()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3relit");
        var olga = await BookAtAsync(app, club, club.Olga, 1, DateTimeOffset.UtcNow.AddMinutes(-10), 60, checkedIn: true);
        await BookAtAsync(app, club, club.Pam, 2, DateTimeOffset.UtcNow.AddMinutes(-10), 60, checkedIn: true);

        await BeatAsync(app.CreateClient(), club, Beat(club.BoxMac, new
        {
            uptime_ms = 3_600_000,
            relay_state = new[] { "1|3000", "2|3000" },
            relight = new[] { $"1|{Ref(olga)}", "2|deadbeef" },
        }));

        var states = await club.ReadAsync(app, db => db.CourtLightStates.IgnoreQueryFilters()
            .Where(l => l.TenantId == club.TenantId && l.Cause == LightCause.RestoreAfterPowerDip).ToListAsync());
        var restored = Assert.Single(states);
        Assert.Equal(club.Courts[1], restored.CourtId);
        Assert.Equal(olga.Id, restored.BookingId);
    }

    /// <summary>
    /// BD-6: the snapshot says lit and the box says dark on TWO consecutive beats files
    /// <c>restore_not_confirmed</c> for that court, once; one dark beat, or a confirming one between,
    /// files nothing.
    /// </summary>
    [SkippableFact]
    public async Task Two_contradicting_beats_file_restore_not_confirmed_for_that_court()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3dark");
        var device = app.CreateClient();
        await BookAtAsync(app, club, club.Olga, 3, DateTimeOffset.UtcNow.AddMinutes(-10), 60, checkedIn: true);

        await BeatAsync(device, club, Beat(club.BoxMac, new { relay_state = Array.Empty<string>() }));
        await BeatAsync(device, club, Beat(club.BoxMac, new { relay_state = new[] { "3|3000" } }));
        await BeatAsync(device, club, Beat(club.BoxMac, new { relay_state = Array.Empty<string>() }));
        await Task.Delay(500);
        Assert.Empty(await club.ReadAsync(app, db => db.DeviceErrors.IgnoreQueryFilters()
            .Where(e => e.TenantId == club.TenantId && e.Code == DeviceErrorCodes.RestoreNotConfirmed).ToListAsync()));

        await BeatAsync(device, club, Beat(club.BoxMac, new { relay_state = Array.Empty<string>() }));
        var row = Assert.Single(await ErrorsAsync(app, club, DeviceErrorCodes.RestoreNotConfirmed));
        Assert.Equal(4, row.Court);
    }

    // ---- §2, §13: what the board reports -------------------------------------------------------

    [SkippableFact]
    public async Task The_v3_report_and_telemetry_are_stored_and_served_and_raise_their_notices()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3telem");
        var device = app.CreateClient();

        await BeatAsync(device, club, Beat(club.BoxMac, new
        {
            fw_state = "rolled_back", fw_failed = "3.0.1", fw_error = "probation", net_ver = 4, net_src = "server",
            lcd_layout = "expanded", restore = "cold", mega_version = "3.0.0",
            mega = new { reset = "08", lcd = "00", relay = "high", scan_baud = 9600, scan_end = "auto", keys = "0F", diag = new[] { 1, 2, 3, 4, 5 }, future = new { x = 1 } },
            diag = new { reset = "exception", exc = 4294967295L, epc1 = 3, heap = 20000, heap_min = 9000, block = 3000, stack_min = 400, sketch_free = 1044464, flash_mb = 4, extra = "kept out" },
            drift = new[] { "config.lcd_layout", "roster" },
            fw_state_extra = "ignored",
        }));

        var row = await club.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == club.BoxMac));
        Assert.Equal("rolled_back", row.FwState);
        Assert.Equal(["3.0.1"], row.FwFailedVersions);
        Assert.Equal(4, row.NetVer);
        Assert.Equal("expanded", row.LcdLayoutAcknowledged);
        Assert.Equal("cold", row.RestoreReport);
        Assert.Equal(["config.lcd_layout", "roster"], row.Drift);
        Assert.DoesNotContain("future", row.MegaJson!);
        Assert.DoesNotContain("kept out", row.DiagJson!);
        Assert.Contains("4294967295", row.DiagJson!);

        var view = JsonDocument.Parse(await club.Member(app, club.AdminId, "admin").GetStringAsync("/api/v1/admin/devices/")).RootElement
            .EnumerateArray().Single(d => d.GetProperty("id").GetGuid() == row.Id);
        Assert.Equal("00", view.GetProperty("mega").GetProperty("lcd").GetString());
        Assert.Equal(3000, view.GetProperty("diag").GetProperty("block").GetInt64());
        Assert.Equal("roster", view.GetProperty("drift")[1].GetString());

        foreach (var code in new[] { DeviceErrorCodes.AnswerDrift, DeviceErrorCodes.LcdAbsent, DeviceErrorCodes.BoardRestarted, DeviceErrorCodes.HeapLow, DeviceErrorCodes.StackLow })
        {
            Assert.NotEmpty(await ErrorsAsync(app, club, code));
        }

        // An unknown fw_state is stored as `unknown`, never a 400 — a diagnostic must not cost a beat.
        await BeatAsync(device, club, Beat(club.BoxMac, new { fw_state = "levitating" }));
        Assert.Equal("unknown", await club.ReadAsync(app, db => db.Devices.IgnoreQueryFilters()
            .Where(d => d.MacAddress == club.BoxMac).Select(d => d.FwState).SingleAsync()));
    }

    // ---- §5, §10, §12: settings and per-board overrides ----------------------------------------

    [SkippableFact]
    public async Task Settings_bounds_are_served_and_enforced_and_a_boards_hw_override_resolves_into_its_config()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3hw");
        var admin = club.Member(app, club.AdminId, "admin");
        var device = app.CreateClient();

        var settings = JsonDocument.Parse(await admin.GetStringAsync("/api/v1/admin/settings")).RootElement;
        var bounds = settings.GetProperty("bounds");
        Assert.Equal(250, bounds.GetProperty("lcd_marquee_step_ms").GetProperty("min").GetInt32());
        Assert.Equal(["high", "low"], bounds.GetProperty("hw_relay_active_level").GetProperty("values").EnumerateArray().Select(e => e.GetString()));
        Assert.Contains(63, bounds.GetProperty("hw_lcd_i2c_address").GetProperty("values").EnumerateArray().Select(e => e.GetInt32()));
        Assert.Equal(120, bounds.GetProperty("device_fault_max_per_hour").GetProperty("max").GetInt32());
        Assert.Equal("high", settings.GetProperty("hw_relay_active_level").GetString());

        var tooFast = await admin.PutAsJsonAsync("/api/v1/admin/settings", new { lcd_marquee_step_ms = 100 });
        Assert.Equal(HttpStatusCode.BadRequest, tooFast.StatusCode);
        var refusal = JsonDocument.Parse(await tooFast.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("lcd_marquee_step_ms_out_of_range", refusal.GetProperty("error").GetString());
        Assert.Equal(1000, refusal.GetProperty("max").GetInt32());
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PutAsJsonAsync("/api/v1/admin/settings", new { hw_relay_active_level = "both" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync("/api/v1/admin/settings", new { lcdLayout = "expanded", hw_scanner_gap_ms = 200 })).StatusCode);

        var boxId = await club.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().Where(d => d.MacAddress == club.BoxMac).Select(d => d.Id).SingleAsync());
        var patch = await admin.PatchAsync($"/api/v1/admin/devices/{boxId}", JsonContent.Create(new { hw_relay_active_level = "low", hw_lcd_i2c_address = 63, lcd_layout = "compact" }));
        Assert.Equal(HttpStatusCode.OK, patch.StatusCode);

        var config = (await BeatAsync(device, club, Beat(club.BoxMac))).GetProperty("config");
        Assert.Equal("low", config.GetProperty("hw_relay_active_level").GetString());
        Assert.Equal(63, config.GetProperty("hw_lcd_i2c_address").GetInt32());
        Assert.Equal("compact", config.GetProperty("lcd_layout").GetString());
        Assert.Equal(200, config.GetProperty("hw_scanner_gap_ms").GetInt32());

        // JSON null returns the board to the club's value; absent leaves it alone.
        Assert.Equal(HttpStatusCode.OK, (await admin.PatchAsync($"/api/v1/admin/devices/{boxId}",
            new StringContent("""{"lcd_layout":null}""", Encoding.UTF8, "application/json"))).StatusCode);
        config = (await BeatAsync(device, club, Beat(club.BoxMac))).GetProperty("config");
        Assert.Equal("expanded", config.GetProperty("lcd_layout").GetString());
        Assert.Equal("low", config.GetProperty("hw_relay_active_level").GetString());

        // A bad override value is refused with the closed set, and a door is refused the box's fields.
        var bad = await admin.PatchAsync($"/api/v1/admin/devices/{boxId}", JsonContent.Create(new { hw_scanner_baud = 4800 }));
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var doorId = await club.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().Where(d => d.MacAddress == club.DoorMac).Select(d => d.Id).SingleAsync());
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PatchAsync($"/api/v1/admin/devices/{doorId}", JsonContent.Create(new { lcd_layout = "compact" }))).StatusCode);

        // A 2.x box is answered byte for byte as before: none of it.
        var legacy = (await BeatAsync(device, club, Beat(club.BoxMac, caps: ["codes:m1"]))).GetProperty("config");
        Assert.False(legacy.TryGetProperty("lcd_layout", out _));
        Assert.False(legacy.TryGetProperty("hw_relay_active_level", out _));
    }

    /// <summary>Cross-tenant: one club's admin cannot set another club's board's overrides, nor read them.</summary>
    [SkippableFact]
    public async Task Another_clubs_admin_cannot_patch_a_boards_overrides()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var alpha = await MemberCodeClub.SeedAsync(app, "v3xa");
        var bravo = await MemberCodeClub.SeedAsync(app, "v3xb");
        var alphaBox = await alpha.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().Where(d => d.MacAddress == alpha.BoxMac).Select(d => d.Id).SingleAsync());

        var response = await bravo.Member(app, bravo.AdminId, "admin").PatchAsync(
            $"/api/v1/admin/devices/{alphaBox}", JsonContent.Create(new { hw_relay_active_level = "low", push_network = true }));
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var row = await alpha.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().SingleAsync(d => d.Id == alphaBox));
        Assert.Null(row.HwRelayActiveLevel);
        Assert.False(row.NetPushRequested);
    }

    /// <summary>FC-8 + BD-12: saving the walk-up cap lowers every minutes:N button above it, and the extend is bounded by it too.</summary>
    [SkippableFact]
    public async Task The_walk_up_cap_caps_the_buttons_and_the_extend()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3cap");
        var admin = club.Member(app, club.AdminId, "admin");
        var device = app.CreateClient();
        await club.WriteAsync(app, async db => (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == club.BoxMac)).ButtonMapJson =
            """["court:A","court:B","court:C","court:D","minutes:15","minutes:30","minutes:60","minutes:90"]""");

        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync("/api/v1/admin/settings", new { walkUpMaxMinutes = 20 })).StatusCode);

        var own = await club.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().Where(d => d.MacAddress == club.BoxMac).Select(d => d.ButtonMapJson).SingleAsync());
        Assert.Equal("""["court:A","court:B","court:C","court:D","minutes:15","minutes:20","minutes:20","minutes:20"]""", own);
        var clubMap = JsonDocument.Parse(await admin.GetStringAsync("/api/v1/admin/settings")).RootElement.GetProperty("button_map");
        Assert.DoesNotContain(clubMap.EnumerateArray().Select(e => e.GetString()), b => b is "minutes:30" or "minutes:45" or "minutes:60");
        var sent = (await BeatAsync(device, club, Beat(club.BoxMac))).GetProperty("config").GetProperty("button_map");
        Assert.Equal("minutes:20", sent[7].GetString());

        var extend = await device.SendAsync(club.Device("/api/v1/device/extend", new JsonObject
        {
            ["mac"] = club.BoxMac, ["method"] = "qr", ["token"] = club.Code(club.Olga), ["court"] = 1, ["minutes"] = 30, ["nonce"] = "cap-30",
        }));
        Assert.Equal(HttpStatusCode.BadRequest, extend.StatusCode);
        var why = JsonDocument.Parse(await extend.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("minutes_out_of_range", why.GetProperty("error").GetString());
        Assert.Equal(20, why.GetProperty("max_minutes").GetInt32());
    }

    // ---- §6 keys ---------------------------------------------------------------------------------

    /// <summary>
    /// The whole rotation (BA-01, BD-3, IO-02): rotate, both keys authenticate, a key:1 board is sent
    /// key_next until it uses the new key, retiring is refused while a board without key:1 would be
    /// stranded, the typed phrase retires, and then the old key is a 401.
    /// </summary>
    [SkippableFact]
    public async Task A_rotation_delivers_key_next_retires_only_when_typed_and_then_the_old_key_is_refused()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3keys");
        var admin = club.Member(app, club.AdminId, "admin");
        var device = app.CreateClient();
        var oldKey = club.DeviceKey;

        // The door is a 1.x gate: codes:m1 only, so it cannot rotate.
        Assert.Equal(HttpStatusCode.OK, (await device.SendAsync(club.Heartbeat(club.DoorMac, m1: true, kind: "gate"))).StatusCode);
        var rotated = await OkAsync(await admin.PostAsync("/api/v1/admin/devices/api-key/rotate", null));
        var newKey = rotated.GetProperty("api_key").GetString()!;
        Assert.Equal("k2", rotated.GetProperty("key_id").GetString());

        var onOld = await BeatAsync(device, club, Beat(club.BoxMac));
        Assert.Equal("k2", onOld.GetProperty("key_next").GetProperty("id").GetString());
        Assert.Equal(newKey, onOld.GetProperty("key_next").GetProperty("key").GetString());
        Assert.Equal("ok", DeviceProvision.AdoptKey(onOld.GetProperty("key_next"), "k1", ["k1"]));

        var onNew = await BeatAsync(device, club, Beat(club.BoxMac), key: newKey);
        Assert.False(onNew.TryGetProperty("key_next", out _));
        Assert.Equal(2, await club.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().Where(d => d.MacAddress == club.BoxMac).Select(d => d.LastKeyId).SingleAsync()));

        var status = await OkAsync(await admin.GetAsync("/api/v1/admin/devices/api-key"));
        Assert.Single(status.GetProperty("rotation").GetProperty("boards_on_new").EnumerateArray());
        Assert.Single(status.GetProperty("rotation").GetProperty("boards_cannot_rotate").EnumerateArray());

        var refused = await admin.PostAsJsonAsync("/api/v1/admin/devices/api-key/retire", new { });
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        var stranded = JsonDocument.Parse(await refused.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("boards_would_be_stranded", stranded.GetProperty("error").GetString());
        Assert.Contains(stranded.GetProperty("boards").EnumerateArray(), b => b.GetProperty("kind").GetString() == "Gate");

        // Still both keys work while it is refused.
        await BeatAsync(device, club, Beat(club.BoxMac), key: oldKey);

        await OkAsync(await admin.PostAsJsonAsync("/api/v1/admin/devices/api-key/retire", new { confirm = DeviceKeyRing.RetirePhrase }));
        var req = club.Device(Hb, Beat(club.BoxMac));
        Assert.Equal(HttpStatusCode.Unauthorized, (await device.SendAsync(req)).StatusCode);
        await BeatAsync(device, club, Beat(club.BoxMac), key: newKey);
    }

    /// <summary>§6 step 5 (BD-3, IO-01): an owner puts back the key the boards hold after a database loss; nobody else can, and a malformed key is refused.</summary>
    [SkippableFact]
    public async Task Only_an_owner_can_restore_a_known_key_and_it_then_authenticates()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3restore");
        var admin = club.Member(app, club.AdminId, "admin");
        var device = app.CreateClient();
        var known = Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceApiKey.Generate();

        var notOwner = await admin.PostAsJsonAsync("/api/v1/admin/devices/api-key/restore", new { key = known, confirm = DeviceKeyRing.RestorePhrase });
        Assert.Equal(HttpStatusCode.Forbidden, notOwner.StatusCode);
        Assert.Equal(AdminDeviceV3Endpoints.OwnerOnly, JsonDocument.Parse(await notOwner.Content.ReadAsStringAsync()).RootElement.GetProperty("error").GetString());

        await club.WriteAsync(app, async db => (await db.Users.IgnoreQueryFilters().SingleAsync(u => u.Id == club.AdminId)).Email = OwnerEmail);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/v1/admin/devices/api-key/restore", new { key = "short", confirm = DeviceKeyRing.RestorePhrase })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/v1/admin/devices/api-key/restore", new { key = known })).StatusCode);

        var restored = await OkAsync(await admin.PostAsJsonAsync("/api/v1/admin/devices/api-key/restore", new { key = known, confirm = DeviceKeyRing.RestorePhrase }));
        Assert.Equal(known, restored.GetProperty("api_key").GetString());
        await BeatAsync(device, club, Beat(club.BoxMac), key: known);
        // The key that was current stays valid as a previous one until an admin retires it.
        await BeatAsync(device, club, Beat(club.BoxMac), key: club.DeviceKey);
        var details = await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId).Select(a => a.DetailsJson).ToListAsync());
        Assert.DoesNotContain(details, d => d != null && d.Contains(known, StringComparison.Ordinal));
    }

    /// <summary>Cross-tenant: one club's previous key never authenticates as another club, and a retired key of one club is no key at all.</summary>
    [SkippableFact]
    public async Task A_clubs_previous_key_authenticates_only_its_own_club()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var alpha = await MemberCodeClub.SeedAsync(app, "v3pka");
        var bravo = await MemberCodeClub.SeedAsync(app, "v3pkb");
        await OkAsync(await alpha.Member(app, alpha.AdminId, "admin").PostAsync("/api/v1/admin/devices/api-key/rotate", null));

        // Alpha's OLD key, presented with bravo's box MAC: it resolves to alpha, where that MAC is unknown — a new alpha row, never bravo's.
        var device = app.CreateClient();
        var req = bravo.Device(Hb, Beat(bravo.BoxMac));
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", alpha.DeviceKey);
        var body = await OkAsync(await device.SendAsync(req));
        Assert.Equal(alpha.Slug, body.GetProperty("tenant_slug").GetString());
        Assert.Equal(1, await alpha.ReadAsync(app, db => db.DevicePreviousKeys.IgnoreQueryFilters().CountAsync(k => k.TenantId == alpha.TenantId)));
        Assert.Equal(0, await bravo.ReadAsync(app, db => db.DevicePreviousKeys.IgnoreQueryFilters().CountAsync(k => k.TenantId == bravo.TenantId)));
    }

    // ---- §8 network ------------------------------------------------------------------------------

    [SkippableFact]
    public async Task The_club_network_is_validated_write_only_delivered_and_pushed_to_a_local_board_on_request()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3net");
        var admin = club.Member(app, club.AdminId, "admin");
        var device = app.CreateClient();

        var https = await admin.PutAsJsonAsync("/api/v1/admin/devices/network", new { @base = "https://crusaders.frostaura.net", wifi = new[] { new { ssid = "CRUSADERS", psk = "squash-court-4" } } });
        Assert.Equal(HttpStatusCode.BadRequest, https.StatusCode);
        Assert.Equal("base_https", JsonDocument.Parse(await https.Content.ReadAsStringAsync()).RootElement.GetProperty("error").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PutAsJsonAsync("/api/v1/admin/devices/network",
            new { wifi = new[] { new { ssid = "CRUSADERS", psk = "short" } } })).StatusCode);

        var saved = await OkAsync(await admin.PutAsJsonAsync("/api/v1/admin/devices/network",
            new { @base = "http://192.168.1.20:8088", wifi = new[] { new { ssid = "CRUSADERS", psk = "squash-court-4" }, new { ssid = "CRUSADERS-NEW", psk = "new-router-pass" } } }));
        Assert.Equal(1, saved.GetProperty("ver").GetInt32());
        Assert.True(saved.GetProperty("wifi")[0].GetProperty("psk_set").GetBoolean());
        var view = await admin.GetStringAsync("/api/v1/admin/devices/network");
        Assert.DoesNotContain("squash-court-4", view);
        var stored = await club.ReadAsync(app, db => db.DeviceNetworks.IgnoreQueryFilters().SingleAsync(n => n.TenantId == club.TenantId));
        Assert.DoesNotContain("squash-court-4", stored.Wifi0PskCipher!);

        // A psk of null keeps the saved password.
        Assert.Equal(2, (await OkAsync(await admin.PutAsJsonAsync("/api/v1/admin/devices/network",
            new { @base = "http://192.168.1.20:8088", wifi = new[] { new { ssid = "CRUSADERS", psk = (string?)null } } }))).GetProperty("ver").GetInt32());

        var net = (await BeatAsync(device, club, Beat(club.BoxMac, new { net_ver = 0, net_src = "compiled" }))).GetProperty("net");
        Assert.Equal("""{"ver":2,"base":"http://192.168.1.20:8088","wifi0_ssid":"CRUSADERS","wifi0_psk":"squash-court-4"}""", net.GetRawText());
        Assert.False((await BeatAsync(device, club, Beat(club.BoxMac, new { net_ver = 2, net_src = "server" }))).TryGetProperty("net", out _));

        // A board configured at its setup portal is never overwritten — until an admin pushes.
        Assert.False((await BeatAsync(device, club, Beat(club.BoxMac, new { net_ver = 0, net_src = "local" }))).TryGetProperty("net", out _));
        var boxId = await club.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().Where(d => d.MacAddress == club.BoxMac).Select(d => d.Id).SingleAsync());
        await OkAsync(await admin.PatchAsync($"/api/v1/admin/devices/{boxId}", JsonContent.Create(new { push_network = true })));
        Assert.True((await BeatAsync(device, club, Beat(club.BoxMac, new { net_ver = 0, net_src = "local" }))).TryGetProperty("net", out _));
        await BeatAsync(device, club, Beat(club.BoxMac, new { net_ver = 2, net_src = "server" }));
        Assert.False(await club.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().Where(d => d.Id == boxId).Select(d => d.NetPushRequested).SingleAsync()));

        // A board without net:1 is never sent one.
        Assert.False((await BeatAsync(device, club, Beat(club.BoxMac, new { net_ver = 0 }, caps: ["codes:m1", "hb:3"]))).TryGetProperty("net", out _));
    }

    // ---- §7 firmware -----------------------------------------------------------------------------

    private static (byte[] Image, string Manifest) Signed(string target, string version, int size = 4096, Action<JsonObject>? tamper = null)
    {
        var image = RandomNumberGenerator.GetBytes(size);
        var sha = Convert.ToHexStringLower(SHA256.HashData(image));
        var sig = Signer.SignData(Encoding.ASCII.GetBytes(DeviceOta.ManifestText(target, version, size, sha)), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var manifest = new JsonObject
        {
            ["target"] = target, ["version"] = version, ["size"] = size, ["sha256"] = sha,
            ["sig"] = Convert.ToBase64String(sig).TrimEnd('=').Replace('+', '-').Replace('/', '_'),
        };
        tamper?.Invoke(manifest);
        return (image, manifest.ToJsonString());
    }

    private static MultipartFormDataContent Upload((byte[] Image, string Manifest) release) => new()
    {
        { new ByteArrayContent(release.Image), "image", "image.bin" },
        { new StringContent(release.Manifest), "manifest" },
    };

    private static async Task<string?> UploadErrorAsync(HttpClient admin, (byte[] Image, string Manifest) release)
    {
        var response = await admin.PostAsync("/api/v1/admin/devices/firmware", Upload(release));
        if (response.StatusCode == HttpStatusCode.OK) return null;
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("error").GetString();
    }

    [SkippableFact]
    public async Task An_upload_is_refused_unless_a_board_would_boot_it()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3fwbad");
        var admin = club.Member(app, club.AdminId, "admin");

        Assert.Equal(FirmwareService.SigInvalid, await UploadErrorAsync(admin, Signed("court_bridge", "3.0.1", tamper: m => m["version"] = "3.0.2")));
        Assert.Equal(FirmwareService.SigInvalid, await UploadErrorAsync(admin, Signed("court_bridge", "3.0.1", tamper: m => m["target"] = "door_gate")));
        Assert.Equal(FirmwareService.Sha256Mismatch, await UploadErrorAsync(admin, Signed("court_bridge", "3.0.1", tamper: m => m["sha256"] = new string('0', 64))));
        Assert.Equal(FirmwareService.SizeMismatch, await UploadErrorAsync(admin, Signed("court_bridge", "3.0.1", tamper: m => m["size"] = 4097)));
        Assert.Equal(FirmwareService.TargetUnknown, await UploadErrorAsync(admin, Signed("court_mega", "3.0.1")));
        Assert.Null(await UploadErrorAsync(admin, Signed("court_bridge", "3.0.1")));
        Assert.Equal(FirmwareService.VersionNotNewer, await UploadErrorAsync(admin, Signed("court_bridge", "3.0.1")));
        Assert.Equal(FirmwareService.VersionNotNewer, await UploadErrorAsync(admin, Signed("court_bridge", "3.0.0")));
    }

    /// <summary>
    /// A rollout to ONE board offers only that board — an ota:1, acknowledged board of the target,
    /// running an older version, that has not failed it — and the download is the bytes, with
    /// Content-Length, to this club only (cross-tenant 404).
    /// </summary>
    [SkippableFact]
    public async Task A_rollout_offers_only_the_chosen_board_and_the_download_is_tenant_scoped()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3fw");
        var other = await MemberCodeClub.SeedAsync(app, "v3fwx");
        var admin = club.Member(app, club.AdminId, "admin");
        var device = app.CreateClient();

        var release = Signed("court_bridge", "3.0.1");
        var uploaded = await OkAsync(await admin.PostAsync("/api/v1/admin/devices/firmware", Upload(release)));
        var id = uploaded.GetProperty("id").GetGuid();
        Assert.False((await BeatAsync(device, club, Beat(club.BoxMac))).TryGetProperty("ota", out _));

        var second = Guid.NewGuid().ToString("N")[..12];
        await club.WriteAsync(app, db =>
        {
            db.Devices.Add(new Device { TenantId = club.TenantId, DeviceCode = $"box-{second[^6..]}", Name = "Annex", MacAddress = second, CourtNumbers = [1] });
            return Task.CompletedTask;
        });
        var boxId = await club.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().Where(d => d.MacAddress == club.BoxMac).Select(d => d.Id).SingleAsync());
        await OkAsync(await admin.PatchAsync($"/api/v1/admin/devices/firmware/{id}", JsonContent.Create(new { rollout = "one", device_id = boxId })));

        var offered = (await BeatAsync(device, club, Beat(club.BoxMac))).GetProperty("ota");
        Assert.Equal("ok", DeviceOta.ParseOffer(offered, "court_bridge"));
        Assert.Equal("3.0.1", offered.GetProperty("version").GetString());
        Assert.False((await BeatAsync(device, club, Beat(second))).TryGetProperty("ota", out _));
        // Already running it, or reported it as failed: no offer.
        Assert.False((await BeatAsync(device, club, Beat(club.BoxMac, new { firmware_version = "3.0.1" }))).TryGetProperty("ota", out _));
        await BeatAsync(device, club, Beat(club.BoxMac, new { firmware_version = "3.0.0", fw_state = "rolled_back", fw_failed = "3.0.1", fw_error = "probation" }));
        Assert.False((await BeatAsync(device, club, Beat(club.BoxMac))).TryGetProperty("ota", out _));

        var path = offered.GetProperty("path").GetString()!;
        var get = new HttpRequestMessage(HttpMethod.Get, path);
        get.Headers.Authorization = new AuthenticationHeaderValue("Bearer", club.DeviceKey);
        var download = await device.SendAsync(get);
        Assert.Equal(HttpStatusCode.OK, download.StatusCode);
        Assert.Equal("application/octet-stream", download.Content.Headers.ContentType?.MediaType);
        Assert.Equal(release.Image.Length, download.Content.Headers.ContentLength);
        Assert.Equal(release.Image, await download.Content.ReadAsByteArrayAsync());

        var foreign = new HttpRequestMessage(HttpMethod.Get, path);
        foreign.Headers.Authorization = new AuthenticationHeaderValue("Bearer", other.DeviceKey);
        Assert.Equal(HttpStatusCode.NotFound, (await device.SendAsync(foreign)).StatusCode);
        Assert.Empty(JsonDocument.Parse(await other.Member(app, other.AdminId, "admin").GetStringAsync("/api/v1/admin/devices/firmware")).RootElement.EnumerateArray());
    }

    // ---- Member codes (member-code.md §5, §8, §13) ------------------------------------------------

    /// <summary>MCV1-04: an acknowledged codes:m1 board is sent the booked member's key in phase legacy — before the cut-over.</summary>
    [SkippableFact]
    public async Task Keys_reach_an_acknowledged_board_in_the_legacy_phase()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3legacy", MemberCodeClub.SettingsAtNoon());
        await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -5);

        var body = await BeatAsync(app.CreateClient(), club, Beat(club.BoxMac));
        var refText = MemberCodeMath.RefText(club.Refs[club.Olga]);
        Assert.StartsWith(refText + "0", Assert.Single(body.GetProperty("code_keys").EnumerateArray()).GetString());
        Assert.StartsWith($"m{refText}|1|", Assert.Single(body.GetProperty("roster").EnumerateArray()).GetString());
        var row = await club.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == club.BoxMac));
        Assert.Equal(1, row.CodeKeysSent);
        Assert.Equal(0, row.CodeKeysTrimmed);
    }

    /// <summary>MCV1-02: activate, then extend with the SAME v1 code at the member's own lit court — 200, not code_used.</summary>
    [SkippableFact]
    public async Task Activating_then_extending_with_one_v1_code_extends()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3ext");
        var device = app.CreateClient();
        // Olga's court was lit by her scan a few minutes ago (an earlier step's code): checked in,
        // and the court believed on for her booking.
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: -5, minutes: 30, checkedIn: true);
        await club.WriteAsync(app, db =>
        {
            db.CourtLightStates.Add(new CourtLightState
            {
                TenantId = club.TenantId, CourtId = club.Courts[0], State = LightState.On, BookingId = booking.Id,
                OnSince = DateTimeOffset.UtcNow.AddMinutes(-4), OnUntil = booking.EndsAt, Cause = LightCause.Member,
                LastEventAt = DateTimeOffset.UtcNow.AddMinutes(-4), UpdatedAt = DateTimeOffset.UtcNow,
            });
            return Task.CompletedTask;
        });
        var code = club.Code(club.Olga);

        // The rescan: a repeat activation of the session already lit here — answered as before, a
        // re-grant with the uncapped remainder beside it, and claiming NO court use.
        var lit = await OkAsync(await device.SendAsync(club.Activate(code)));
        Assert.True(lit.GetProperty("activated").GetBoolean());
        Assert.InRange(lit.GetProperty("play_remaining_seconds").GetInt32(), 24 * 60, 25 * 60);
        Assert.Equal(0, await club.UsesAsync(app, MemberCodeUseClass.Court));

        var extended = await device.SendAsync(club.Device("/api/v1/device/extend", new JsonObject
        {
            ["mac"] = club.BoxMac, ["method"] = "qr", ["token"] = code, ["court"] = 1, ["minutes"] = 15, ["nonce"] = "own-court-15",
        }));
        Assert.Equal(HttpStatusCode.OK, extended.StatusCode);
        // At most what was asked (the extension may be truncated by what follows on the court).
        Assert.InRange(JsonDocument.Parse(await extended.Content.ReadAsStringAsync()).RootElement.GetProperty("extended_minutes").GetInt32(), 1, 15);
    }

    /// <summary>MCV1-04: the courtside kiosk accepts the v1 code the phone shows, and spends its court use.</summary>
    [SkippableFact]
    public async Task The_kiosk_accepts_a_v1_code()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3kiosk");
        var admin = club.Member(app, club.AdminId, "admin");
        await club.BookAsync(app, club.Olga, courtIndex: 2, startsInMinutes: -5);
        var code = club.Code(club.Olga);

        var matched = JsonDocument.Parse(await (await admin.PostAsJsonAsync("/api/v1/court/3/qr/match", new { token = code })).Content.ReadAsStringAsync()).RootElement;
        Assert.True(matched.GetProperty("matched").GetBoolean(), matched.GetRawText());
        Assert.Equal(1, await club.UsesAsync(app, MemberCodeUseClass.Court));

        var again = JsonDocument.Parse(await (await admin.PostAsJsonAsync("/api/v1/court/3/qr/match", new { token = code })).Content.ReadAsStringAsync()).RootElement;
        Assert.False(again.GetProperty("matched").GetBoolean());
    }

    /// <summary>MCV1-10: a door's own replay refusal made online is recorded as a replay, not as refused offline.</summary>
    [SkippableTheory]
    [InlineData("replayed", "replayed")]
    [InlineData(null, "refused_offline")]
    public async Task A_doors_online_replay_refusal_is_recorded_as_a_replay(string? cause, string outcome)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, cause ?? "v3offline");
        var scan = new JsonObject
        {
            ["seq"] = 1, ["uptime_ms"] = 99_999_000, ["kind"] = "unknown_scan", ["court"] = 0, ["method"] = "qr",
            ["subject"] = club.Code(club.Olga), ["duration_ms"] = 0,
        };
        if (cause is not null) scan["cause"] = cause;
        await OkAsync(await app.CreateClient().SendAsync(club.Device("/api/v1/device/events", new JsonObject
        {
            ["mac"] = club.DoorMac, ["boot_id"] = 3, ["uptime_ms"] = 100_000_000, ["events"] = new JsonArray(scan),
        })));

        var row = await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .SingleAsync(a => a.TenantId == club.TenantId && a.Action == "device.unknown_scan"));
        Assert.Equal(outcome, JsonDocument.Parse(row.DetailsJson!).RootElement.GetProperty("outcome").GetString());
        Assert.Equal(club.Olga, row.SubjectUserId);
    }

    // ---- BD-10, BD-13 ----------------------------------------------------------------------------

    [SkippableFact]
    public async Task A_mangled_mac_is_invalid_and_a_missing_one_is_required()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var app = App();
        var club = await MemberCodeClub.SeedAsync(app, "v3mac");
        var device = app.CreateClient();

        async Task<string?> ErrorAsync(JsonObject body)
        {
            var response = await device.SendAsync(club.Device(Hb, body));
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("error").GetString();
        }

        Assert.Equal(DeviceIdentity.MacInvalid, await ErrorAsync(new JsonObject { ["mac"] = "zz" }));
        Assert.Equal(DeviceIdentity.MacRequired, await ErrorAsync(new JsonObject { ["firmware_version"] = "3.0.0" }));
    }

    /// <summary>BD-10: a device request no longer makes the JWT handler log a malformed-token failure on every beat.</summary>
    [SkippableFact]
    public async Task A_device_key_request_logs_no_jwt_failure()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var log = new LogSink();
        await using var app = App().WithWebHostBuilder(b => b.ConfigureLogging(l => l.AddProvider(log)));
        var club = await MemberCodeClub.SeedAsync(app, "v3jwt");
        await BeatAsync(app.CreateClient(), club, Beat(club.BoxMac));

        Assert.DoesNotContain(log.Lines, l => l.Contains("IDX14100", StringComparison.Ordinal) || l.Contains("Bearer was not authenticated", StringComparison.Ordinal));
        Assert.True(Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceAuthenticationHandler.IsDeviceKeyRequest(
            new Microsoft.AspNetCore.Http.DefaultHttpContext { Request = { Path = "/api/v1/device/heartbeat", Headers = { Authorization = "Bearer abc" } } }.Request));
        Assert.False(Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceAuthenticationHandler.IsDeviceKeyRequest(
            new Microsoft.AspNetCore.Http.DefaultHttpContext { Request = { Path = "/api/v1/device/heartbeat", Headers = { Authorization = "Bearer a.b.c" } } }.Request));
        Assert.False(Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceAuthenticationHandler.IsDeviceKeyRequest(
            new Microsoft.AspNetCore.Http.DefaultHttpContext { Request = { Path = "/api/v1/me", Headers = { Authorization = "Bearer abc" } } }.Request));
    }

    /// <summary>Every log line written while the host runs, for the BD-10 assertion.</summary>
    private sealed class LogSink : Microsoft.Extensions.Logging.ILoggerProvider
    {
        public System.Collections.Concurrent.ConcurrentQueue<string> Lines { get; } = new();
        public Microsoft.Extensions.Logging.ILogger CreateLogger(string categoryName) => new Writer(this, categoryName);
        public void Dispose() { }

        private sealed class Writer(LogSink sink, string category) : Microsoft.Extensions.Logging.ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
            public bool IsEnabled(Microsoft.Extensions.Logging.LogLevel logLevel) => true;
            public void Log<TState>(Microsoft.Extensions.Logging.LogLevel logLevel, Microsoft.Extensions.Logging.EventId eventId, TState state,
                Exception? exception, Func<TState, Exception?, string> formatter) =>
                sink.Lines.Enqueue($"{category}: {formatter(state, exception)} {exception?.Message}");
        }
    }
}
