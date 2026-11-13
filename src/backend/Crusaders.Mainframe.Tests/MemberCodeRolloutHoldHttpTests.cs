using System.Text.Json.Nodes;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// An administrator's rollback survives the next heartbeat (<c>docs/specs/member-code.md</c> §8,
/// §13): a backward move sets a hold the automatic cut-over respects until an administrator moves
/// forward again; and only ACKNOWLEDGED boards vote on the cut-over.
/// </summary>
public sealed class MemberCodeRolloutHoldHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private static async Task BeatBothAsync(HttpClient device, MemberCodeClub club)
    {
        Assert.Equal(HttpStatusCode.OK, (await device.SendAsync(club.Heartbeat(club.BoxMac, m1: true))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await device.SendAsync(club.Heartbeat(club.DoorMac, m1: true, kind: "gate"))).StatusCode);
    }

    private static async Task<JsonElement> SettingsAsync(HttpClient admin) =>
        JsonDocument.Parse(await admin.GetStringAsync("/api/v1/admin/settings")).RootElement.Clone();

    private static async Task<HttpStatusCode> PutAsync(HttpClient admin, object extra)
    {
        var body = JsonSerializer.SerializeToNode(new
        {
            sliceMinutes = 15, advanceBookingDays = 14, dayStartMinute = 0, dayEndMinute = 1440,
            penaltyPct = 30, graceWindowMinutes = 5, penaltyWindowMinutes = 15,
        })!.AsObject();
        foreach (var p in JsonSerializer.SerializeToNode(extra)!.AsObject().ToList()) body[p.Key] = p.Value?.DeepClone();
        return (await admin.PutAsJsonAsync("/api/v1/admin/settings", body)).StatusCode;
    }

    [SkippableFact]
    public async Task A_rollback_to_legacy_holds_against_the_next_heartbeat_until_an_admin_moves_forward()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "holdleg");
        var device = app.CreateClient();
        var admin = club.Member(app, club.AdminId, "admin");

        await BeatBothAsync(device, club);
        Assert.Equal("v1", (await SettingsAsync(admin)).GetProperty("member_code_phase").GetString());

        Assert.Equal(HttpStatusCode.OK, await PutAsync(admin, new { member_code_phase = "legacy" }));
        var rolled = await SettingsAsync(admin);
        Assert.Equal("legacy", rolled.GetProperty("member_code_phase").GetString());
        Assert.Equal(JsonValueKind.Null, rolled.GetProperty("member_code_cutover_at").ValueKind);
        Assert.Equal(JsonValueKind.Null, rolled.GetProperty("member_code_cutoff_at").ValueKind);
        Assert.True(rolled.GetProperty("member_code_manual_hold").GetBoolean());

        // Every board still speaks codes:m1. Before the hold, this heartbeat undid the rollback.
        await BeatBothAsync(device, club);
        Assert.Equal("legacy", (await SettingsAsync(admin)).GetProperty("member_code_phase").GetString());

        var rollout = JsonDocument.Parse(await admin.GetStringAsync("/api/v1/admin/devices/member-codes")).RootElement;
        Assert.True(rollout.GetProperty("manual_hold").GetBoolean());
        Assert.Equal(club.AdminId, rollout.GetProperty("manual_hold_by").GetGuid());
        Assert.InRange(rollout.GetProperty("manual_hold_at").GetDateTimeOffset(), DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddMinutes(1));

        // The admin moves forward again: the hold is gone and the automatic road is open.
        Assert.Equal(HttpStatusCode.OK, await PutAsync(admin, new { member_code_phase = "v1" }));
        var forward = await SettingsAsync(admin);
        Assert.False(forward.GetProperty("member_code_manual_hold").GetBoolean());
        Assert.Equal(JsonValueKind.Null, forward.GetProperty("member_code_manual_hold_by").ValueKind);
        Assert.NotEqual(JsonValueKind.Null, forward.GetProperty("member_code_cutover_at").ValueKind);
        await BeatBothAsync(device, club);
        Assert.Equal("v1", (await SettingsAsync(admin)).GetProperty("member_code_phase").GetString());
    }

    [SkippableFact]
    public async Task A_rollback_from_v1_only_to_v1_restarts_the_cut_off_clock_instead_of_firing_again()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "holdv1");
        var device = app.CreateClient();
        var admin = club.Member(app, club.AdminId, "admin");

        // Cut over a month ago, cut off a fortnight later.
        await club.SetPhaseAsync(app, MemberCodeSettings.V1Only, DateTimeOffset.UtcNow.AddDays(-30));
        await club.SetAsync(app, MemberCodeSettings.CutoffAtKey, DateTimeOffset.UtcNow.AddDays(-16).ToString("O"));

        Assert.Equal(HttpStatusCode.OK, await PutAsync(admin, new { member_code_phase = "v1" }));
        var rolled = await SettingsAsync(admin);
        Assert.Equal("v1", rolled.GetProperty("member_code_phase").GetString());
        Assert.InRange(rolled.GetProperty("member_code_cutover_at").GetDateTimeOffset(), DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddMinutes(1));
        Assert.Equal(JsonValueKind.Null, rolled.GetProperty("member_code_cutoff_at").ValueKind);
        Assert.True(rolled.GetProperty("member_code_manual_hold").GetBoolean());

        await BeatBothAsync(device, club);
        Assert.Equal("v1", (await SettingsAsync(admin)).GetProperty("member_code_phase").GetString());
    }

    [SkippableFact]
    public async Task The_hold_can_be_set_and_cleared_without_moving_the_phase()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "holdset");
        var device = app.CreateClient();
        var admin = club.Member(app, club.AdminId, "admin");

        Assert.Equal(HttpStatusCode.OK, await PutAsync(admin, new { member_code_manual_hold = true }));
        await BeatBothAsync(device, club);
        Assert.Equal("legacy", (await SettingsAsync(admin)).GetProperty("member_code_phase").GetString());

        Assert.Equal(HttpStatusCode.OK, await PutAsync(admin, new { member_code_manual_hold = false }));
        await BeatBothAsync(device, club);
        Assert.Equal("v1", (await SettingsAsync(admin)).GetProperty("member_code_phase").GetString());
    }

    /// <summary>
    /// MCV1-03 (member-code §8 step 3, 2026-11-13): an enabled court box nobody has acknowledged,
    /// heard this week, BLOCKS the cut-over — one named door cut a club over while every court box
    /// was unacknowledged and held no keys — and it is released by acknowledging the box or by
    /// disabling it. A spare unplugged for over a week stops blocking. It never votes.
    /// </summary>
    [SkippableFact]
    public async Task An_unacknowledged_court_box_heard_this_week_blocks_the_cut_over_and_never_votes()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "unackvote");
        var device = app.CreateClient();
        var admin = club.Member(app, club.AdminId, "admin");

        // A box on a bench: auto-registered, enabled, never acknowledged — and heard just now.
        var spare = Guid.NewGuid().ToString("N")[..12];
        await club.WriteAsync(app, db =>
        {
            db.Devices.Add(new Device
            {
                TenantId = club.TenantId, DeviceCode = $"box-{spare[^6..]}", Name = "Spare", Kind = DeviceKind.CourtBox,
                MacAddress = spare, CourtNumbers = [1], AutoRegistered = true,
            });
            return Task.CompletedTask;
        });
        Assert.Equal(HttpStatusCode.OK, (await device.SendAsync(club.Heartbeat(spare, m1: true))).StatusCode);

        await BeatBothAsync(device, club);
        await BeatBothAsync(device, club);
        Assert.Equal("legacy", (await SettingsAsync(admin)).GetProperty("member_code_phase").GetString());

        var rollout = JsonDocument.Parse(await admin.GetStringAsync("/api/v1/admin/devices/member-codes")).RootElement;
        var blocker = Assert.Single(rollout.GetProperty("blocking").EnumerateArray());
        Assert.Equal($"box-{spare[^6..]}", blocker.GetProperty("device_code").GetString());
        Assert.Equal("unacknowledged", blocker.GetProperty("blocks").GetString());
        Assert.Equal(2, rollout.GetProperty("enabled_boards").GetInt32());
        Assert.Equal(2, rollout.GetProperty("ready_boards").GetInt32());

        // Every acknowledged board's keys, the ready ones included (the console's per-board line,
        // MCV1-07); the unacknowledged spare is on the blocking list and not here.
        var keys = rollout.GetProperty("keys").EnumerateArray().ToList();
        Assert.Equal(2, keys.Count);
        Assert.DoesNotContain(keys, k => k.GetProperty("device_code").GetString() == $"box-{spare[^6..]}");
        Assert.All(keys, k => Assert.True(k.GetProperty("acknowledged").GetBoolean()));
        Assert.All(keys, k => Assert.Equal(JsonValueKind.Number, k.GetProperty("keys_sent").ValueKind));

        // Heard more than a week ago — unplugged — it no longer blocks.
        await club.WriteAsync(app, async db =>
            (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == spare)).LastSeenAt = DateTimeOffset.UtcNow.AddDays(-8));
        await BeatBothAsync(device, club);
        Assert.Equal("v1", (await SettingsAsync(admin)).GetProperty("member_code_phase").GetString());
    }

    /// <summary>MCV1-03, the release: acknowledging the blocking box, or disabling it, lets the cut-over happen.</summary>
    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Acknowledging_or_disabling_the_blocking_box_releases_the_cut_over(bool acknowledge)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, acknowledge ? "unackack" : "unackoff");
        var device = app.CreateClient();
        var admin = club.Member(app, club.AdminId, "admin");

        var spare = Guid.NewGuid().ToString("N")[..12];
        Assert.Equal(HttpStatusCode.OK, (await device.SendAsync(club.Heartbeat(spare, m1: true))).StatusCode);
        var spareId = await club.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().Where(d => d.MacAddress == spare).Select(d => d.Id).SingleAsync());
        await BeatBothAsync(device, club);
        Assert.Equal("legacy", (await SettingsAsync(admin)).GetProperty("member_code_phase").GetString());

        var patch = acknowledge ? new JsonObject { ["name"] = "Annex box" } : new JsonObject { ["enabled"] = false };
        var response = await admin.PatchAsync($"/api/v1/admin/devices/{spareId}",
            new StringContent(patch.ToJsonString(), System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        // Acknowledged, it now votes and needs a keyed beat of its own; disabled, it has no say.
        if (acknowledge) Assert.Equal(HttpStatusCode.OK, (await device.SendAsync(club.Heartbeat(spare, m1: true))).StatusCode);
        await BeatBothAsync(device, club);
        Assert.Equal("v1", (await SettingsAsync(admin)).GetProperty("member_code_phase").GetString());
    }

    [SkippableFact]
    public async Task An_unacknowledged_board_alone_can_never_cast_the_deciding_vote()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var device = app.CreateClient();

        // The other way round: with every acknowledged board disabled, an unacknowledged m1 board
        // alone does not cut a club over.
        var other = await MemberCodeClub.SeedAsync(app, "unackalone");
        await other.WriteAsync(app, async db =>
        {
            foreach (var d in await db.Devices.IgnoreQueryFilters().Where(d => d.TenantId == other.TenantId).ToListAsync()) d.Enabled = false;
            var stranger = Guid.NewGuid().ToString("N")[..12];
            db.Devices.Add(new Device
            {
                TenantId = other.TenantId, DeviceCode = $"box-{stranger[^6..]}", Name = "Stranger", Kind = DeviceKind.CourtBox,
                MacAddress = stranger, CourtNumbers = [1], AutoRegistered = true, Capabilities = ["codes:m1"],
            });
        });
        var strangerMac = await other.ReadAsync(app, db => db.Devices.IgnoreQueryFilters()
            .Where(d => d.TenantId == other.TenantId && d.Enabled).Select(d => d.MacAddress).FirstAsync());
        Assert.Equal(HttpStatusCode.OK, (await device.SendAsync(other.Heartbeat(strangerMac!, m1: true))).StatusCode);
        Assert.Equal("legacy", (await SettingsAsync(other.Member(app, other.AdminId, "admin"))).GetProperty("member_code_phase").GetString());
    }
}
