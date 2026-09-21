using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A5 / E-M6 / B10 — who changed this door, and what they changed.
///
/// <para>
/// <b>"You shut this door." was shown to every admin in the club.</b> The console had the
/// instant and nothing else, so it addressed whoever was reading as the person who had done it
/// — to a committee of six, five of whom had not. And the door's own feed said
/// <c>kind: "edited"</c> for a rename, a location note, a shut and a reopen alike, so nine rows
/// of "details or state were changed" were the whole of a door's story and the one row somebody
/// was looking for was indistinguishable from eight that did not matter.
/// </para>
///
/// <para>
/// <b>B10 is the same missing fact from the other side.</b> A tab left open while another admin
/// shut the door offered "Shut this door", sent it, and was answered 200 with a row that looked
/// like a success — so two admins each believed they had shut it and neither was told the other
/// had. <c>unchanged: true</c> plus <c>shut_by_name</c> is exactly what "it was already shut —
/// by Priya Naidoo at 21:48" needs.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DoorEventChangeHttpTests
{
    private readonly PostgresFixture _pg;

    public DoorEventChangeHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static List<JsonElement> Events(JsonElement body) => body.GetProperty("events").EnumerateArray().ToList();

    /// <summary>
    /// A5: four different edits, four different words — and the admin's name on every one of
    /// them, because this is the club's own admin audit and not member tracking.
    /// </summary>
    [SkippableFact]
    public async Task Each_kind_of_edit_says_which_one_it_was_and_who_made_it()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "chg1");
        var doorId = await club.AddDoorAsync(factory, "gate-ch0001", "front-door", name: "Front door");
        var admin = club.AdminClient(factory);

        // The first PATCH also acknowledges the row, so it is never `unchanged` — see
        // DeviceRegistryService.UpdateAsync.
        await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { gate_key = "side-door" });
        await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { location_note = "Behind the bar" });
        await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { enabled = false });
        await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { enabled = true });

        var events = Events(await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/devices/{doorId}/activity"));

        // Newest first.
        Assert.Equal(
            new[]
            {
                DoorAuditActions.ReopenedChange,
                DoorAuditActions.ShutChange,
                DoorAuditActions.DetailsChange,
                DoorAuditActions.RenamedChange,
            },
            events.Select(e => e.GetProperty("change").GetString()!).ToArray());

        // `kind` is unchanged for compatibility: the console's existing dictionary still works.
        Assert.All(events, e => Assert.Equal(DoorAuditActions.EditedKind, e.GetProperty("kind").GetString()));

        Assert.All(events, e => Assert.Equal("Door Admin", e.GetProperty("actor_name").GetString()));
    }

    /// <summary>
    /// One PATCH that does several things is the STATE change, because "Shut by Priya Naidoo at
    /// 09:48" is the sentence somebody is looking for and the rename is on the same row for
    /// anybody reading further.
    /// </summary>
    [SkippableFact]
    public async Task An_edit_that_renames_and_shuts_at_once_is_reported_as_the_shut()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "chg2");
        var doorId = await club.AddDoorAsync(factory, "gate-ch0002", "front-door", name: "Front door");
        var admin = club.AdminClient(factory);

        await admin.PatchAsJsonAsync(
            $"/api/v1/admin/devices/{doorId}", new { gate_key = "back-door", enabled = false });

        var events = Events(await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/devices/{doorId}/activity"));

        Assert.Equal(DoorAuditActions.ShutChange, events[0].GetProperty("change").GetString());
    }

    /// <summary>
    /// A5's other half: a PATCH that repeats what the row already says writes NO audit row. Nine
    /// identical rows about nothing are what made the feed unreadable.
    /// </summary>
    [SkippableFact]
    public async Task A_patch_that_changes_nothing_writes_no_row_and_says_it_changed_nothing()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "chg3");
        var doorId = await club.AddDoorAsync(factory, "gate-ch0003", "front-door", name: "Front door");
        var admin = club.AdminClient(factory);

        var first = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { enabled = false });
        var firstBody = await first.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(firstBody.GetProperty("unchanged").GetBoolean());

        var before = (await club.AuditRowsAsync(factory, DoorAuditActions.Updated)).Count;

        // The stale tab: it still believes the door is open and offers to shut it.
        var repeat = await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { enabled = false });
        Assert.Equal(HttpStatusCode.OK, repeat.StatusCode);

        var body = await repeat.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("unchanged").GetBoolean());

        // Everything the sentence "it was already shut — by Door Admin at 21:48" needs.
        Assert.Equal("Door Admin", body.GetProperty("shut_by_name").GetString());
        Assert.Equal(JsonValueKind.String, body.GetProperty("out_of_service_since").ValueKind);

        Assert.Equal(before, (await club.AuditRowsAsync(factory, DoorAuditActions.Updated)).Count);
    }

    /// <summary>
    /// The instant is NOT re-stamped by a repeat, which is the money rule
    /// <c>AdminDeviceEndpoints.UpdateAsync</c> has always carried — and is now also visible on
    /// the wire, because a console that showed a moving "shut at" would be reporting one.
    /// </summary>
    [SkippableFact]
    public async Task A_repeated_shut_does_not_move_the_instant_or_the_name()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "chg4");
        var doorId = await club.AddDoorAsync(factory, "gate-ch0004", "front-door", name: "Front door");
        var admin = club.AdminClient(factory);

        var first = await (await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { enabled = false }))
            .Content.ReadFromJsonAsync<JsonElement>();
        var stamped = first.GetProperty("out_of_service_since").GetDateTimeOffset();

        await Task.Delay(30);

        var again = await (await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { enabled = false }))
            .Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(stamped, again.GetProperty("out_of_service_since").GetDateTimeOffset());
        Assert.Equal("Door Admin", again.GetProperty("shut_by_name").GetString());
    }

    /// <summary>
    /// <b>The door was shut by the person who shut it, not by whoever is reading.</b> A second
    /// admin sees the first admin's name — which is the whole of A5 — and reopening clears it,
    /// because a door in service was not shut by anybody.
    /// </summary>
    [SkippableFact]
    public async Task A_second_admin_is_told_who_shut_the_door_and_reopening_clears_it()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "chg5");
        var doorId = await club.AddDoorAsync(factory, "gate-ch0005", "front-door", name: "Front door");

        await club.AdminClient(factory).PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { enabled = false });

        // Somebody else entirely, reading the same door.
        var other = club.ClientFor(factory, club.MemberUserId, "admin");
        var doors = await other.GetFromJsonAsync<JsonElement>("/api/v1/admin/doors");
        var device = doors.GetProperty("doors").EnumerateArray().Single().GetProperty("device");

        Assert.Equal("Door Admin", device.GetProperty("shut_by_name").GetString());
        Assert.NotEqual("Door Member", device.GetProperty("shut_by_name").GetString());

        var reopened = await (await other.PatchAsJsonAsync(
                $"/api/v1/admin/devices/{doorId}", new { enabled = true }))
            .Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(JsonValueKind.Null, reopened.GetProperty("shut_by_name").ValueKind);
        Assert.Equal(JsonValueKind.Null, reopened.GetProperty("out_of_service_since").ValueKind);
    }

    /// <summary>
    /// A fleet shut names its actor too — and it is the case a derivation from the trail could
    /// never have answered, because <c>doors.shut_all</c> writes ONE row for the whole club with
    /// no <c>device_id</c> on it.
    /// </summary>
    [SkippableFact]
    public async Task A_fleet_shut_records_who_shut_each_door_and_a_fleet_reopen_clears_it()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "chg6");
        await club.AddDoorAsync(factory, "gate-ch0006", "front-door", name: "Front door");
        await club.AddDoorAsync(factory, "gate-ch0007", "side-door", name: "Side door");
        var admin = club.AdminClient(factory);

        await admin.PostAsJsonAsync("/api/v1/admin/doors/shut-all", new { });

        var shut = await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/doors");
        Assert.All(
            shut.GetProperty("doors").EnumerateArray(),
            d => Assert.Equal("Door Admin", d.GetProperty("device").GetProperty("shut_by_name").GetString()));

        await admin.PostAsJsonAsync("/api/v1/admin/doors/reopen-all", new { });

        var open = await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/doors");
        Assert.All(
            open.GetProperty("doors").EnumerateArray(),
            d => Assert.Equal(
                JsonValueKind.Null, d.GetProperty("device").GetProperty("shut_by_name").ValueKind));
    }

    /// <summary>
    /// <b>Another club's admin never names this club's door.</b> The name comes from a read of
    /// <c>memberships</c>, which is tenant-filtered — and a <c>ShutByUserId</c> holding a guid
    /// from another club must resolve to nothing rather than to that person.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_admin_is_never_named_on_this_clubs_door()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(factory, "chgmine");
        var theirs = await DoorClub.SeedAsync(factory, "chgthrs");
        var doorId = await mine.AddDoorAsync(factory, "gate-ch0008", "front-door", name: "Front door");

        // Their admin's id, written onto my door's row directly — the injection the tenant
        // filter is the only defence against.
        await mine.SetShutByAsync(factory, doorId, theirs.AdminUserId);

        var device = (await mine.AdminClient(factory).GetFromJsonAsync<JsonElement>("/api/v1/admin/doors"))
            .GetProperty("doors").EnumerateArray().Single().GetProperty("device");

        Assert.Equal(JsonValueKind.Null, device.GetProperty("shut_by_name").ValueKind);
    }

    /// <summary>
    /// And the same for a door event's actor: a row this club holds whose actor belongs to
    /// another club names nobody.
    /// </summary>
    [SkippableFact]
    public async Task An_event_whose_actor_belongs_to_another_club_names_nobody()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(factory, "chgamine");
        var theirs = await DoorClub.SeedAsync(factory, "chgathrs");
        var doorId = await mine.AddDoorAsync(factory, "gate-ch0009", "front-door", name: "Front door");

        await mine.WriteEventRowAsync(
            factory, doorId, DoorAuditActions.Updated, DateTimeOffset.UtcNow.AddMinutes(-1),
            actorUserId: theirs.AdminUserId, changes: [DoorAuditActions.ShutToken]);

        var events = Events(await mine.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>($"/api/v1/admin/devices/{doorId}/activity"));

        var row = events.Single();
        Assert.Equal(DoorAuditActions.ShutChange, row.GetProperty("change").GetString());
        Assert.Equal(JsonValueKind.Null, row.GetProperty("actor_name").ValueKind);
    }

    /// <summary>
    /// Every word <c>change</c> can take is in the closed set, so a console holding a sentence
    /// per word cannot meet one it has not got — the same rule <c>kind</c> already runs under.
    /// </summary>
    [SkippableFact]
    public async Task Every_change_word_a_door_can_carry_is_in_the_closed_set()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "chg7");
        var doorId = await club.AddDoorAsync(factory, "gate-ch0010", "front-door", name: "Front door");
        var now = DateTimeOffset.UtcNow;

        foreach (var action in DoorAuditActions.Events)
        {
            await club.WriteEventRowAsync(factory, doorId, action, now.AddMinutes(-1), club.AdminUserId, []);
        }

        // And one this server does not have a word for at all.
        await club.WriteEventRowAsync(factory, doorId, "device.teleported", now.AddMinutes(-2), club.AdminUserId, []);

        var events = Events(await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>($"/api/v1/admin/devices/{doorId}/activity"));

        Assert.All(events, e => Assert.Contains(e.GetProperty("change").GetString(), DoorAuditActions.Changes));
        Assert.Contains(events, e => e.GetProperty("change").GetString() == DoorAuditActions.OtherChange);
    }
}
