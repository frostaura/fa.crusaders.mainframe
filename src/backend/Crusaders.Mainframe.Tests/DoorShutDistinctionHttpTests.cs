using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// C1 / C2 — a door shut on its own and a door shut with the fleet are two different facts, and
/// the wire says which is which.
///
/// <para>
/// <b>The semantics were right and unreadable.</b> A reopen-all undoes a shut-all; a door an
/// admin took out of service individually stays shut, because they did it for a reason this
/// system knows nothing about. What the console could see of that was <c>{"doors":[]}</c> — so
/// after shut-one, shut-all, reopen-all it printed "0 doors reopened", the individual door
/// stayed shut with nothing on screen saying so, and the fleet control was labelled "Reopen all
/// 3" against a club where it would reopen none. A zero-change result that does not explain
/// itself is the defect.
/// </para>
/// </summary>
public sealed class DoorShutDistinctionHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public DoorShutDistinctionHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string OverviewPath = "/api/v1/admin/doors";

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    private static List<Guid> Ids(JsonElement body, string key)
        => body.GetProperty(key).EnumerateArray().Select(d => d.GetProperty("id").GetGuid()).ToList();

    /// <summary>
    /// The reviewer's exact sequence: shut one door on its own, shut all, reopen all. The
    /// individual door stays shut — and the response NAMES it rather than answering an
    /// unexplained empty list.
    /// </summary>
    [SkippableFact]
    public async Task A_reopen_that_leaves_a_door_shut_names_the_door_it_left()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "shutdist1");
        var alone = await club.AddDoorAsync(factory, "gate-sd0001", "front-door", name: "Front door");
        var withFleet = await club.AddDoorAsync(factory, "gate-sd0002", "side-door", name: "Side door");

        var admin = club.AdminClient(factory);

        await ShutIndividuallyAsync(factory, alone);
        await admin.PostAsync("/api/v1/admin/doors/shut-all", null);

        var reopened = await (await admin.PostAsync("/api/v1/admin/doors/reopen-all", null))
            .Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal([withFleet], Ids(reopened, "doors"));

        var left = reopened.GetProperty("left_shut").EnumerateArray().Single();
        Assert.Equal(alone, left.GetProperty("id").GetGuid());
        Assert.Equal("Front door", left.GetProperty("name").GetString());
        Assert.Equal("front-door", left.GetProperty("gate_key").GetString());
    }

    /// <summary>
    /// The degenerate case the reviewer actually hit: nothing to reopen at all. The result is
    /// empty AND carries the reason it is empty, so the page never prints "0 doors reopened"
    /// on its own.
    /// </summary>
    [SkippableFact]
    public async Task A_reopen_with_nothing_to_reopen_still_says_why()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "shutdist2");
        var alone = await club.AddDoorAsync(factory, "gate-sd0003", "front-door", name: "Front door");
        await ShutIndividuallyAsync(factory, alone);

        var reopened = await (await club.AdminClient(factory).PostAsync("/api/v1/admin/doors/reopen-all", null))
            .Content.ReadFromJsonAsync<JsonElement>();

        Assert.Empty(reopened.GetProperty("doors").EnumerateArray());
        Assert.Equal([alone], Ids(reopened, "left_shut"));
    }

    /// <summary>A shut-all has nothing to leave behind, and the key is present and empty.</summary>
    [SkippableFact]
    public async Task A_shut_all_leaves_nothing_behind()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "shutdist3");
        await club.AddDoorAsync(factory, "gate-sd0004", "front-door");

        var shut = await (await club.AdminClient(factory).PostAsync("/api/v1/admin/doors/shut-all", null))
            .Content.ReadFromJsonAsync<JsonElement>();

        Assert.Single(shut.GetProperty("doors").EnumerateArray());
        Assert.Empty(shut.GetProperty("left_shut").EnumerateArray());
    }

    /// <summary>
    /// The overview carries the same distinction as two named lists, so the banner can say it
    /// in words and the fleet control can exist only when it would do something.
    /// </summary>
    [SkippableFact]
    public async Task The_overview_separates_shut_together_from_shut_individually()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "shutdist4");
        var alone = await club.AddDoorAsync(factory, "gate-sd0005", "front-door", name: "Front door");
        var withFleet = await club.AddDoorAsync(factory, "gate-sd0006", "side-door", name: "Side door");
        var open = await club.AddDoorAsync(factory, "gate-sd0007", "back-door", name: "Zack door");

        var admin = club.AdminClient(factory);
        await ShutIndividuallyAsync(factory, alone);

        // Nothing shut with the fleet yet: the banner may not offer a fleet reopen.
        var before = await admin.GetFromJsonAsync<JsonElement>(OverviewPath);
        Assert.False(before.GetProperty("shut_all_active").GetBoolean());
        Assert.Empty(before.GetProperty("shut_together").EnumerateArray());
        Assert.Equal([alone], Ids(before, "shut_individually"));

        await admin.PostAsync("/api/v1/admin/doors/shut-all", null);

        var after = await admin.GetFromJsonAsync<JsonElement>(OverviewPath);
        Assert.True(after.GetProperty("shut_all_active").GetBoolean());
        // Name ascending, the overview's own order: "Side door" before "Zack door".
        Assert.Equal([withFleet, open], Ids(after, "shut_together"));
        Assert.Equal([alone], Ids(after, "shut_individually"));

        // C2: the banner may not say "members can't get in" for a door it cannot confirm, so
        // every door row still carries the two facts that decide confirmed-vs-not.
        foreach (var door in after.GetProperty("doors").EnumerateArray())
        {
            var device = door.GetProperty("device");
            Assert.True(device.TryGetProperty("last_seen_at", out _));
            Assert.True(device.GetProperty("offline_after_seconds").GetInt32() > 0);
            Assert.False(device.GetProperty("enabled").GetBoolean());
            Assert.NotEqual(JsonValueKind.Null, device.GetProperty("out_of_service_since").ValueKind);
        }
    }

    /// <summary>
    /// Taking a door out of service the way an admin does — the PATCH on the device row, which
    /// is the 403 path W1.5 rides and is deliberately NOT the fleet column.
    /// </summary>
    private static async Task ShutIndividuallyAsync(TestWebAppFactory factory, Guid doorId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var door = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.Id == doorId);
        door.Enabled = false;
        door.OutOfServiceSince = DateTimeOffset.UtcNow;
        door.ShutByShutAllAt = null;
        await db.SaveChangesAsync();
    }
}
