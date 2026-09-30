using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 4, A4-5: the control board names each BOX once, with what tells two identically
/// named boxes apart (code and MAC), so "boxes that haven't called in" counts boxes, not tiles.
/// </summary>
public sealed class R4ControlBoardBoxesHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string BoardPath = "/api/v1/admin/control-board";

    [SkippableFact]
    public async Task One_box_on_four_courts_is_one_box_and_duplicates_carry_their_mac()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await ControlBoardClub.SeedAsync(factory, "r4a5box");
        foreach (var n in new[] { 1, 2, 3, 4 }) await club.AddCourtAsync(factory, n);
        var now = DateTimeOffset.UtcNow;
        var silentId = await club.AddBoxAsync(factory, "box-r4a0001", [1, 2, 3, 4], lastSeenAt: now.AddHours(-3));
        var dupId = await club.AddBoxAsync(factory, "box-r4a0002", [1], lastSeenAt: now.AddSeconds(-5));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);

        var boxes = body.GetProperty("boxes").EnumerateArray().ToList();
        Assert.Equal(2, boxes.Count);
        var silent = boxes.Single(b => b.GetProperty("device_id").GetGuid() == silentId);
        Assert.Equal("offline", silent.GetProperty("link").GetString());
        Assert.Equal([1, 2, 3, 4], silent.GetProperty("court_numbers").EnumerateArray().Select(c => c.GetInt32()));
        Assert.Single(boxes, b => b.GetProperty("link").GetString() == "offline");

        string mac;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            mac = (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.Id == silentId)).MacAddress;
        }
        Assert.Equal(mac, silent.GetProperty("mac_address").GetString());

        var one = body.GetProperty("courts").EnumerateArray().Single(c => c.GetProperty("court_number").GetInt32() == 1);
        Assert.Equal(dupId, one.GetProperty("device").GetProperty("device_id").GetGuid());
        Assert.False(string.IsNullOrEmpty(one.GetProperty("device").GetProperty("mac_address").GetString()));
        var other = Assert.Single(one.GetProperty("other_boxes").EnumerateArray());
        Assert.Equal(mac, other.GetProperty("mac_address").GetString());
    }
}
