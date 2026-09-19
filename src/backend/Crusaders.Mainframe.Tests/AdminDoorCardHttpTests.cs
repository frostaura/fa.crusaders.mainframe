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
/// The door card fields — W1.4.
///
/// <para>
/// <c>location_note</c> and <c>power_loss_behaviour</c> are the two facts about a door that
/// no board can report and no firmware flag implies. Where the door physically is, is a
/// sentence an electrician or a committee member writes down; what the lock does with no
/// power is a property of the lock, measured by somebody standing in front of it with the
/// breaker off. <c>docs/specs/door-gate.md</c> §11 is explicit that software cannot make
/// either true, and <c>memory/watch-doors.md</c> carries the second as an open debt — so the
/// column exists to record an answer a person gives, and it starts at
/// <c>not_established</c> because that is what is true of every door in the field today.
/// </para>
///
/// <para>
/// The third field is not admin-entered at all. <c>shut_by_shut_all_at</c> is what makes
/// "reopen all" mean "undo the shut-all" rather than "open everything", which is the one
/// thing an admin who shut one door individually must be able to rely on.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class AdminDoorCardHttpTests
{
    private readonly PostgresFixture _pg;

    public AdminDoorCardHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static async Task<JsonElement> PatchAsync(HttpClient client, Guid id, string json)
    {
        var res = await client.PatchAsync(
            $"/api/v1/admin/devices/{id}",
            new StringContent(json, System.Text.Encoding.UTF8, "application/json"));
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        return JsonSerializer.SerializeToElement(new { status = (int)res.StatusCode, body });
    }

    private static int Status(JsonElement wrapped) => wrapped.GetProperty("status").GetInt32();
    private static JsonElement Body(JsonElement wrapped) => wrapped.GetProperty("body");

    /// <summary>Every device view carries all three, whatever kind of board it describes.</summary>
    [SkippableFact]
    public async Task A_door_card_starts_empty_and_says_nothing_has_been_established()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "card");
        await club.AddDoorAsync(factory, "gate-aaa001", "front-door");
        var client = club.AdminClient(factory);

        var devices = await client.GetFromJsonAsync<JsonElement>("/api/v1/admin/devices/");
        var door = devices.EnumerateArray().Single();

        Assert.Equal(JsonValueKind.Null, door.GetProperty("location_note").ValueKind);
        Assert.Equal("not_established", door.GetProperty("power_loss_behaviour").GetString());
        Assert.Equal(JsonValueKind.Null, door.GetProperty("out_of_service_since").ValueKind);
    }

    /// <summary>
    /// Both fields are present on a court box too — always present, only meaningful on a
    /// gate. A console typed against one shape does not want two.
    /// </summary>
    [SkippableFact]
    public async Task A_court_box_carries_the_door_fields_and_they_are_empty()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "cardbox");
        await club.AddCourtBoxAsync(factory, "box-aaa001");
        var client = club.AdminClient(factory);

        var devices = await client.GetFromJsonAsync<JsonElement>("/api/v1/admin/devices/");
        var box = devices.EnumerateArray().Single();

        Assert.Equal(JsonValueKind.Null, box.GetProperty("location_note").ValueKind);
        Assert.Equal("not_established", box.GetProperty("power_loss_behaviour").GetString());
    }

    [SkippableTheory]
    [InlineData("location_note")]
    [InlineData("locationNote")]
    public async Task The_location_note_binds_under_either_spelling(string key)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "cardnote");
        var doorId = await club.AddDoorAsync(factory, "gate-aaa002", "front-door");
        var client = club.AdminClient(factory);

        var res = await PatchAsync(client, doorId, $$"""{"{{key}}": "  Reception, left of the desk  "}""");

        Assert.Equal(200, Status(res));
        Assert.Equal("Reception, left of the desk", Body(res).GetProperty("location_note").GetString());
    }

    [SkippableTheory]
    [InlineData("power_loss_behaviour")]
    [InlineData("powerLossBehaviour")]
    public async Task The_power_loss_behaviour_binds_under_either_spelling(string key)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "cardpwr");
        var doorId = await club.AddDoorAsync(factory, "gate-aaa003", "front-door");
        var client = club.AdminClient(factory);

        var res = await PatchAsync(client, doorId, $$"""{"{{key}}": "released"}""");

        Assert.Equal(200, Status(res));
        Assert.Equal("released", Body(res).GetProperty("power_loss_behaviour").GetString());
    }

    /// <summary>Two-valued like <c>gate_key</c>: an empty string clears it, an absent key leaves it alone.</summary>
    [SkippableFact]
    public async Task An_empty_location_note_clears_it_and_an_absent_one_leaves_it()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "cardclear");
        var doorId = await club.AddDoorAsync(factory, "gate-aaa004", "front-door");
        var client = club.AdminClient(factory);

        await PatchAsync(client, doorId, """{"location_note": "Side alley"}""");

        var untouched = await PatchAsync(client, doorId, """{"name": "Side door"}""");
        Assert.Equal("Side alley", Body(untouched).GetProperty("location_note").GetString());

        var cleared = await PatchAsync(client, doorId, """{"location_note": ""}""");
        Assert.Equal(JsonValueKind.Null, Body(cleared).GetProperty("location_note").ValueKind);
    }

    [SkippableFact]
    public async Task A_location_note_longer_than_the_column_is_refused_rather_than_truncated()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "cardlong");
        var doorId = await club.AddDoorAsync(factory, "gate-aaa005", "front-door");
        var client = club.AdminClient(factory);

        var tooLong = new string('x', Device.LocationNoteMaxLength + 1);
        var res = await PatchAsync(client, doorId, $$"""{"location_note": "{{tooLong}}"}""");

        Assert.Equal(400, Status(res));
        Assert.Equal(AdminDeviceEndpoints.LocationNoteTooLong, Body(res).GetProperty("error").GetString());
        Assert.Equal(Device.LocationNoteMaxLength, Body(res).GetProperty("max_length").GetInt32());
    }

    /// <summary>
    /// The closed set is the whole point: an unrecognised value means a console has invented
    /// a fourth answer to a question only a person standing at the lock can answer.
    /// </summary>
    [SkippableTheory]
    [InlineData("\"unlocked\"")]
    [InlineData("\"\"")]
    [InlineData("null")]
    [InlineData("3")]
    public async Task A_power_loss_behaviour_outside_the_closed_set_is_refused(string value)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "cardbad");
        var doorId = await club.AddDoorAsync(factory, "gate-aaa006", "front-door");
        var client = club.AdminClient(factory);

        var res = await PatchAsync(client, doorId, $$"""{"power_loss_behaviour": {{value}}}""");

        Assert.Equal(400, Status(res));
        Assert.Equal(AdminDeviceEndpoints.PowerLossBehaviourInvalid, Body(res).GetProperty("error").GetString());
    }

    /// <summary>
    /// The mirror of <c>court_fields_on_a_gate</c>. Refused rather than dropped, for the
    /// reason that refusal already records: a PATCH that reports success while changing
    /// nothing leaves the admin believing something was saved.
    /// </summary>
    [SkippableTheory]
    [InlineData("""{"location_note": "By the fire exit"}""")]
    [InlineData("""{"locationNote": "By the fire exit"}""")]
    [InlineData("""{"power_loss_behaviour": "locked"}""")]
    [InlineData("""{"powerLossBehaviour": "locked"}""")]
    public async Task The_door_card_fields_are_refused_on_a_court_box(string json)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "cardrefuse");
        var boxId = await club.AddCourtBoxAsync(factory, "box-aaa002");
        var client = club.AdminClient(factory);

        var res = await PatchAsync(client, boxId, json);

        Assert.Equal(400, Status(res));
        Assert.Equal(AdminDeviceEndpoints.DoorFieldsOnACourtBox, Body(res).GetProperty("error").GetString());
    }

    /// <summary>The refusal must not be a way to change the row it refuses.</summary>
    [SkippableFact]
    public async Task A_refused_door_card_patch_writes_nothing()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "cardnowrite");
        var boxId = await club.AddCourtBoxAsync(factory, "box-aaa003");
        var client = club.AdminClient(factory);

        await PatchAsync(client, boxId, """{"name": "Main box", "location_note": "By the fire exit"}""");

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var box = await db.Devices.IgnoreQueryFilters().FirstAsync(d => d.Id == boxId);
        Assert.Equal("Court box", box.Name);
        Assert.Null(box.LocationNote);
    }

    /// <summary>
    /// The column the schema really has, not the one the model claims — a migration that was
    /// never applied reads identically to one that was, until a second machine runs it.
    /// </summary>
    [SkippableFact]
    public async Task The_three_columns_exist_in_the_migrated_schema()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        await DoorClub.SeedAsync(factory, "cardschema");

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var conn = db.Database.GetDbConnection();
        await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText =
            """
            select column_name from information_schema.columns
            where table_name = 'devices'
              and column_name in ('LocationNote', 'PowerLossBehaviour', 'ShutByShutAllAt')
            order by column_name
            """;
        var found = new List<string>();
        await using (var reader = await cmd.ExecuteReaderAsync())
        {
            while (await reader.ReadAsync()) found.Add(reader.GetString(0));
        }

        Assert.Equal(["LocationNote", "PowerLossBehaviour", "ShutByShutAllAt"], found);
    }

    /// <summary>
    /// Out of service is already recorded on the row; the console had no way to read it, so
    /// "you shut this on Tuesday at 19:40" could not be said.
    /// </summary>
    [SkippableFact]
    public async Task Shutting_a_door_surfaces_the_instant_on_the_device_view()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "cardoos");
        var doorId = await club.AddDoorAsync(factory, "gate-aaa007", "front-door");
        var client = club.AdminClient(factory);

        var shut = await PatchAsync(client, doorId, """{"enabled": false}""");
        Assert.Equal(JsonValueKind.String, Body(shut).GetProperty("out_of_service_since").ValueKind);

        var reopened = await PatchAsync(client, doorId, """{"enabled": true}""");
        Assert.Equal(JsonValueKind.Null, Body(reopened).GetProperty("out_of_service_since").ValueKind);
    }

    /// <summary>Another club's board is not this club's to card.</summary>
    [SkippableFact]
    public async Task Another_clubs_door_cannot_be_carded_from_here()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(factory, "cardmine");
        var theirs = await DoorClub.SeedAsync(factory, "cardtheirs");
        var theirDoor = await theirs.AddDoorAsync(factory, "gate-aaa008", "their-door");

        var client = mine.AdminClient(factory);
        var res = await client.PatchAsync(
            $"/api/v1/admin/devices/{theirDoor}",
            new StringContent("""{"location_note": "Mine now"}""", System.Text.Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var door = await db.Devices.IgnoreQueryFilters().FirstAsync(d => d.Id == theirDoor);
        Assert.Null(door.LocationNote);
    }
}
