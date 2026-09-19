using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// W1.3 — the club's door log and its CSV.
///
/// <para>
/// <b>The single most important test in this class is the one that asserts nothing happens.</b>
/// P3 says the admin log filters by DOOR, TIME and OUTCOME only, and that there is no
/// per-member filter anywhere. A rule enforced by the absence of a parameter is a rule that
/// arrives back the first time somebody adds a convenience, so
/// <see cref="No_parameter_named_after_a_member_changes_anything"/> drives five plausible
/// spellings through the route and asserts the answer is byte-identical.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class AdminDoorLogHttpTests
{
    private readonly PostgresFixture _pg;

    public AdminDoorLogHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string LogPath = "/api/v1/admin/doors/activity";
    private const string CsvPath = "/api/v1/admin/doors/activity.csv";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static List<JsonElement> Items(JsonElement body) => body.GetProperty("items").EnumerateArray().ToList();

    /// <summary>Last 24 hours, newest first, 50 at a time — the defaults a console lands on.</summary>
    [SkippableFact]
    public async Task The_default_window_is_the_last_day_newest_first()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logdefault");
        var doorId = await club.AddDoorAsync(factory, "gate-lg0001", "front-door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddHours(-1), gateKey: "front-door");
        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddHours(-3), gateKey: "front-door");
        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddHours(-30), gateKey: "front-door");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath);
        var items = Items(body);

        Assert.Equal(2, items.Count);
        Assert.True(items[0].GetProperty("at").GetDateTimeOffset() > items[1].GetProperty("at").GetDateTimeOffset());
        Assert.Equal(DoorSettings.DefaultLogRetentionDays, body.GetProperty("retention_days").GetInt32());
    }

    /// <summary>Every row names its door, because the log spans all of them.</summary>
    [SkippableFact]
    public async Task Every_row_names_the_door_it_happened_at()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logdoor");
        var doorId = await club.AddDoorAsync(factory, "gate-lg0002", "side-door", name: "Side door");
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddMinutes(-5), gateKey: "side-door");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath);
        var door = Items(body).Single().GetProperty("door");

        Assert.Equal(doorId, door.GetProperty("id").GetGuid());
        Assert.Equal("Side door", door.GetProperty("name").GetString());
        Assert.Equal("side-door", door.GetProperty("gate_key").GetString());
    }

    /// <summary>
    /// A door nobody has named is still a door, and its rows must be readable — the log is
    /// where an admin finds out which board that is.
    /// </summary>
    [SkippableFact]
    public async Task A_row_from_an_unnamed_door_carries_a_null_gate_key_rather_than_vanishing()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "lognoname");
        var doorId = await club.AddDoorAsync(factory, "gate-lg0003", gateKey: null);
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddMinutes(-5));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath);
        var door = Items(body).Single().GetProperty("door");

        Assert.Equal(JsonValueKind.Null, door.GetProperty("gate_key").ValueKind);
    }

    [SkippableFact]
    public async Task The_door_filter_narrows_to_one_board()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logfilter");
        var front = await club.AddDoorAsync(factory, "gate-lg0004", "front-door");
        var side = await club.AddDoorAsync(factory, "gate-lg0005", "side-door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(factory, front, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-5));
        await club.WriteRowAsync(factory, side, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-4));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>($"{LogPath}?door={front}");
        Assert.Equal(front, Items(body).Single().GetProperty("door").GetProperty("id").GetGuid());
    }

    [SkippableTheory]
    [InlineData("released", 2)]
    [InlineData("refused", 2)]
    [InlineData("offline", 2)]
    public async Task The_outcome_filter_is_a_closed_set_of_three(string outcome, int expected)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, $"logout-{outcome}");
        var doorId = await club.AddDoorAsync(factory, $"gate-{Guid.NewGuid():N}"[..14], "front-door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-5));
        await club.WriteRowAsync(factory, doorId, DoorTrail.OfflineOpenAction, now.AddMinutes(-4), seq: 1);
        await club.WriteRowAsync(
            factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}too_early", now.AddMinutes(-3), reason: "too_early");
        await club.WriteRowAsync(factory, doorId, DoorTrail.OfflineUnknownScanAction, now.AddMinutes(-2), seq: 2);

        var body = await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>($"{LogPath}?door={doorId}&outcome={outcome}");

        Assert.Equal(expected, Items(body).Count);
    }

    [SkippableFact]
    public async Task An_outcome_outside_the_closed_set_is_refused()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logbadout");
        var res = await club.AdminClient(factory).GetAsync($"{LogPath}?outcome=opened");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("outcome_invalid", body.GetProperty("error").GetString());
    }

    [SkippableFact]
    public async Task The_reason_filter_reaches_both_vocabularies()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logreason");
        var doorId = await club.AddDoorAsync(factory, "gate-lg0006", "front-door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(
            factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}too_early", now.AddMinutes(-5), reason: "too_early");
        await club.WriteRowAsync(
            factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}not_recognised", now.AddMinutes(-4),
            reason: "not_recognised");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>($"{LogPath}?reason=too_early");
        Assert.Equal("too_early", Items(body).Single().GetProperty("reason").GetString());
    }

    /// <summary>
    /// P3, made mechanical. Five spellings a well-meaning console might send, and the answer
    /// must be identical to the unfiltered one every time — because there is no such filter and
    /// an unknown parameter is ignored rather than honoured.
    /// </summary>
    [SkippableFact]
    public async Task No_parameter_named_after_a_member_changes_anything()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logp3");
        var doorId = await club.AddDoorAsync(factory, "gate-lg0007", "front-door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-5), subjectUserId: club.MemberUserId);
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-4), subjectUserId: club.AdminUserId);

        var client = club.AdminClient(factory);
        var baseline = await (await client.GetAsync(LogPath)).Content.ReadAsStringAsync();

        foreach (var key in new[] { "member", "user", "subject", "q", "search" })
        {
            var filtered = await (await client.GetAsync($"{LogPath}?{key}={club.MemberUserId}")).Content.ReadAsStringAsync();
            Assert.Equal(baseline, filtered);

            var byName = await (await client.GetAsync($"{LogPath}?{key}=Door%20Member")).Content.ReadAsStringAsync();
            Assert.Equal(baseline, byName);
        }
    }

    [SkippableFact]
    public async Task The_cursor_walks_the_whole_range_once_and_stops()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logcursor");
        var doorId = await club.AddDoorAsync(factory, "gate-lg0008", "front-door");
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < 7; i++)
        {
            await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-(i + 1)));
        }

        var client = club.AdminClient(factory);
        var seen = new List<DateTimeOffset>();
        string? cursor = null;
        var pages = 0;

        do
        {
            var url = $"{LogPath}?limit=3" + (cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}");
            var body = await client.GetFromJsonAsync<JsonElement>(url);
            seen.AddRange(Items(body).Select(i => i.GetProperty("at").GetDateTimeOffset()));
            cursor = body.GetProperty("next_cursor").ValueKind == JsonValueKind.Null
                ? null
                : body.GetProperty("next_cursor").GetString();
            pages++;
        }
        while (cursor is not null && pages < 10);

        Assert.Equal(7, seen.Count);
        Assert.Equal(seen.Count, seen.Distinct().Count());
        Assert.Equal(seen.OrderByDescending(a => a).ToList(), seen);
    }

    /// <summary>A page that exactly empties the range must not promise a next one.</summary>
    [SkippableFact]
    public async Task The_last_page_carries_no_cursor()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logend");
        var doorId = await club.AddDoorAsync(factory, "gate-lg0009", "front-door");
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < 3; i++)
        {
            await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-(i + 1)));
        }

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>($"{LogPath}?door={doorId}&limit=3");
        Assert.Equal(3, Items(body).Count);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("next_cursor").ValueKind);
    }

    [SkippableTheory]
    [InlineData(0, 1)]
    [InlineData(5000, 200)]
    public async Task The_limit_is_clamped_rather_than_refused(int asked, int expected)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, $"loglim-{asked}");
        var doorId = await club.AddDoorAsync(factory, $"gate-{Guid.NewGuid():N}"[..14], "front-door");
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < 3; i++)
        {
            await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-(i + 1)));
        }

        var body = await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>($"{LogPath}?door={doorId}&limit={asked}");

        Assert.Equal(Math.Min(expected, 3), Items(body).Count);
    }

    /// <summary>
    /// W1.9's promise, enforced on the read. A club that keeps 90 days cannot be shown day 200,
    /// whatever <c>from</c> says — the rows may still be on disk between sweeps, and the page's
    /// own retention statement would be a lie if the log answered past it.
    /// </summary>
    [SkippableFact]
    public async Task A_range_wider_than_retention_is_clamped_and_the_response_says_by_how_much()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, "logret",
            """{"slice_minutes":15,"grace_window_minutes":5,"timezone":"UTC","door_log_retention_days":7}""");
        var doorId = await club.AddDoorAsync(factory, "gate-lg0010", "front-door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddDays(-3));
        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddDays(-30));

        var from = now.AddDays(-365).ToString("O");
        var body = await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>($"{LogPath}?door={doorId}&from={Uri.EscapeDataString(from)}");

        Assert.Single(Items(body));
        Assert.Equal(7, body.GetProperty("retention_days").GetInt32());
    }

    /// <summary>A hand-edited retention below the floor is clamped up, not honoured.</summary>
    [SkippableFact]
    public async Task A_retention_outside_its_bounds_is_clamped_on_read()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, "logclamp",
            """{"slice_minutes":15,"grace_window_minutes":5,"timezone":"UTC","door_log_retention_days":1}""");
        await club.AddDoorAsync(factory, "gate-lg0011", "front-door");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath);
        Assert.Equal(DoorSettings.MinLogRetentionDays, body.GetProperty("retention_days").GetInt32());
    }

    /// <summary>
    /// W1.3 says to reuse the per-board projection rather than write a second one. This is what
    /// stops the two drifting after the fact.
    /// </summary>
    [SkippableFact]
    public async Task A_club_log_row_and_a_board_feed_row_agree_on_every_shared_key()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logsame");
        var doorId = await club.AddDoorAsync(factory, "gate-lg0012", "front-door");
        await club.WriteRowAsync(
            factory, doorId, DoorTrail.OfflineOpenAction, DateTimeOffset.UtcNow.AddMinutes(-5),
            subjectUserId: club.MemberUserId, fingerprint: "1f4c9ab2", seq: 11);

        var client = club.AdminClient(factory);
        var logRow = Items(await client.GetFromJsonAsync<JsonElement>($"{LogPath}?door={doorId}")).Single();
        var feed = await client.GetFromJsonAsync<JsonElement>($"/api/v1/admin/devices/{doorId}/activity");
        var feedRow = feed.GetProperty("items").EnumerateArray().Single();

        foreach (var key in new[] { "at", "delivered_at", "action", "reason", "offline", "fingerprint" })
        {
            Assert.Equal(feedRow.GetProperty(key).GetRawText(), logRow.GetProperty(key).GetRawText());
        }
        Assert.Equal(feedRow.GetProperty("member").GetRawText(), logRow.GetProperty("member").GetRawText());

        // …and the per-board feed stays exactly seven keys: WIRE-W1's six plus `delivered_at`,
        // which A4 added because an offline row's `at` is the SCAN and the row was written when
        // the board next called in. A page that had only one of the two could not say which.
        Assert.Equal(7, feedRow.EnumerateObject().Count());
    }

    /// <summary>A registration and an admin edit are the BOARD's story, not the door's log.</summary>
    [SkippableFact]
    public async Task Rows_that_are_not_scans_are_not_in_the_club_log()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "lognonscan");
        var doorId = await club.AddDoorAsync(factory, "gate-lg0013", "front-door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(factory, doorId, "device.registered", now.AddMinutes(-5));
        await club.WriteRowAsync(factory, doorId, "device.updated", now.AddMinutes(-4));
        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-3));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>($"{LogPath}?door={doorId}");
        Assert.Equal(DeviceGateEndpoint.OpenedAction, Items(body).Single().GetProperty("action").GetString());
    }

    [SkippableFact]
    public async Task Another_clubs_rows_never_appear_in_this_clubs_log()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(factory, "logmine");
        var theirs = await DoorClub.SeedAsync(factory, "logtheirs");
        var myDoor = await mine.AddDoorAsync(factory, "gate-lg0014", "mine");
        var theirDoor = await theirs.AddDoorAsync(factory, "gate-lg0015", "theirs");
        var now = DateTimeOffset.UtcNow;

        await theirs.WriteRowAsync(factory, theirDoor, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-5));
        await theirs.WriteRowAsync(factory, myDoor, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-4));
        await mine.WriteRowAsync(factory, myDoor, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-3));

        var client = mine.AdminClient(factory);

        Assert.Single(Items(await client.GetFromJsonAsync<JsonElement>(LogPath)));

        // And asking for their door by id answers nothing rather than their rows.
        var byTheirDoor = await client.GetFromJsonAsync<JsonElement>($"{LogPath}?door={theirDoor}");
        Assert.Empty(Items(byTheirDoor));
    }

    [SkippableFact]
    public async Task A_member_cannot_read_the_club_log()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logmember");
        Assert.Equal(HttpStatusCode.Forbidden, (await club.MemberClient(factory).GetAsync(LogPath)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await club.MemberClient(factory).GetAsync(CsvPath)).StatusCode);
    }

    // ---- the CSV ----

    [SkippableFact]
    public async Task The_csv_carries_the_stated_header_and_is_an_attachment()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "csvhead");
        var doorId = await club.AddDoorAsync(factory, "gate-lg0016", "front-door", name: "Front door");
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddMinutes(-5),
            subjectUserId: club.MemberUserId, reason: "ok", gateKey: "front-door");

        var res = await club.AdminClient(factory).GetAsync($"{CsvPath}?door={doorId}");
        var text = await res.Content.ReadAsStringAsync();
        var lines = text.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);

        Assert.Equal("text/csv", res.Content.Headers.ContentType?.MediaType);
        Assert.Equal("attachment", res.Content.Headers.ContentDisposition?.DispositionType);
        Assert.StartsWith("door-log-", res.Content.Headers.ContentDisposition?.FileName?.Trim('"') ?? "");
        Assert.EndsWith(".csv", res.Content.Headers.ContentDisposition?.FileName?.Trim('"') ?? "");
        Assert.Equal("at,door,door_name,outcome,reason,offline,member,fingerprint", lines[0]);
        Assert.Equal(2, lines.Length);
        Assert.Contains("Front door", lines[1]);
        Assert.Contains("released", lines[1]);
    }

    /// <summary>
    /// A club's door name, a member's name and a reason all reach a spreadsheet unquoted today.
    /// A cell that starts with <c>= + - @</c> is a formula there, and the club that opens this
    /// file is the club whose door somebody named <c>=cmd|…</c>.
    /// </summary>
    [SkippableTheory]
    [InlineData("=HYPERLINK(\"http://evil\")")]
    [InlineData("+441234")]
    [InlineData("-2+3")]
    [InlineData("@SUM(A1)")]
    public async Task A_cell_that_a_spreadsheet_would_treat_as_a_formula_is_defused(string hostile)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, $"csvinj-{hostile.Length}");
        var doorId = await club.AddDoorAsync(factory, $"gate-{Guid.NewGuid():N}"[..14], hostile, name: hostile);
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddMinutes(-5), gateKey: hostile);

        var res = await club.AdminClient(factory).GetAsync($"{CsvPath}?door={doorId}");
        var lines = (await res.Content.ReadAsStringAsync()).Split("\r\n", StringSplitOptions.RemoveEmptyEntries);

        // The value survives, so the log is still readable; it just cannot execute. Compared
        // against the CSV-escaped form, because a value carrying a quote is legitimately
        // doubled by the grammar — the defusing and the quoting are two separate rules and the
        // test must not confuse one for the other.
        Assert.Contains("'" + hostile.Replace("\"", "\"\""), lines[1]);
        Assert.DoesNotContain($",{hostile[0]}", lines[1]);
        Assert.DoesNotContain($",\"{hostile[0]}", lines[1]);
    }

    /// <summary>A comma, a quote and a newline in a door's name must not shift the columns.</summary>
    [SkippableFact]
    public async Task A_name_full_of_separators_stays_in_its_own_cell()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "csvquote");
        var doorId = await club.AddDoorAsync(factory, "gate-lg0017", "a,b", name: "He said \"hi\",\nthen left");
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddMinutes(-5), gateKey: "a,b");

        var text = await (await club.AdminClient(factory).GetAsync($"{CsvPath}?door={doorId}")).Content.ReadAsStringAsync();

        Assert.Contains("\"He said \"\"hi\"\",\nthen left\"", text);
        Assert.Contains("\"a,b\"", text);
    }

    /// <summary>The export is a thing that happened, and the trail says who did it and to what.</summary>
    [SkippableFact]
    public async Task An_export_writes_one_audit_row_naming_the_actor_the_filters_and_the_count()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "csvaudit");
        var doorId = await club.AddDoorAsync(factory, "gate-lg0018", "front-door");
        var now = DateTimeOffset.UtcNow;
        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-5));
        await club.WriteRowAsync(
            factory, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}too_early", now.AddMinutes(-4), reason: "too_early");

        await club.AdminClient(factory).GetAsync($"{CsvPath}?door={doorId}&outcome=released");

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == AdminDoorLogEndpoint.ExportedAction)
            .SingleAsync();

        Assert.Equal(club.AdminUserId, row.ActorUserId);
        Assert.Null(row.SubjectUserId);

        using var details = JsonDocument.Parse(row.DetailsJson!);
        Assert.Equal(1, details.RootElement.GetProperty("rows").GetInt32());
        Assert.Equal(doorId, details.RootElement.GetProperty("door").GetGuid());
        Assert.Equal("released", details.RootElement.GetProperty("outcome").GetString());
    }

    /// <summary>
    /// Ten thousand rows is the ceiling. A club that asks for more gets the first ten thousand
    /// and is told, rather than a request that times out and is retried.
    /// </summary>
    [SkippableFact]
    public async Task The_export_is_bounded_and_says_so_when_it_truncated()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "csvcap");
        var doorId = await club.AddDoorAsync(factory, "gate-lg0019", "front-door");
        var now = DateTimeOffset.UtcNow;

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            for (var i = 0; i < AdminDoorLogEndpoint.MaxExportRows + 5; i++)
            {
                db.AuditLogs.Add(new Api.Domain.AuditLog
                {
                    TenantId = club.TenantId,
                    ActorUserId = Guid.Empty,
                    Action = DeviceGateEndpoint.OpenedAction,
                    DetailsJson = JsonSerializer.Serialize(new { device_id = doorId }),
                    CreatedAt = now.AddSeconds(-(i + 1)),
                });
            }
            await db.SaveChangesAsync();
        }

        var res = await club.AdminClient(factory).GetAsync($"{CsvPath}?door={doorId}");
        var lines = (await res.Content.ReadAsStringAsync()).Split("\r\n", StringSplitOptions.RemoveEmptyEntries);

        // The LITERAL ten thousand, not the constant.
        //
        // Asserting `MaxExportRows + 1` was a test that moved with the thing it measured: a
        // mutant that doubled the cap changed the expectation with it and survived. The number
        // is a contract WIRE-W1 states in words, so the test states it in figures — and the
        // constant is checked against the same figure so a change to either is a red test with
        // an obvious cause rather than a silent widening.
        Assert.Equal(10_000, AdminDoorLogEndpoint.MaxExportRows);
        Assert.Equal(10_001, lines.Length);
        Assert.Equal("true", res.Headers.GetValues("X-Crusaders-Truncated").Single());
    }
}
