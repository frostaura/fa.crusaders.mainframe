using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A4 / S1 / D7 — when an offline scan happened, when the club heard about it, and which door
/// it was.
///
/// <para>
/// <b>An offline row has two instants and the wire carried one.</b> The row is written when the
/// board next calls in, so <c>at</c> — the audit row's own <c>CreatedAt</c> — was the DELIVERY
/// instant, while <c>details.occurred_at</c> held the scan. W1.2 says offline opens are
/// scan-time stamped, and a club reading "06:40" as "09:00" is not a cosmetic difference: it is
/// the answer to "when did somebody come through the side door". <c>at</c> is now the scan and
/// <c>delivered_at</c> is when it arrived, on every offline row and on no other.
/// </para>
///
/// <para>
/// <b>And the door's name was lost with it.</b> The offline upload path writes the board's
/// <c>device_code</c> and never wrote <c>gate_key</c>, so a member's own history showed six
/// releases at a null door — at a door the club had named — and the member's page said the
/// club had not named it. The name is resolved by <c>device_id</c> at READ time, the way the
/// admin log has always done it, and the stored key is the fallback for a board that has since
/// been deleted.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DoorScanTimeHttpTests
{
    private readonly PostgresFixture _pg;

    public DoorScanTimeHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static List<JsonElement> Items(JsonElement body) => body.GetProperty("items").EnumerateArray().ToList();

    /// <summary>
    /// The scan happened two hours before the board could say so. Every surface stamps the
    /// scan and names the delivery; neither is guessed from the other.
    /// </summary>
    [SkippableFact]
    public async Task An_offline_row_is_stamped_with_the_scan_and_names_its_delivery()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "scantime1");
        var doorId = await club.AddDoorAsync(factory, "gate-st0001", "side-door", name: "Side door");

        var delivered = DateTimeOffset.UtcNow.AddMinutes(-5);
        var scanned = delivered.AddHours(-2);

        await club.WriteRowAsync(
            factory, doorId, DoorTrail.OfflineOpenAction, delivered,
            subjectUserId: club.MemberUserId, seq: 1, occurredAt: scanned);

        var admin = club.AdminClient(factory);

        foreach (var body in new[]
                 {
                     await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/devices/{doorId}/activity"),
                     await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/doors/activity"),
                 })
        {
            var row = Items(body).Single();
            Assert.Equal(scanned.ToUniversalTime(), row.GetProperty("at").GetDateTimeOffset().ToUniversalTime(), TimeSpan.FromSeconds(1));
            Assert.Equal(
                delivered.ToUniversalTime(),
                row.GetProperty("delivered_at").GetDateTimeOffset().ToUniversalTime(), TimeSpan.FromSeconds(1));
        }

        var history = await club.ClientFor(factory, club.MemberUserId, null)
            .GetFromJsonAsync<JsonElement>("/api/v1/me/door/history");
        var mine = Items(history).Single();
        Assert.Equal(scanned.ToUniversalTime(), mine.GetProperty("at").GetDateTimeOffset().ToUniversalTime(), TimeSpan.FromSeconds(1));
        Assert.Equal(
            delivered.ToUniversalTime(),
            mine.GetProperty("delivered_at").GetDateTimeOffset().ToUniversalTime(), TimeSpan.FromSeconds(1));
    }

    /// <summary>
    /// An online decision was made the moment it was recorded, so there is nothing to deliver
    /// and the field is null rather than a copy of <c>at</c>. A page that saw a value there
    /// would tell a member their scan was delivered late when it was not.
    /// </summary>
    [SkippableFact]
    public async Task An_online_row_has_nothing_to_deliver()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "scantime2");
        var doorId = await club.AddDoorAsync(factory, "gate-st0002", "front-door");
        var at = DateTimeOffset.UtcNow.AddMinutes(-3);

        await club.WriteRowAsync(
            factory, doorId, Api.Endpoints.DeviceGateEndpoint.OpenedAction, at,
            subjectUserId: club.MemberUserId, gateKey: "front-door");

        var row = Items(await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>("/api/v1/admin/doors/activity")).Single();

        Assert.Equal(at.ToUniversalTime(), row.GetProperty("at").GetDateTimeOffset().ToUniversalTime(), TimeSpan.FromSeconds(1));
        Assert.Equal(JsonValueKind.Null, row.GetProperty("delivered_at").ValueKind);
    }

    /// <summary>
    /// S1 / D7: the offline row stored no <c>gate_key</c>, and the member's own screens said the
    /// club had not named the door. The door is resolved by its id, at read time.
    /// </summary>
    [SkippableFact]
    public async Task A_members_own_rows_name_the_door_even_when_the_row_did_not()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "scantime3");
        var doorId = await club.AddDoorAsync(factory, "gate-st0003", "side-door", name: "Side door");
        var now = DateTimeOffset.UtcNow;

        // Exactly as the upload path wrote it before this change: no gate_key anywhere on it.
        await club.WriteRowAsync(
            factory, doorId, DoorTrail.OfflineOpenAction, now.AddSeconds(-30),
            subjectUserId: club.MemberUserId, seq: 1, gateKey: null);

        var member = club.ClientFor(factory, club.MemberUserId, null);

        var history = await member.GetFromJsonAsync<JsonElement>("/api/v1/me/door/history");
        Assert.Equal("side-door", Items(history).Single().GetProperty("door_name").GetString());

        var door = await member.GetFromJsonAsync<JsonElement>("/api/v1/me/door");
        Assert.Equal("side-door", door.GetProperty("last_decision").GetProperty("door_name").GetString());
    }

    /// <summary>
    /// A board deleted since the scan cannot be resolved, so the key the row stored is what is
    /// left — and null is the honest answer when there is neither. A history row never vanishes
    /// because its door did.
    /// </summary>
    [SkippableFact]
    public async Task A_deleted_board_falls_back_to_the_key_the_row_stored()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "scantime4");
        var gone = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(
            factory, gone, DoorTrail.OfflineOpenAction, now.AddMinutes(-2),
            subjectUserId: club.MemberUserId, seq: 1, gateKey: "old-door");
        await club.WriteRowAsync(
            factory, gone, DoorTrail.OfflineOpenAction, now.AddMinutes(-3),
            subjectUserId: club.MemberUserId, seq: 2, gateKey: null);

        var items = Items(await club.ClientFor(factory, club.MemberUserId, null)
            .GetFromJsonAsync<JsonElement>("/api/v1/me/door/history"));

        Assert.Equal(2, items.Count);
        Assert.Equal("old-door", items[0].GetProperty("door_name").GetString());
        Assert.Equal(JsonValueKind.Null, items[1].GetProperty("door_name").ValueKind);
    }

    /// <summary>
    /// The club log stamps the scan too, and still PAGES by when the club heard about it —
    /// which is what keeps the keyset cursor total over an append-only table. The two are
    /// different axes and the response says both, so nothing has to infer one from the other.
    /// </summary>
    [SkippableFact]
    public async Task The_log_is_stamped_by_the_scan_and_ordered_by_the_delivery()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "scantime5");
        var doorId = await club.AddDoorAsync(factory, "gate-st0005", "cellar-door");
        var now = DateTimeOffset.UtcNow;

        // Delivered newest-last, scanned newest-first: order by one and the list reverses.
        await club.WriteRowAsync(
            factory, doorId, DoorTrail.OfflineOpenAction, now.AddMinutes(-20), seq: 1,
            occurredAt: now.AddMinutes(-1));
        await club.WriteRowAsync(
            factory, doorId, DoorTrail.OfflineOpenAction, now.AddMinutes(-10), seq: 2,
            occurredAt: now.AddMinutes(-2));

        var items = Items(await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>("/api/v1/admin/doors/activity"));

        Assert.Equal(2, items.Count);
        Assert.True(
            items[0].GetProperty("delivered_at").GetDateTimeOffset()
            > items[1].GetProperty("delivered_at").GetDateTimeOffset());
        Assert.True(
            items[0].GetProperty("at").GetDateTimeOffset() < items[1].GetProperty("at").GetDateTimeOffset());
    }
}
