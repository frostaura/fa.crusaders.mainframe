using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// D2-B27 — a court box's scan is not a door's scan, on any surface.
///
/// <para>
/// <c>unknown_scan</c> is declared on the upload path with no dispatch case and no kind guard,
/// unlike <c>gate_open</c>, which is gated — and a court box genuinely emits one. Its action is
/// classified as a door REFUSAL by <see cref="DoorTrail"/>, and
/// <c>DoorLogQuery.Filtered</c> had no <c>Kind == Gate</c> predicate at all. So a member
/// mis-scanning at a COURT BOX appeared in the club's door log as somebody turned away at a
/// DOOR, was counted in the club's per-day door totals, and was exported into the club's door
/// log under a door's name.
/// </para>
///
/// <para>
/// <b>A removed door is the case that decides how the fix is written.</b> Filtering to boards
/// that ARE gates would delete every row belonging to a door the club has since removed — the
/// rows the <c>removed_door</c> filter exists to serve, whose whole point is that they survive
/// their board. The rule is therefore "not at a board this club still has that is not a door",
/// and the third test below is what holds it there.
/// </para>
/// </summary>
public sealed class TraceDoorKindHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public TraceDoorKindHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string LogPath = "/api/v1/admin/doors/activity";

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    private static List<JsonElement> Items(JsonElement body) => body.GetProperty("items").EnumerateArray().ToList();

    /// <summary>A court box's unknown scan is not in the club's door log, and is not in its count.</summary>
    [SkippableFact]
    public async Task A_court_boxs_unknown_scan_is_not_a_door_refusal()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "b27box");
        var boxId = await club.AddCourtBoxAsync(factory, "box-b270001");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(
            factory, boxId, DoorTrail.OfflineUnknownScanAction, now.AddMinutes(-5),
            deviceCode: "box-b270001", occurredAt: now.AddMinutes(-5));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath);

        Assert.Empty(Items(body));

        // The heading's number and the list have to agree, or the page says "1 scan" over none.
        Assert.Equal(0, body.GetProperty("total").GetInt32());
    }

    /// <summary>The same row at a real door is still a door refusal. The fix narrows nothing else.</summary>
    [SkippableFact]
    public async Task The_same_scan_at_a_door_is_still_a_door_refusal()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "b27door");
        var doorId = await club.AddDoorAsync(factory, "gate-b270002", "front-door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(
            factory, doorId, DoorTrail.OfflineUnknownScanAction, now.AddMinutes(-5),
            gateKey: "front-door", deviceCode: "gate-b270002", occurredAt: now.AddMinutes(-5));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath);

        Assert.Equal(1, body.GetProperty("total").GetInt32());
        Assert.Equal(
            DoorTrail.OfflineUnknownScanAction,
            Items(body).Single().GetProperty("action").GetString());
    }

    /// <summary>
    /// A REMOVED door's rows survive the board. The predicate is "not at a board that is not a
    /// door", never "at a board that is a door" — a removed door resolves to no board at all,
    /// and dropping its rows would delete the club's record of the night it was still there.
    /// </summary>
    [SkippableFact]
    public async Task A_removed_doors_scans_survive_the_board()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "b27gone");
        var now = DateTimeOffset.UtcNow;

        // A board this club no longer has: the rows carry its id and nothing resolves it.
        var goneId = Guid.NewGuid();
        await club.WriteRowAsync(
            factory, goneId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-5),
            subjectUserId: club.MemberUserId, gateKey: "old-door", deviceCode: "gate-b270003",
            doorName: "Old side door");
        await club.DeleteRecordAsync(factory, goneId, "gate-b270003", now.AddMinutes(-2));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath);

        Assert.Equal(1, body.GetProperty("total").GetInt32());
        Assert.Equal(
            DeviceGateEndpoint.OpenedAction,
            Items(body).Single().GetProperty("action").GetString());
    }

    /// <summary>
    /// One club's court box cannot silence ANOTHER club's door log.
    ///
    /// <para>
    /// The exclusion is built from <c>db.Devices</c>, which the global query filter scopes to the
    /// caller's tenant. If that filter were ever removed the predicate would carry a foreign
    /// club's board ids, and a guid collision — or a deliberate one — would delete rows from a
    /// log it has no business reaching. Both clubs are in the SAME database here, which is the
    /// only arrangement under which this assertion means anything.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_boards_do_not_reach_this_clubs_log()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var ours = await DoorClub.SeedAsync(factory, "b27ta");
        var theirs = await DoorClub.SeedAsync(factory, "b27tb");

        var ourDoor = await ours.AddDoorAsync(factory, "gate-b270004", "front-door");
        await theirs.AddCourtBoxAsync(factory, "box-b270005");

        var now = DateTimeOffset.UtcNow;
        await ours.WriteRowAsync(
            factory, ourDoor, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-5), gateKey: "front-door");

        var body = await ours.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath);

        Assert.Equal(1, body.GetProperty("total").GetInt32());
    }
}
