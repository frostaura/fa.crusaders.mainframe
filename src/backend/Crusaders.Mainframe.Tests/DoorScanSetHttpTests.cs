using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// B1 / A1 / C4 — the per-door feed, the club log, the CSV and the day counts are FOUR VIEWS OF
/// ONE SET.
///
/// <para>
/// <b>They were not.</b> The per-door feed returned every audit row carrying the board's
/// <c>device_id</c>, which is a wider set than a scan in two ways that both reached a screen.
/// <c>device.updated</c> and <c>device.auto_registered</c> are the board's own story and were
/// rendered as scans — a door with thirteen admin edits and no scans read "13 refused scans,
/// newest 1 min ago" while the club log had nothing for it at all. And
/// <c>device.event_time_clamped</c> is written BESIDE every clamped upload with identical
/// details, so every offline scan appeared twice on the feed and once everywhere else.
/// </para>
///
/// <para>
/// The assertions below are cross-surface on purpose: each one drives a fixture through the
/// four readers and asserts they agree. A test of any one of them in isolation is what let the
/// four drift in the first place.
/// </para>
/// </summary>
public sealed class DoorScanSetHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public DoorScanSetHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static List<JsonElement> Items(JsonElement body) => body.GetProperty("items").EnumerateArray().ToList();

    /// <summary>
    /// N offline scans uploaded are N rows on the feed, N in the club log, N in the CSV and N
    /// in the door's day — whatever else the upload wrote beside them.
    /// </summary>
    [SkippableFact]
    public async Task An_offline_scan_is_one_row_on_every_surface()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "scanset1", DoorClub.DaytimeSettings());
        var doorId = await club.AddDoorAsync(factory, "gate-ss0001", "front-door");
        var now = DateTimeOffset.UtcNow;

        // Three offline opens, each with the twin the upload path writes when it has to
        // overrule the board's clock. The twin is not a scan and must be counted nowhere.
        for (var i = 0; i < 3; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, DoorTrail.OfflineOpenAction, now.AddMinutes(-i - 1),
                subjectUserId: club.MemberUserId, seq: i + 1, gateKey: "front-door");
            await club.WriteRowAsync(
                factory, doorId, DoorAuditActions.EventTimeClamped, now.AddMinutes(-i - 1),
                subjectUserId: club.MemberUserId, seq: i + 1, gateKey: "front-door");
        }

        var admin = club.AdminClient(factory);

        var feed = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/devices/{doorId}/activity");
        var log = await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/doors/activity");
        var csv = await (await admin.GetAsync("/api/v1/admin/doors/activity.csv")).Content.ReadAsStringAsync();
        var overview = await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/doors");

        Assert.Equal(3, Items(feed).Count);
        Assert.Equal(3, Items(log).Count);
        Assert.Equal(3, csv.TrimEnd('\r', '\n').Split("\r\n").Length - 1);
        Assert.Equal(
            3,
            overview.GetProperty("doors").EnumerateArray()
                .Single(d => d.GetProperty("device").GetProperty("id").GetGuid() == doorId)
                .GetProperty("today").GetProperty("released").GetInt32());
    }

    /// <summary>
    /// A door nobody has scanned at, that an admin has edited a dozen times, has an empty feed
    /// — not a dozen rows the page will paint as scans.
    /// </summary>
    [SkippableFact]
    public async Task An_admin_edit_is_never_a_scan_on_the_feed()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "scanset2", DoorClub.DaytimeSettings());
        var doorId = await club.AddDoorAsync(factory, "gate-ss0002", gateKey: null, name: "North gate");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(factory, doorId, DoorAuditActions.AutoRegistered, now.AddHours(-2));
        for (var i = 0; i < 12; i++)
        {
            await club.WriteRowAsync(factory, doorId, DoorAuditActions.Updated, now.AddMinutes(-i));
        }

        var admin = club.AdminClient(factory);
        var feed = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/devices/{doorId}/activity");

        Assert.Empty(Items(feed));

        // They are not dropped — they are the board's story, in their own array, under their
        // own word, with no outcome and no member anywhere on them.
        var events = feed.GetProperty("events").EnumerateArray().ToList();
        Assert.Equal(13, events.Count);
        Assert.Equal(DoorAuditActions.EditedKind, events[0].GetProperty("kind").GetString());
        Assert.Equal(DoorAuditActions.RegisteredKind, events[^1].GetProperty("kind").GetString());
        // Five keys now: `change` says which edit it was, because thirteen rows of "details or
        // state were changed" were the whole of a door's story and none of them said which one
        // was the shut (A5). `actor_name` names the admin — the club's own admin audit, which
        // is what {actor, subject} has always promised. Still no outcome, no reason, no member
        // and no fingerprint: P4 is untouched.
        Assert.All(events, e => Assert.Equal(
            ["at", "action", "kind", "change", "actor_name", "count", "from"],
            e.EnumerateObject().Select(p => p.Name).ToArray()));

        // `count` and `from` are ALWAYS present, 1 and equal to `at` on an ordinary entry — a
        // key that appears only when a run was collapsed is a second response shape wearing one
        // name, the argument DeviceView already makes about the door-card fields on a court box.
        //
        // AND NOTHING HERE IS COLLAPSED, which is the half of A-L4 worth pinning. These twelve
        // edits are a minute apart, so the grouping must leave every one of them alone: it
        // merges a RUN of the identical event inside one printed minute, and a rule that
        // merged on the word alone would hide eleven separate decisions behind one line. See
        // AdminDeviceActivityEndpoint.Grouped, and DoorTruthR3HttpTests for the run that does
        // collapse.
        Assert.All(events, e => Assert.Equal(1, e.GetProperty("count").GetInt32()));
        Assert.All(events, e => Assert.Equal(
            e.GetProperty("at").GetDateTimeOffset(), e.GetProperty("from").GetDateTimeOffset()));

        // Rows written before the `changes` list existed have no list, so they are `other` —
        // honest, where "details" would be a guess about what a past edit did.
        Assert.Equal(DoorAuditActions.OtherChange, events[0].GetProperty("change").GetString());
        Assert.Equal(DoorAuditActions.RegisteredChange, events[^1].GetProperty("change").GetString());

        // Guid.Empty is the BOARD, not a person, and must not resolve to anybody's name.
        Assert.All(events, e => Assert.Equal(JsonValueKind.Null, e.GetProperty("actor_name").ValueKind));
    }

    /// <summary>
    /// An action this server can write that the wire vocabulary has no word for is still on the
    /// wire, as <c>unrecognised</c> — never silently dropped and never given an outcome.
    /// </summary>
    [SkippableFact]
    public async Task An_event_with_no_word_for_it_is_neutral_rather_than_absent()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "scanset3", DoorClub.DaytimeSettings());
        var doorId = await club.AddDoorAsync(factory, "gate-ss0003", "back-door");

        await club.WriteRowAsync(factory, doorId, "device.something_new", DateTimeOffset.UtcNow.AddMinutes(-1));

        var feed = await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>($"/api/v1/admin/devices/{doorId}/activity");

        Assert.Empty(Items(feed));
        var only = feed.GetProperty("events").EnumerateArray().Single();
        Assert.Equal(DoorAuditActions.UnrecognisedKind, only.GetProperty("kind").GetString());
        Assert.Equal("device.something_new", only.GetProperty("action").GetString());
    }

    /// <summary>
    /// The per-door feed and the club log agree on which rows are scans, for a fixture that
    /// contains every action this server writes about a door.
    /// </summary>
    [SkippableFact]
    public async Task The_feed_and_the_log_select_the_same_rows()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "scanset4", DoorClub.DaytimeSettings());
        var doorId = await club.AddDoorAsync(factory, "gate-ss0004", "every-door");
        var now = DateTimeOffset.UtcNow;

        var written = 0;
        foreach (var action in DoorAuditActions.Scans.Concat(DoorAuditActions.Events))
        {
            await club.WriteRowAsync(factory, doorId, action, now.AddSeconds(-++written), gateKey: "every-door");
        }

        var admin = club.AdminClient(factory);
        var feed = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/devices/{doorId}/activity?limit=200");
        var log = await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/doors/activity?limit=200");

        var feedActions = Items(feed).Select(i => i.GetProperty("action").GetString()!).Order().ToList();
        var logActions = Items(log).Select(i => i.GetProperty("action").GetString()!).Order().ToList();

        Assert.Equal(DoorAuditActions.Scans.Order().ToList(), feedActions);
        Assert.Equal(feedActions, logActions);
        Assert.Equal(
            DoorAuditActions.Events.Order().ToList(),
            feed.GetProperty("events").EnumerateArray().Select(e => e.GetProperty("action").GetString()!).Order().ToList());
    }
}
