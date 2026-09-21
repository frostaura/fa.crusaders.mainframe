using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A1 / A2 / E-C1 / E-M1 / C1 — what a deleted door leaves behind.
///
/// <para>
/// <b>Round two's one critical, found independently by three reviewers driving three different
/// screens.</b> A row whose board had been deleted answered <c>door: null</c>; the log page read
/// <c>.id</c> off it and <c>/admin/doors/log</c> went white for every admin in the club. One
/// reviewer got there by deleting a door and following a link, one by pressing "Load older
/// scans" until the cursor reached the removed door's rows, and one through the outcome filter.
/// The rows were never wrong — what was missing was a way to say "this door is gone" that a
/// renderer could not read as "this row has no door".
/// </para>
///
/// <para>
/// <b>And a second, quieter half: the club believed the history was destroyed.</b> The delete
/// confirmation said only that the door's name, location and power answer would go, and after
/// the delete the door's page 404'd, it was absent from the log's filter and its counts were
/// gone — so the reasonable conclusion was that a night's scans had been deleted with it.
/// Nothing of the sort happened: <c>audit_log</c> has no foreign key to <c>devices</c>, and
/// every row survives until the club's own retention sweep. The last test here is the one that
/// proves it on all four surfaces at once, because the confirmation is now entitled to promise
/// it.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DoorRemovedHttpTests
{
    private readonly PostgresFixture _pg;

    public DoorRemovedHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string LogPath = "/api/v1/admin/doors/activity";
    private const string CsvPath = "/api/v1/admin/doors/activity.csv";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static List<JsonElement> Items(JsonElement body) => body.GetProperty("items").EnumerateArray().ToList();

    /// <summary>
    /// The shape itself: every row carries a door object, and the one whose board is gone says
    /// <c>removed: true</c> with what the row recorded rather than a null the page dereferences.
    /// </summary>
    [SkippableFact]
    public async Task Every_log_row_names_a_door_and_a_removed_one_says_so_rather_than_being_null()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "rmdoor1");
        var live = await club.AddDoorAsync(factory, "gate-rm0001", "front-door", name: "Front door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(
            factory, live, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-1),
            subjectUserId: club.MemberUserId, reason: GateAccess.Ok, gateKey: "front-door");

        // A board that was deleted since: the row is exactly what the writers now put on it.
        var gone = Guid.NewGuid();
        await club.WriteRowAsync(
            factory, gone, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-2),
            subjectUserId: club.MemberUserId, reason: GateAccess.Ok,
            gateKey: "side-door", doorName: "Side door", deviceCode: "gate-rm0002");

        var items = Items(await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath));
        Assert.Equal(2, items.Count);

        var alive = items[0].GetProperty("door");
        Assert.Equal(live, alive.GetProperty("id").GetGuid());
        Assert.Equal("Front door", alive.GetProperty("name").GetString());
        Assert.Equal("front-door", alive.GetProperty("gate_key").GetString());
        Assert.False(alive.GetProperty("removed").GetBoolean());

        var removed = items[1].GetProperty("door");
        Assert.Equal(JsonValueKind.Object, removed.ValueKind);
        Assert.Equal(JsonValueKind.Null, removed.GetProperty("id").ValueKind);
        Assert.Equal("Side door", removed.GetProperty("name").GetString());
        Assert.Equal("side-door", removed.GetProperty("gate_key").GetString());
        Assert.True(removed.GetProperty("removed").GetBoolean());
    }

    /// <summary>
    /// A row from before the display name was stored still names its board — by the device code,
    /// which is what an admin reads off the board's own label and is the string A11 asks the
    /// console to show. Never an empty object, which is the shape that started this.
    /// </summary>
    [SkippableFact]
    public async Task An_old_row_from_a_removed_board_falls_back_to_the_code_the_board_announced()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "rmdoor2");
        var gone = Guid.NewGuid();

        await club.WriteRowAsync(
            factory, gone, DoorTrail.OfflineUnknownScanAction, DateTimeOffset.UtcNow.AddMinutes(-3),
            seq: 7, gateKey: null, deviceCode: "gate-44c103");

        var door = Items(await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath))
            .Single().GetProperty("door");

        Assert.True(door.GetProperty("removed").GetBoolean());
        Assert.Equal("gate-44c103", door.GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.Null, door.GetProperty("gate_key").ValueKind);
    }

    /// <summary>
    /// A2: the log offers every removed door that still has rows it can answer for, keyed by the
    /// id the rows themselves stored, and filtering by that key narrows to exactly those rows.
    /// </summary>
    [SkippableFact]
    public async Task A_removed_door_with_rows_in_range_is_offered_as_a_filter_and_narrows_to_its_own_rows()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "rmdoor3");
        var live = await club.AddDoorAsync(factory, "gate-rm0003", "front-door", name: "Front door");
        var gone = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(factory, live, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-1), reason: GateAccess.Ok);
        await club.WriteRowAsync(
            factory, gone, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-2),
            reason: GateAccess.Ok, gateKey: "side-door", doorName: "Side door");
        await club.WriteRowAsync(
            factory, gone, DoorTrail.OfflineUnknownScanAction, now.AddMinutes(-3),
            seq: 1, gateKey: "side-door", doorName: "Side door");
        await club.DeleteRecordAsync(factory, gone, "gate-rm0004", now.AddMinutes(-1));

        var client = club.AdminClient(factory);
        var body = await client.GetFromJsonAsync<JsonElement>(LogPath);

        var offered = body.GetProperty("removed_doors").EnumerateArray().Single();
        Assert.Equal(gone.ToString(), offered.GetProperty("key").GetString());
        Assert.Equal("Side door", offered.GetProperty("name").GetString());
        Assert.Equal("side-door", offered.GetProperty("gate_key").GetString());

        var filtered = await client.GetFromJsonAsync<JsonElement>(
            $"{LogPath}?{DoorLogQuery.RemovedDoorParameter}={gone}");

        Assert.Equal(2, filtered.GetProperty("total").GetInt32());
        Assert.All(Items(filtered), i => Assert.True(i.GetProperty("door").GetProperty("removed").GetBoolean()));
    }

    /// <summary>
    /// A board whose row is still there is not a removed door, however many delete rows the
    /// trail happens to carry — the state of the club NOW decides, not the history.
    /// </summary>
    [SkippableFact]
    public async Task A_board_that_is_still_in_the_devices_table_is_not_a_removed_door()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "rmdoor4");
        var live = await club.AddDoorAsync(factory, "gate-rm0005", "front-door", name: "Front door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(factory, live, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-1), reason: GateAccess.Ok);
        await club.DeleteRecordAsync(factory, live, "gate-rm0005", now.AddSeconds(-30));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath);

        Assert.Empty(body.GetProperty("removed_doors").EnumerateArray());
        Assert.False(Items(body).Single().GetProperty("door").GetProperty("removed").GetBoolean());
    }

    /// <summary>
    /// E-M1: the export's two door columns are filled from the same stored values, so a removed
    /// door's rows are still named in the file an admin prints for a committee.
    /// </summary>
    [SkippableFact]
    public async Task The_export_names_a_removed_door_from_what_the_row_stored()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "rmdoor5");
        var gone = Guid.NewGuid();

        await club.WriteRowAsync(
            factory, gone, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddMinutes(-2),
            subjectUserId: club.MemberUserId, reason: GateAccess.Ok,
            gateKey: "side-door", doorName: "Side door");

        var csv = await (await club.AdminClient(factory).GetAsync(CsvPath)).Content.ReadAsStringAsync();
        var row = csv.Split("\r\n")[1].Split(',');

        Assert.Equal("side-door", row[4]);
        Assert.Equal("Side door", row[5]);
    }

    /// <summary>
    /// <b>Deleting a door destroys no scan rows, on every surface at once.</b>
    ///
    /// <para>
    /// This is the test the delete confirmation's new sentence rests on — "its past scans stay
    /// in the club log under its old name until the club's N-day rule deletes them" — and it is
    /// deliberately written across all four readers rather than as four assertions about one.
    /// A2's complaint was not that the rows had gone; it was that every single way of asking
    /// for them answered as though they had.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Deleting_a_door_destroys_no_scan_rows_on_the_log_the_export_the_counts_or_a_members_history()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "rmdoor6");
        var doorId = await club.AddDoorAsync(factory, "gate-rm0006", "side-door", name: "Side door");
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < 4; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-(i + 1)),
                subjectUserId: club.MemberUserId, reason: GateAccess.Ok,
                gateKey: "side-door", doorName: "Side door");
        }

        var admin = club.AdminClient(factory);
        var member = club.ClientFor(factory, club.MemberUserId, null);

        var before = await admin.GetFromJsonAsync<JsonElement>(LogPath);
        var beforeCsv = await (await admin.GetAsync(CsvPath)).Content.ReadAsStringAsync();
        var beforeHistory = Items(await member.GetFromJsonAsync<JsonElement>("/api/v1/me/door/history"));

        Assert.Equal(4, before.GetProperty("total").GetInt32());

        var deleted = await admin.DeleteAsync($"/api/v1/admin/devices/{doorId}");
        Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);

        // 1. the log: same rows, same count, all of them naming the door it used to be.
        var after = await admin.GetFromJsonAsync<JsonElement>(LogPath);
        Assert.Equal(4, after.GetProperty("total").GetInt32());
        Assert.Equal(4, Items(after).Count);
        Assert.All(Items(after), i =>
        {
            var door = i.GetProperty("door");
            Assert.True(door.GetProperty("removed").GetBoolean());
            Assert.Equal("Side door", door.GetProperty("name").GetString());
        });

        // 2. the CSV: the same number of data rows, still named.
        var afterCsv = await (await admin.GetAsync(CsvPath)).Content.ReadAsStringAsync();
        Assert.Equal(beforeCsv.Split("\r\n").Length, afterCsv.Split("\r\n").Length);
        Assert.Contains("Side door", afterCsv);

        // 3. the filter: the door is offered under the key its rows carry, so they are reachable
        //    rather than merely present.
        var offered = after.GetProperty("removed_doors").EnumerateArray().Single();
        Assert.Equal(doorId.ToString(), offered.GetProperty("key").GetString());

        // 4. the member's own history: unchanged in length, and still naming the door.
        var afterHistory = Items(await member.GetFromJsonAsync<JsonElement>("/api/v1/me/door/history"));
        Assert.Equal(beforeHistory.Count, afterHistory.Count);
        Assert.Equal("Side door", afterHistory[0].GetProperty("door_name").GetString());
    }

    /// <summary>
    /// Another club's deleted door is not this club's removed door, and its rows are not in this
    /// club's total — both halves, because the removed-door lookup reads <c>audit_log</c> twice
    /// by a jsonb containment and a guid inside a jsonb document proves nothing about whose
    /// board it is.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_removed_door_never_reaches_this_clubs_filter_or_its_total()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(factory, "rmdoormine");
        var theirs = await DoorClub.SeedAsync(factory, "rmdoorthrs");
        var now = DateTimeOffset.UtcNow;

        var theirGone = Guid.NewGuid();
        await theirs.WriteRowAsync(
            factory, theirGone, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-2),
            reason: GateAccess.Ok, gateKey: "their-door", doorName: "Their door");
        await theirs.DeleteRecordAsync(factory, theirGone, "gate-thrs01", now.AddMinutes(-1));

        var body = await mine.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath);

        Assert.Empty(body.GetProperty("removed_doors").EnumerateArray());
        Assert.Equal(0, body.GetProperty("total").GetInt32());

        // And naming their door id explicitly answers nothing rather than their rows — which
        // since R3-13 is a NAMED refusal rather than an empty page. The refusal is the stronger
        // isolation statement of the two: it is the identical answer an invented guid gets
        // (asserted here, in the same request shape, so the two cannot drift apart), so it
        // carries no information about whether their board exists.
        var probed = await mine.AdminClient(factory).GetAsync(
            $"{LogPath}?{DoorLogQuery.RemovedDoorParameter}={theirGone}");
        var invented = await mine.AdminClient(factory).GetAsync(
            $"{LogPath}?{DoorLogQuery.RemovedDoorParameter}={Guid.NewGuid()}");

        Assert.Equal(System.Net.HttpStatusCode.BadRequest, probed.StatusCode);
        Assert.Equal(
            await invented.Content.ReadAsStringAsync(), await probed.Content.ReadAsStringAsync());
        Assert.Equal(
            $"{{\"error\":\"{DoorLogQuery.DoorNotFound}\"}}", await probed.Content.ReadAsStringAsync());
    }
}
