using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Capabilities, the heartbeat's member-code sync, the automatic cut-over and cut-off, the admin
/// rollout surface, and the forgery re-check of uploaded evidence (<c>docs/specs/member-code.md</c>
/// §5, §7, §8) — over HTTP against Postgres.
/// </summary>
public sealed class MemberCodeRolloutHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private static async Task<JsonElement> BeatAsync(HttpClient device, MemberCodeClub club, string mac, bool m1, string? kind = null)
    {
        var response = await device.SendAsync(club.Heartbeat(mac, m1, kind));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
    }

    private static Task<string> PhaseAsync(MemberCodeClub club, Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> app) =>
        club.ReadAsync(app, async db =>
        {
            var json = (await db.TenantSettings.IgnoreQueryFilters().FirstAsync(s => s.TenantId == club.TenantId)).SettingsJson;
            return JsonDocument.Parse(json).RootElement.TryGetProperty(MemberCodeSettings.PhaseKey, out var p) ? p.GetString()! : "legacy";
        });

    [SkippableFact]
    public async Task A_board_without_caps_gets_its_old_body_and_an_m1_board_in_legacy_gets_the_clock_and_empty_arrays()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "capsold");
        var device = app.CreateClient();

        var old = await BeatAsync(device, club, club.BoxMac, m1: false);
        Assert.False(old.TryGetProperty("code_step", out _));
        Assert.False(old.TryGetProperty("code_keys", out _));

        var m1 = await BeatAsync(device, club, club.BoxMac, m1: true);
        var step = m1.GetProperty("code_step").GetInt64();
        Assert.InRange(step, MemberCodeMath.StepOf(DateTimeOffset.UtcNow) - 1, MemberCodeMath.StepOf(DateTimeOffset.UtcNow));
        Assert.InRange(m1.GetProperty("code_step_ms").GetInt32(), 0, 29_999);
        Assert.Empty(m1.GetProperty("code_days").EnumerateArray());
        Assert.Empty(m1.GetProperty("code_keys").EnumerateArray());
        Assert.Equal(
            ["roster", "code_step", "code_step_ms", "code_days", "code_keys"],
            m1.EnumerateObject().Select(p => p.Name).SkipWhile(n => n != "roster"));

        var row = await club.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().FirstAsync(d => d.MacAddress == club.BoxMac));
        Assert.Equal(["codes:m1"], row.Capabilities);
        Assert.Equal("legacy", await PhaseAsync(club, app));   // the door has not spoken yet
    }

    [SkippableFact]
    public async Task The_club_cuts_over_when_every_enabled_board_speaks_m1_and_then_rosters_carry_players_and_keys()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        // A club whose local noon is now. Everything below is about the cut-over, not the club's
        // midnight — but a booking live at 23:05 Johannesburg runs into tomorrow, and a roster
        // entry that reaches tomorrow rightly carries tomorrow's key as well, so this test used
        // to be red for the last hour of every club day. Midnight is twelve hours away here at
        // any hour it runs; the tomorrow-key rule has its own tests.
        var club = await MemberCodeClub.SeedAsync(app, "cutover", MemberCodeClub.SettingsAtNoon());
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -5);
        var device = app.CreateClient();

        await BeatAsync(device, club, club.BoxMac, m1: true);
        Assert.Equal("legacy", await PhaseAsync(club, app));

        var door = await BeatAsync(device, club, club.DoorMac, m1: true, kind: "gate");
        Assert.Equal("v1", await PhaseAsync(club, app));

        // The answer that cut over is already a v1 answer.
        var refText = MemberCodeMath.RefText(club.Refs[club.Olga]);
        var element = Assert.Single(door.GetProperty("roster").EnumerateArray()).GetString()!;
        Assert.StartsWith($"m{refText}|0|", element);
        var key = Assert.Single(door.GetProperty("code_keys").EnumerateArray()).GetString()!;
        Assert.StartsWith(refText + "0", key);

        // …and the key is the member's real K_day for today: a code from their phone verifies against it.
        var parsed = MemberCodeWire.ParseKeyElement(key)!.Value;
        var zone = MemberCodeMath.ZoneOf(club.Zone);
        var secret = MemberCodeMath.MemberSecret(MemberCodeClub.MasterKey, club.TenantId, club.Olga, 1);
        var step = MemberCodeMath.StepOf(DateTimeOffset.UtcNow);
        Assert.Equal(MemberCodeMath.Kday(secret, MemberCodeMath.ClubDay(step, zone)), parsed.Key);
        var day = MemberCodeWire.ParseDayElement(door.GetProperty("code_days")[0].GetString())!.Value;
        Assert.Equal(MemberCodeMath.DayRange(step, zone), (day.First, day.End));

        var box = await BeatAsync(device, club, club.BoxMac, m1: true);
        Assert.StartsWith($"m{refText}|1|", Assert.Single(box.GetProperty("roster").EnumerateArray()).GetString());
        Assert.Single(box.GetProperty("code_keys").EnumerateArray());

        // Before the cut-over the box's legacy roster minted the booking a code; a booking arriving
        // after it gets none, and is named by its player instead.
        Assert.Equal(1, await club.ReadAsync(app, db => db.AccessCodes.IgnoreQueryFilters().CountAsync(c => c.BookingId == booking.Id)));
        var later = await club.BookAsync(app, club.Pam, courtIndex: 2, startsInMinutes: 30);
        var after = await BeatAsync(device, club, club.BoxMac, m1: true);
        Assert.Equal(2, after.GetProperty("roster").GetArrayLength());
        Assert.Equal(0, await club.ReadAsync(app, db => db.AccessCodes.IgnoreQueryFilters().CountAsync(c => c.BookingId == later.Id)));
        Assert.Single(await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == MemberCodeRollout.PhaseChangedAction).ToListAsync()));
    }

    [SkippableFact]
    public async Task A_disabled_board_does_not_block_the_cut_over_and_an_enabled_silent_one_does()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "blocking");
        var device = app.CreateClient();
        await BeatAsync(device, club, club.BoxMac, m1: true);

        var admin = club.Member(app, club.AdminId, "admin");
        var rollout = JsonDocument.Parse(await admin.GetStringAsync("/api/v1/admin/devices/member-codes")).RootElement;
        Assert.Equal("legacy", rollout.GetProperty("phase").GetString());
        Assert.Equal(1, rollout.GetProperty("ready_boards").GetInt32());
        Assert.Equal($"gate-{club.DoorMac[^6..]}", Assert.Single(rollout.GetProperty("blocking").EnumerateArray()).GetProperty("device_code").GetString());

        var list = JsonDocument.Parse(await admin.GetStringAsync("/api/v1/admin/devices")).RootElement;
        var boxView = list.EnumerateArray().Single(d => d.GetProperty("mac_address").GetString() == club.BoxMac);
        Assert.True(boxView.GetProperty("member_codes").GetBoolean());
        Assert.Equal("codes:m1", Assert.Single(boxView.GetProperty("capabilities").EnumerateArray()).GetString());

        await club.WriteAsync(app, async db => (await db.Devices.IgnoreQueryFilters().FirstAsync(d => d.MacAddress == club.DoorMac)).Enabled = false);
        await BeatAsync(device, club, club.BoxMac, m1: true);
        Assert.Equal("v1", await PhaseAsync(club, app));
    }

    [SkippableFact]
    public async Task An_unacknowledged_box_gets_empty_arrays_after_cut_over_and_a_legacy_board_raises_a_notice()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "unack");
        await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: -5);
        await club.SetPhaseAsync(app, MemberCodeSettings.V1);
        await club.WriteAsync(app, async db => (await db.Devices.IgnoreQueryFilters().FirstAsync(d => d.MacAddress == club.BoxMac)).AutoRegistered = true);
        var device = app.CreateClient();

        var box = await BeatAsync(device, club, club.BoxMac, m1: true);
        Assert.Single(box.GetProperty("roster").EnumerateArray());      // the roster is still the box's
        Assert.Empty(box.GetProperty("code_days").EnumerateArray());    // …but no keys, and never omitted
        Assert.Empty(box.GetProperty("code_keys").EnumerateArray());

        // A spare flashed with old firmware, after cut-over: works online, and the club is told once.
        await BeatAsync(device, club, club.DoorMac, m1: false, kind: "gate");
        await BeatAsync(device, club, club.DoorMac, m1: false, kind: "gate");
        var notices = await club.ReadAsync(app, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Kind == AdminEventCatalogue.CodesCapabilityLost).ToListAsync());
        Assert.Single(notices);
    }

    [SkippableFact]
    public async Task The_cut_off_follows_the_clubs_delay_and_never_before_it()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "cutoff");
        var device = app.CreateClient();
        await BeatAsync(device, club, club.DoorMac, m1: true, kind: "gate");

        await club.SetPhaseAsync(app, MemberCodeSettings.V1, DateTimeOffset.UtcNow.AddDays(-13));
        await BeatAsync(device, club, club.BoxMac, m1: true);
        Assert.Equal("v1", await PhaseAsync(club, app));

        // A club that sets a delay below the floor is read at the floor (clamped on read).
        await club.SetAsync(app, MemberCodeSettings.CutoffDaysKey, 1);
        await BeatAsync(device, club, club.BoxMac, m1: true);
        Assert.Equal("v1", await PhaseAsync(club, app));

        await club.SetPhaseAsync(app, MemberCodeSettings.V1, DateTimeOffset.UtcNow.AddDays(-14).AddMinutes(-1));
        await BeatAsync(device, club, club.BoxMac, m1: true);
        Assert.Equal("v1_only", await PhaseAsync(club, app));

        // A board still on legacy firmware in v1_only is sent no legacy roster at all.
        await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: -5);
        var old = await BeatAsync(device, club, club.BoxMac, m1: false);
        Assert.Empty(old.GetProperty("roster").EnumerateArray());
    }

    [SkippableFact]
    public async Task The_settings_page_reads_and_bounds_the_rollout_keys()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "settings");
        var admin = club.Member(app, club.AdminId, "admin");

        var before = JsonDocument.Parse(await admin.GetStringAsync("/api/v1/admin/settings")).RootElement;
        Assert.Equal("legacy", before.GetProperty("member_code_phase").GetString());
        Assert.Equal(14, before.GetProperty("member_code_cutoff_days").GetInt32());

        async Task<HttpStatusCode> Put(object extra)
        {
            var body = JsonSerializer.SerializeToNode(new
            {
                sliceMinutes = 15, slicePriceCredits = 8, advanceBookingDays = 14, dayStartMinute = 0, dayEndMinute = 1440,
                penaltyPct = 30, graceWindowMinutes = 5, penaltyWindowMinutes = 15,
            })!.AsObject();
            foreach (var p in JsonSerializer.SerializeToNode(extra)!.AsObject().ToList()) body[p.Key] = p.Value?.DeepClone();
            return (await admin.PutAsJsonAsync("/api/v1/admin/settings", body)).StatusCode;
        }

        Assert.Equal(HttpStatusCode.BadRequest, await Put(new { member_code_phase = "v2" }));
        Assert.Equal(HttpStatusCode.BadRequest, await Put(new { member_code_cutoff_days = 13 }));
        Assert.Equal(HttpStatusCode.BadRequest, await Put(new { member_code_cutoff_days = 366 }));
        Assert.Equal(HttpStatusCode.OK, await Put(new { member_code_phase = "v1", member_code_cutoff_days = 30 }));

        var after = JsonDocument.Parse(await admin.GetStringAsync("/api/v1/admin/settings")).RootElement;
        Assert.Equal("v1", after.GetProperty("member_code_phase").GetString());
        Assert.Equal(30, after.GetProperty("member_code_cutoff_days").GetInt32());
        Assert.NotEqual(JsonValueKind.Null, after.GetProperty("member_code_cutover_at").ValueKind);
    }

    // ---- Forgery (§7) ---------------------------------------------------------------------------

    [SkippableFact]
    public async Task A_genuine_offline_activation_is_attendance_and_is_recorded_as_a_use()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "evidok");
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -5);

        var response = await app.CreateClient().SendAsync(club.Events(club.BoxMac, 1, "activation", 1, club.Code(club.Olga)));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var stored = await club.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == booking.Id));
        Assert.NotNull(stored.CheckedInAt);
        Assert.Equal(1, await club.UsesAsync(app, MemberCodeUseClass.Court));
        Assert.Empty(await club.ReadAsync(app, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Kind == AdminEventCatalogue.CodeForgerySuspected).ToListAsync()));
    }

    [SkippableTheory]
    [InlineData("on_mismatch")]
    [InlineData("off_mismatch")]
    public async Task A_forged_offline_activation_is_receipted_but_is_not_attendance_and_pages_every_admin(string kind)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "evidbad");
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -5);

        var real = club.Code(club.Olga);
        var token = kind == "on_mismatch" ? club.ForgedOn(club.Olga) : real[..13] + ((int.Parse(real[13..]) + 1) % 1_000_000).ToString("000000");
        var device = app.CreateClient();
        var response = JsonDocument.Parse(await (await device.SendAsync(club.Events(club.BoxMac, 1, "activation", 1, token))).Content.ReadAsStringAsync()).RootElement;
        Assert.Equal(1, response.GetProperty("accepted_through").GetInt64());

        // Uploaded again: acknowledged, and nothing raised twice.
        await device.SendAsync(club.Events(club.BoxMac, 1, "activation", 1, token));

        var stored = await club.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == booking.Id));
        Assert.Null(stored.CheckedInAt);
        var notice = Assert.Single(await club.ReadAsync(app, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Kind == AdminEventCatalogue.CodeForgerySuspected).ToListAsync()));
        Assert.Equal(club.Olga, notice.SubjectUserId);
        Assert.True(AdminEventCatalogue.IsSecurity(notice.Kind));
        Assert.Single(await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == "device.activation_forgery_suspected").ToListAsync()));
        Assert.Equal(0, await club.UsesAsync(app));
    }

    [SkippableFact]
    public async Task One_code_opening_two_doors_offline_is_flagged_the_second_time()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "evidtwice");
        var secondDoor = Guid.NewGuid().ToString("N")[..12];
        await club.WriteAsync(app, db =>
        {
            db.Devices.Add(new Device
            {
                TenantId = club.TenantId, DeviceCode = "gate-2", Name = "Side door", Kind = DeviceKind.Gate,
                Hardware = DeviceHardware.Esp32, MacAddress = secondDoor, GateKey = "side",
            });
            return Task.CompletedTask;
        });
        var code = club.Code(club.Pam);
        var device = app.CreateClient();

        await device.SendAsync(club.Events(club.DoorMac, 1, "gate_open", -1, code));
        await device.SendAsync(club.Events(secondDoor, 1, "gate_open", -1, code));

        var notice = Assert.Single(await club.ReadAsync(app, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Kind == AdminEventCatalogue.CodeForgerySuspected).ToListAsync()));
        Assert.Contains("twice", notice.PayloadJson);
        Assert.Equal(1, await club.UsesAsync(app, MemberCodeUseClass.Door));
    }
}
