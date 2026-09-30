using System.Net.Http.Json;
using System.Text.Json;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 3, A-11: with several boxes claiming one court, the control board took whichever
/// box the database returned first — a board replaced 22 hours ago — and the tile contradicted
/// itself ("last reported 16:50" beside "not reporting · 22h ago"). The tile now reports the
/// freshest ENABLED box (an out-of-service box only when it is the only one), and says how many
/// enabled boxes claim the court and which, so the console can warn about the duplicate.
/// </summary>
public sealed class R3ControlBoardBoxesHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string BoardPath = "/api/v1/admin/control-board";

    private static JsonElement Court(JsonElement body, int number)
        => body.GetProperty("courts").EnumerateArray().Single(c => c.GetProperty("court_number").GetInt32() == number);

    [SkippableFact]
    public async Task A_court_with_two_boxes_reports_the_freshest_and_flags_the_duplicate()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var club = await ControlBoardClub.SeedAsync(factory, "r3a11dup");
        await club.AddCourtAsync(factory, 1);
        await club.AddCourtAsync(factory, 2);
        var now = DateTimeOffset.UtcNow;
        // The stale box first, so "first row" is the wrong answer.
        await club.AddBoxAsync(factory, "box-r3a0001", [1], lastSeenAt: now.AddHours(-22), name: "Old box");
        await club.AddBoxAsync(factory, "box-r3a0002", [1], lastSeenAt: now.AddSeconds(-5), name: "New box");
        await club.AddBoxAsync(factory, "box-r3a0003", [2], lastSeenAt: now.AddSeconds(-5), name: "Court 2 box");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);

        var one = Court(body, 1);
        Assert.Equal("box-r3a0002", one.GetProperty("device").GetProperty("device_code").GetString());
        Assert.Equal("online", one.GetProperty("device").GetProperty("link").GetString());
        Assert.Equal(2, one.GetProperty("boxes_on_court").GetInt32());
        var other = Assert.Single(one.GetProperty("other_boxes").EnumerateArray());
        Assert.Equal("box-r3a0001", other.GetProperty("device_code").GetString());
        Assert.Equal("Old box", other.GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.String, other.GetProperty("last_seen_at").ValueKind);

        var two = Court(body, 2);
        Assert.Equal(1, two.GetProperty("boxes_on_court").GetInt32());
        Assert.Empty(two.GetProperty("other_boxes").EnumerateArray());
    }

    [SkippableFact]
    public async Task An_enabled_box_outranks_a_fresher_one_out_of_service_and_a_lone_disabled_box_still_shows()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var club = await ControlBoardClub.SeedAsync(factory, "r3a11dis");
        await club.AddCourtAsync(factory, 1);
        await club.AddCourtAsync(factory, 2);
        var now = DateTimeOffset.UtcNow;
        await club.AddBoxAsync(factory, "box-r3b0001", [1], lastSeenAt: now.AddSeconds(-2), enabled: false, outOfServiceSince: now.AddHours(-1));
        await club.AddBoxAsync(factory, "box-r3b0002", [1], lastSeenAt: now.AddSeconds(-30));
        await club.AddBoxAsync(factory, "box-r3b0003", [2], lastSeenAt: now, enabled: false, outOfServiceSince: now.AddHours(-1));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(BoardPath);

        var one = Court(body, 1);
        Assert.Equal("box-r3b0002", one.GetProperty("device").GetProperty("device_code").GetString());
        Assert.Equal(1, one.GetProperty("boxes_on_court").GetInt32());
        Assert.Empty(one.GetProperty("other_boxes").EnumerateArray());

        var two = Court(body, 2);
        Assert.Equal("box-r3b0003", two.GetProperty("device").GetProperty("device_code").GetString());
        Assert.Equal("out_of_service", two.GetProperty("device").GetProperty("link").GetString());
        Assert.Equal(0, two.GetProperty("boxes_on_court").GetInt32());
    }
}
