using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 19, lane BE19, D19-4: a device body that names two boards is never filed against one of them.
///
/// <para>
/// R18 D18-5 refused a body naming its board twice (or one other than the board the limiter charged), but its
/// <c>malformed_body</c> fault was filed against whichever MAC the raw text named FIRST — so a body naming the
/// court box and then the door put the box's name on a fault the door may have sent, and the reverse order
/// blamed the door. Now such a fault is filed against no board (the club's folded row), with every board the
/// body named in its detail, in both orders and whatever the second MAC is. A body naming one board is still
/// filed against that board.
/// </para>
/// </summary>
public sealed class R19DeviceBodyHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private sealed record Rig(MemberCodeClub Club, WebApplicationFactory<Program> App, HttpClient Http);

    private async Task<Rig> RigAsync(string prefix)
    {
        var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, prefix);
        return new Rig(club, app, app.CreateClient());
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

    private static async Task<HttpStatusCode> PostRawAsync(Rig r, string json)
    {
        var req = r.Club.Device("/api/v1/device/heartbeat", new JsonObject());
        req.Content = new StringContent(json, Encoding.UTF8, "application/json");
        var response = await r.Http.SendAsync(req);
        if (response.StatusCode == HttpStatusCode.BadRequest)
        {
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            Assert.Equal(DeviceErrorCodes.MalformedBody, doc.RootElement.GetProperty("error").GetString());
        }
        return response.StatusCode;
    }

    /// <summary>
    /// Both orders, a second MAC in either spelling of the key, a second MAC nested under another field (the
    /// limiter charges the nested one, the route would act as the top-level one), an unregistered second MAC,
    /// and a cut body (not JSON at all) naming two boards: never filed against either board.
    /// </summary>
    [SkippableTheory]
    [InlineData("box-gate", "{\"mac\":\"{BOX}\",\"uptime_ms\":1000,\"mac\":\"{DOOR}\"}")]
    [InlineData("gate-box", "{\"mac\":\"{DOOR}\",\"uptime_ms\":1000,\"mac\":\"{BOX}\"}")]
    [InlineData("box-GATE", "{\"mac\":\"{BOX}\",\"uptime_ms\":1000,\"MAC\":\"{DOOR}\"}")]
    [InlineData("nest-box", "{\"x\":{\"mac\":\"{BOX}\"},\"mac\":\"{DOOR}\",\"uptime_ms\":1000}")]
    [InlineData("nest-gate", "{\"x\":{\"mac\":\"{DOOR}\"},\"mac\":\"{BOX}\",\"uptime_ms\":1000}")]
    [InlineData("box-stranger", "{\"mac\":\"{BOX}\",\"uptime_ms\":1000,\"mac\":\"{STRANGER}\"}")]
    [InlineData("cut-box-gate", "{\"mac\":\"{BOX}\",\"mac\":\"{DOOR}\",\"uptime_ms\":")]
    [InlineData("cut-gate-box", "{\"mac\":\"{DOOR}\",\"mac\":\"{BOX}\",\"uptime_ms\":")]
    public async Task A_body_naming_two_boards_is_filed_against_neither(string label, string template)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r19b2b");
        await using var _ = r.App;
        var stranger = Guid.NewGuid().ToString("N")[..12];
        var json = template.Replace("{BOX}", r.Club.BoxMac, StringComparison.Ordinal)
            .Replace("{DOOR}", r.Club.DoorMac, StringComparison.Ordinal)
            .Replace("{STRANGER}", stranger, StringComparison.Ordinal);

        Assert.Equal(HttpStatusCode.BadRequest, await PostRawAsync(r, json));

        var fault = Assert.Single(await MalformedFaultsAsync(r));
        Assert.Null(fault.DeviceId);
        Assert.Null(fault.ClaimedDeviceCode);
        var named = label.Contains("stranger", StringComparison.Ordinal) ? stranger : r.Club.DoorMac;
        Assert.Contains(r.Club.BoxMac, fault.Detail, StringComparison.Ordinal);
        Assert.Contains(named, fault.Detail, StringComparison.Ordinal);
        Assert.StartsWith("heartbeat: ", fault.Detail, StringComparison.Ordinal);
    }

    /// <summary>
    /// Varied: one board named — twice, in one body that is refused, or once in a body that cannot be read — is
    /// still filed against that board, door or box, and the detail is the plain words with no list.
    /// </summary>
    [SkippableTheory]
    [InlineData("{\"mac\":\"{BOX}\",\"uptime_ms\":1000,\"mac\":\"{BOX}\"}", false, true)]
    [InlineData("{\"mac\":\"{DOOR}\",\"uptime_ms\":1000,\"MAC\":\"{DOOR}\"}", true, true)]
    [InlineData("{\"mac\":\"{BOX}\",\"uptime_ms\":", false, false)]
    [InlineData("{\"mac\":\"{DOOR}\",\"uptime_ms\":", true, false)]
    public async Task A_body_naming_one_board_is_still_filed_against_it(string template, bool door, bool twice)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r19b1b");
        await using var _ = r.App;
        var json = template.Replace("{BOX}", r.Club.BoxMac, StringComparison.Ordinal).Replace("{DOOR}", r.Club.DoorMac, StringComparison.Ordinal);

        Assert.Equal(HttpStatusCode.BadRequest, await PostRawAsync(r, json));

        var fault = Assert.Single(await MalformedFaultsAsync(r));
        var mac = door ? r.Club.DoorMac : r.Club.BoxMac;
        var board = await r.Club.ReadAsync(r.App, db => db.Devices.IgnoreQueryFilters().AsNoTracking().SingleAsync(d => d.MacAddress == mac));
        Assert.Equal(board.Id, fault.DeviceId);
        Assert.Equal("heartbeat: " + (twice ? DeviceBody.TwoBoardsDetail : DeviceBody.NotJsonDetail), fault.Detail);
    }

    /// <summary>
    /// The headline the monitoring list and the CSV serve follows the detail with the board list taken off:
    /// a two-boards row has its own true headline (it was read; nothing in it was used), a read-anyway row
    /// keeps its read-anyway headline whatever boards it names, and an unreadable one stays unreadable.
    /// </summary>
    [Theory]
    [InlineData(DeviceBody.TwoBoardsDetail, false, DeviceErrorCodes.MalformedBodyTwoBoardsHeadline)]
    [InlineData(DeviceBody.TwoBoardsDetail, true, DeviceErrorCodes.MalformedBodyTwoBoardsHeadline)]
    [InlineData(DeviceBody.ReplacedDetail, true, DeviceErrorCodes.MalformedBodyReadAnywayHeadline)]
    [InlineData(DeviceBody.ReplacedDetail, false, DeviceErrorCodes.MalformedBodyReadAnywayHeadline)]
    [InlineData(DeviceBody.NotJsonDetail, true, "A board sent something the server could not read")]
    public void A_malformed_body_headline_reads_the_detail_without_its_board_list(string detail, bool boards, string headline)
    {
        var stored = "heartbeat: " + detail + (boards ? " (boards named: 5ccf7f1a2b3c, 5ccf7f1a2b3d)" : "");
        Assert.Equal(headline, DeviceErrorCodes.HeadlineOf(DeviceErrorCodes.MalformedBody, stored));
    }

    /// <summary>Over HTTP: the two-boards row's headline on the admin monitoring list.</summary>
    [SkippableFact]
    public async Task A_two_boards_row_is_headlined_as_two_boards_on_the_monitoring_list()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var r = await RigAsync("r19bhl");
        await using var _ = r.App;
        var json = "{\"mac\":\"" + r.Club.BoxMac + "\",\"uptime_ms\":1000,\"mac\":\"" + r.Club.DoorMac + "\"}";
        Assert.Equal(HttpStatusCode.BadRequest, await PostRawAsync(r, json));
        Assert.Single(await MalformedFaultsAsync(r));

        var admin = r.Club.Member(r.App, r.Club.AdminId, "admin");
        using var doc = JsonDocument.Parse(await admin.GetStringAsync("/api/v1/admin/monitoring/errors"));
        var row = doc.RootElement.GetProperty("rows").EnumerateArray().Single(e => e.GetProperty("code").GetString() == DeviceErrorCodes.MalformedBody);
        Assert.Equal(DeviceErrorCodes.MalformedBodyTwoBoardsHeadline, row.GetProperty("headline").GetString());
    }
}
