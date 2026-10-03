using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 11, D11-2. A door refusing a member's GENUINE code while offline — a replay, a code
/// outside its window, a stale roster (GateFlow) — uploads the refusal as a plain
/// <c>unknown_scan</c>, and the server logged it "not recognised", nobody named, nothing on the
/// member's Night. The server re-checks the code at the scan's instant as it does a
/// <c>gate_open</c>, names the member with the neutral <c>refused_offline</c>, and never claims a
/// use or records the code. A court box's offline refusal rides the same path.
/// </summary>
public sealed class R11OfflineRefusalHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string LogPath = "/api/v1/admin/doors/activity";

    private static async Task<List<JsonElement>> DoorLogAsync(MemberCodeClub club, WebApplicationFactory<Program> app, string query = "")
    {
        var body = await club.Member(app, club.AdminId, "admin").GetFromJsonAsync<JsonElement>(LogPath + query);
        return [.. body.GetProperty("items").EnumerateArray()];
    }

    private static async Task<List<JsonElement>> NightAsync(MemberCodeClub club, WebApplicationFactory<Program> app, Guid user)
    {
        var body = await club.Member(app, club.AdminId, "admin").GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{user}/trace");
        return [.. body.GetProperty("events").EnumerateArray()];
    }

    [SkippableFact]
    public async Task A_doors_offline_refusal_of_a_genuine_code_names_the_member_neutrally()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r11offref");
        var device = app.CreateClient();
        var code = club.Code(club.Pam);

        // The door opened online on the code, then refused the same code offline (a replay).
        Assert.True((await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(code)))).GetProperty("opened").GetBoolean());
        (await device.SendAsync(club.Events(club.DoorMac, 1, "unknown_scan", -1, code))).EnsureSuccessStatusCode();

        var row = Assert.Single(await DoorLogAsync(club, app), r => r.GetProperty("action").GetString() == "device.unknown_scan");
        Assert.Equal(club.Pam, row.GetProperty("member").GetProperty("id").GetGuid());
        Assert.Equal(DoorTrail.RefusedOffline, row.GetProperty("reason").GetString());
        Assert.True(row.GetProperty("offline").GetBoolean());
        Assert.Equal("Refused offline", DoorWords.ReasonOf("device.unknown_scan", DoorTrail.RefusedOffline));

        // The filters agree with the label: it is not "not recognised", it is its own reason.
        Assert.DoesNotContain(await DoorLogAsync(club, app, "?reason=not_recognised"), r => r.GetProperty("action").GetString() == "device.unknown_scan");
        Assert.Single(await DoorLogAsync(club, app, "?reason=refused_offline"));

        // A refusal is no act: no use claimed, no alarm, no second verdict row, no code stored.
        Assert.Equal(1, await club.UsesAsync(app, MemberCodeUseClass.Door));
        var audits = await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action.StartsWith("device.unknown_scan")).ToListAsync());
        var audit = Assert.Single(audits);
        Assert.DoesNotContain(code, audit.DetailsJson, StringComparison.Ordinal);
        Assert.Empty(await club.ReadAsync(app, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Kind == AdminEventCatalogue.CodeForgerySuspected).ToListAsync()));

        var night = await NightAsync(club, app, club.Pam);
        var refused = Assert.Single(night, e => e.GetProperty("kind").GetString() == TraceKinds.DoorRefused);
        Assert.EndsWith(" — refused offline", refused.GetProperty("headline").GetString(), StringComparison.Ordinal);
    }

    /// <summary>A code the server cannot prove keeps the old row: not recognised, nobody named.</summary>
    [SkippableFact]
    public async Task An_offline_refusal_of_an_unprovable_code_names_nobody()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r11offbad");
        var genuine = club.Code(club.Pam);
        var forged = genuine[..^4] + (genuine[^4..] == "0000" ? "1111" : "0000");

        (await app.CreateClient().SendAsync(club.Events(club.DoorMac, 1, "unknown_scan", -1, forged))).EnsureSuccessStatusCode();

        var row = Assert.Single(await DoorLogAsync(club, app), r => r.GetProperty("action").GetString() == "device.unknown_scan");
        Assert.Equal(JsonValueKind.Null, row.GetProperty("member").ValueKind);
        Assert.Equal("not_recognised", row.GetProperty("reason").GetString());
    }

    /// <summary>The court box's offline refusal shares the path: the member and the court are named on their Night.</summary>
    [SkippableFact]
    public async Task A_court_boxs_offline_refusal_of_a_genuine_code_is_on_the_members_night()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r11offcourt");
        var code = club.Code(club.Olga);

        // Relay 1 of the box is court 2.
        (await app.CreateClient().SendAsync(club.Events(club.BoxMac, 1, "unknown_scan", 1, code))).EnsureSuccessStatusCode();

        var audit = Assert.Single(await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action.StartsWith("device.court_unknown_scan")).ToListAsync()));
        Assert.Equal(club.Olga, audit.SubjectUserId);
        Assert.DoesNotContain(code, audit.DetailsJson, StringComparison.Ordinal);

        var night = await NightAsync(club, app, club.Olga);
        var refused = Assert.Single(night, e => e.GetProperty("kind").GetString() == TraceKinds.CourtRefused);
        // R12 D12-2: said once — never "refused … refused offline".
        Assert.Equal("Was refused at Court 2 while its box was offline", refused.GetProperty("headline").GetString());

        // Never a door row.
        Assert.DoesNotContain(await DoorLogAsync(club, app), r => r.GetProperty("action").GetString()!.Contains("unknown_scan", StringComparison.Ordinal));
    }
}
