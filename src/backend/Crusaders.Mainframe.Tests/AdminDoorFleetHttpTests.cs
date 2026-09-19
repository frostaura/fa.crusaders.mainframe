using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// W1.5 — shut all doors, and reopen the ones this feature shut.
///
/// <para>
/// <b>The test that carries the most weight is
/// <see cref="Reopen_all_leaves_a_door_an_admin_shut_individually_shut"/>.</b> An admin shuts
/// one door for a reason this system knows nothing about — a broken scanner, a lock being
/// replaced, a wing closed for the season — and a fleet reopen that silently reversed that
/// decision would be the product overruling a person, at a door, with nothing anywhere saying
/// it had.
/// </para>
///
/// <para>
/// The second is <see cref="A_fleet_shut_writes_exactly_one_audit_row"/>. The console's
/// sentence "nothing was shut, and it is one all-or-nothing change, so every door is exactly
/// as it was" is only true because this is one unit of work; N PATCHes, which was the only way
/// before this route, left a club half-shut on a failure with nothing saying which half.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class AdminDoorFleetHttpTests
{
    private readonly PostgresFixture _pg;

    public AdminDoorFleetHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string ShutAll = "/api/v1/admin/doors/shut-all";
    private const string ReopenAll = "/api/v1/admin/doors/reopen-all";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static List<JsonElement> Doors(JsonElement body) => body.GetProperty("doors").EnumerateArray().ToList();

    private static async Task<JsonElement> PostAsync(HttpClient client, string path)
        => await (await client.PostAsync(path, null)).Content.ReadFromJsonAsync<JsonElement>();

    private static async Task<Device> RowAsync(TestWebAppFactory factory, Guid id)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.Devices.IgnoreQueryFilters().AsNoTracking().FirstAsync(d => d.Id == id);
    }

    [SkippableFact]
    public async Task A_fleet_shut_shuts_every_open_door_and_stamps_the_instant()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "fleetshut");
        var front = await club.AddDoorAsync(factory, "gate-fl0001", "front-door", name: "A front");
        var side = await club.AddDoorAsync(factory, "gate-fl0002", "side-door", name: "B side");

        var body = await PostAsync(club.AdminClient(factory), ShutAll);

        Assert.Equal(2, Doors(body).Count);
        Assert.All(Doors(body), d => Assert.False(d.GetProperty("enabled").GetBoolean()));

        foreach (var id in new[] { front, side })
        {
            var row = await RowAsync(factory, id);
            Assert.False(row.Enabled);
            Assert.NotNull(row.OutOfServiceSince);
            Assert.NotNull(row.ShutByShutAllAt);
        }
    }

    /// <summary>A court box is not a door and a fleet shut must not darken a court.</summary>
    [SkippableFact]
    public async Task A_fleet_shut_does_not_touch_a_court_box()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "fleetbox");
        await club.AddDoorAsync(factory, "gate-fl0003", "front-door");
        var boxId = await club.AddCourtBoxAsync(factory, "box-fl0001");

        var body = await PostAsync(club.AdminClient(factory), ShutAll);

        Assert.Single(Doors(body));
        var box = await RowAsync(factory, boxId);
        Assert.True(box.Enabled);
        Assert.Null(box.OutOfServiceSince);
    }

    /// <summary>
    /// The result panel is a receipt for an instant, so every door it names carries the two
    /// facts that decide whether that door has HEARD about the change yet.
    /// </summary>
    [SkippableFact]
    public async Task Each_door_in_the_result_carries_what_the_confirmation_needs()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "fleetwire");
        var seen = DateTimeOffset.UtcNow.AddSeconds(-12);
        var id = await club.AddDoorAsync(factory, "gate-fl0004", "front-door", name: "Front", lastSeenAt: seen);

        var door = Doors(await PostAsync(club.AdminClient(factory), ShutAll)).Single();

        Assert.Equal(id, door.GetProperty("id").GetGuid());
        Assert.Equal("Front", door.GetProperty("name").GetString());
        Assert.Equal("front-door", door.GetProperty("gate_key").GetString());
        Assert.False(door.GetProperty("enabled").GetBoolean());
        Assert.Equal(seen, door.GetProperty("last_seen_at").GetDateTimeOffset(), TimeSpan.FromSeconds(1));
        Assert.True(door.GetProperty("offline_after_seconds").GetInt32() > 0);
        Assert.Equal("not_established", door.GetProperty("power_loss_behaviour").GetString());
    }

    /// <summary>A door that has never called in is a door nothing is known about, and it is still shut.</summary>
    [SkippableFact]
    public async Task A_door_that_has_never_called_in_is_still_shut_and_carries_a_null_last_seen()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "fleetnever");
        await club.AddDoorAsync(factory, "gate-fl0005", gateKey: null, lastSeenAt: null);

        var door = Doors(await PostAsync(club.AdminClient(factory), ShutAll)).Single();

        Assert.Equal(JsonValueKind.Null, door.GetProperty("last_seen_at").ValueKind);
        Assert.False(door.GetProperty("enabled").GetBoolean());
    }

    [SkippableFact]
    public async Task A_reopen_all_reopens_every_door_the_fleet_shut()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "fleetreopen");
        var front = await club.AddDoorAsync(factory, "gate-fl0006", "front-door", name: "A front");
        var side = await club.AddDoorAsync(factory, "gate-fl0007", "side-door", name: "B side");
        var client = club.AdminClient(factory);

        await PostAsync(client, ShutAll);
        var body = await PostAsync(client, ReopenAll);

        Assert.Equal(2, Doors(body).Count);
        Assert.All(Doors(body), d => Assert.True(d.GetProperty("enabled").GetBoolean()));

        foreach (var id in new[] { front, side })
        {
            var row = await RowAsync(factory, id);
            Assert.True(row.Enabled);
            Assert.Null(row.OutOfServiceSince);
            Assert.Null(row.ShutByShutAllAt);
        }
    }

    /// <summary>The rule this whole column exists for.</summary>
    [SkippableFact]
    public async Task Reopen_all_leaves_a_door_an_admin_shut_individually_shut()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "fleetkeep");
        var broken = await club.AddDoorAsync(factory, "gate-fl0008", "side-door", name: "A side");
        var front = await club.AddDoorAsync(factory, "gate-fl0009", "front-door", name: "B front");
        var client = club.AdminClient(factory);

        // The side door's scanner is broken and an admin has taken it out of service.
        await client.PatchAsync(
            $"/api/v1/admin/devices/{broken}",
            new StringContent("""{"enabled": false}""", System.Text.Encoding.UTF8, "application/json"));

        await PostAsync(client, ShutAll);
        var reopened = await PostAsync(client, ReopenAll);

        // Only the front door was shut BY the shut-all, so only the front door comes back.
        Assert.Equal([front], Doors(reopened).Select(d => d.GetProperty("id").GetGuid()).ToList());
        Assert.False((await RowAsync(factory, broken)).Enabled);
        Assert.True((await RowAsync(factory, front)).Enabled);
    }

    /// <summary>
    /// A door reopened one at a time is no longer shut by a shut-all, so the next fleet reopen
    /// must not claim to have reopened it.
    /// </summary>
    [SkippableFact]
    public async Task Reopening_one_door_by_hand_takes_it_out_of_the_fleet_reopen()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "fleethand");
        var front = await club.AddDoorAsync(factory, "gate-fl0010", "front-door", name: "A front");
        var side = await club.AddDoorAsync(factory, "gate-fl0011", "side-door", name: "B side");
        var client = club.AdminClient(factory);

        await PostAsync(client, ShutAll);
        await client.PatchAsync(
            $"/api/v1/admin/devices/{front}",
            new StringContent("""{"enabled": true}""", System.Text.Encoding.UTF8, "application/json"));

        Assert.Null((await RowAsync(factory, front)).ShutByShutAllAt);

        var reopened = await PostAsync(client, ReopenAll);
        Assert.Equal([side], Doors(reopened).Select(d => d.GetProperty("id").GetGuid()).ToList());
    }

    /// <summary>A door already out of service is left exactly as it was, instant included.</summary>
    [SkippableFact]
    public async Task A_fleet_shut_does_not_re_stamp_a_door_that_is_already_shut()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "fleetidem");
        var doorId = await club.AddDoorAsync(factory, "gate-fl0012", "front-door");
        var client = club.AdminClient(factory);

        await client.PatchAsync(
            $"/api/v1/admin/devices/{doorId}",
            new StringContent("""{"enabled": false}""", System.Text.Encoding.UTF8, "application/json"));
        var before = (await RowAsync(factory, doorId)).OutOfServiceSince;

        var body = await PostAsync(client, ShutAll);

        Assert.Empty(Doors(body));
        Assert.Equal(before, (await RowAsync(factory, doorId)).OutOfServiceSince);
    }

    [SkippableFact]
    public async Task A_fleet_shut_writes_exactly_one_audit_row()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "fleetaudit");
        await club.AddDoorAsync(factory, "gate-fl0013", "front-door", name: "A front");
        await club.AddDoorAsync(factory, "gate-fl0014", "side-door", name: "B side");
        await club.AddDoorAsync(factory, "gate-fl0015", "back-door", name: "C back");
        var client = club.AdminClient(factory);

        await PostAsync(client, ShutAll);
        await PostAsync(client, ReopenAll);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var shut = await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == AdminDoorFleetEndpoint.ShutAllAction)
            .SingleAsync();
        var reopened = await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == AdminDoorFleetEndpoint.ReopenedAllAction)
            .SingleAsync();

        Assert.Equal(club.AdminUserId, shut.ActorUserId);

        // P4: a door action is about doors. Naming a member here would be the first place this
        // surface kept a per-member record of an admin's decision.
        Assert.Null(shut.SubjectUserId);
        Assert.Null(reopened.SubjectUserId);

        using var details = JsonDocument.Parse(shut.DetailsJson!);
        Assert.Equal(3, details.RootElement.GetProperty("doors").GetInt32());
    }

    /// <summary>A club with no doors is not a state this control has an opinion about.</summary>
    [SkippableFact]
    public async Task A_club_with_no_doors_is_answered_with_an_empty_list_rather_than_an_error()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "fleetnone");

        var body = await PostAsync(club.AdminClient(factory), ShutAll);
        Assert.Empty(Doors(body));
    }

    [SkippableFact]
    public async Task A_fleet_shut_never_reaches_another_clubs_doors()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(factory, "fleetmine");
        var theirs = await DoorClub.SeedAsync(factory, "fleettheirs");
        await mine.AddDoorAsync(factory, "gate-fl0016", "mine");
        var theirDoor = await theirs.AddDoorAsync(factory, "gate-fl0017", "theirs");

        await PostAsync(mine.AdminClient(factory), ShutAll);

        var theirRow = await RowAsync(factory, theirDoor);
        Assert.True(theirRow.Enabled);
        Assert.Null(theirRow.ShutByShutAllAt);
    }

    [SkippableFact]
    public async Task A_member_cannot_shut_the_clubs_doors()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "fleetmember");
        await club.AddDoorAsync(factory, "gate-fl0018", "front-door");

        var client = club.MemberClient(factory);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsync(ShutAll, null)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsync(ReopenAll, null)).StatusCode);
    }

    /// <summary>
    /// The 403-means-out-of-service invariant, end to end. A shut-all is the 403 path at fleet
    /// scale and must add no new refusal to <c>/api/v1/device/*</c>.
    /// </summary>
    [SkippableFact]
    public async Task A_door_shut_by_the_fleet_is_refused_403_on_its_own_device_routes()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "fleet403");

        // Registered by the board itself, so the MAC on the wire is the MAC on the row.
        var mac = Guid.NewGuid().ToString("N")[..12];
        var device = factory.CreateClient();
        device.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", club.DeviceKey);
        var heartbeat = $$"""{"mac":"{{mac}}","firmware_version":"1.0.0","uptime_ms":60000,"kind":"gate"}""";

        var before = await device.PostAsync(
            "/api/v1/device/heartbeat", new StringContent(heartbeat, System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, before.StatusCode);

        await PostAsync(club.AdminClient(factory), ShutAll);

        var after = await device.PostAsync(
            "/api/v1/device/heartbeat", new StringContent(heartbeat, System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.Forbidden, after.StatusCode);

        await PostAsync(club.AdminClient(factory), ReopenAll);

        var reopened = await device.PostAsync(
            "/api/v1/device/heartbeat", new StringContent(heartbeat, System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, reopened.StatusCode);
    }
}
