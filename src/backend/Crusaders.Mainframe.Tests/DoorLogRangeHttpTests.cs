using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A4 / A6 / E-M2 / E-M3 / E-L1 / E-L2 / O1 — what range the log answered, how much is in it, and
/// what it refuses.
///
/// <para>
/// <b>"The chair was nearly given half of yesterday."</b> The log's only range was a rolling
/// twenty-four hours and the file it produced was called <c>door-log-&lt;date&gt;-&lt;date&gt;.csv</c>,
/// so a name saying "the 20th to the 21st" held 09:50 to 09:50. There was no way at all to ask
/// for yesterday or for a particular day — the question a committee actually asks — and the page
/// could not state the window it had been given because the server never said.
/// </para>
///
/// <para>
/// <b>And the heading said a number it could not know.</b> "50 scans, newest first" over a page
/// of fifty drawn from a range of seventy reads as a total, and the export then handed the same
/// admin seventy rows. <c>total</c> is the range's, counted without the cursor.
/// </para>
///
/// <para>
/// <b>Two filters were silently ignored.</b> <c>?door=notauuid</c> answered the whole club's log
/// under one door's heading, and <c>?reason=bogus</c> answered an empty list, which an admin
/// reads as "nothing happened". Both are refused by name now, on the same argument
/// <c>from_invalid</c> has always carried.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DoorLogRangeHttpTests
{
    private readonly PostgresFixture _pg;

    public DoorLogRangeHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string LogPath = "/api/v1/admin/doors/activity";
    private const string CsvPath = "/api/v1/admin/doors/activity.csv";

    /// <summary>
    /// A club whose offset is never zero. <c>memory/gotchas-postgres-offsets.md</c>: asserting
    /// harder against a UTC club proves nothing about a club-local boundary, because the bug it
    /// is guarding — Npgsql refusing a non-zero offset on a <c>timestamptz</c> — cannot arise
    /// where the offset is zero, and every other fixture club in this repository runs UTC.
    /// </summary>
    private const string JohannesburgSettings =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"Africa/Johannesburg","heartbeat_seconds":45}""";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static List<JsonElement> Items(JsonElement body) => body.GetProperty("items").EnumerateArray().ToList();

    /// <summary>
    /// A6 / E-M2 / O1: the range's own count, the range it resolved, and the zone it resolved it
    /// in — none of which the page could previously say without inventing it.
    /// </summary>
    [SkippableFact]
    public async Task The_response_carries_the_ranges_total_the_resolved_range_and_the_clubs_zone()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logrange1", JohannesburgSettings);
        var doorId = await club.AddDoorAsync(factory, "gate-lr0001", "front-door", name: "Front door");
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < 7; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-(i + 1)),
                reason: GateAccess.Ok, gateKey: "front-door", doorName: "Front door");
        }

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>($"{LogPath}?limit=3");

        // Three on the page, SEVEN in the range: the two numbers the heading conflated.
        Assert.Equal(3, Items(body).Count);
        Assert.Equal(7, body.GetProperty("total").GetInt32());

        Assert.Equal("Africa/Johannesburg", body.GetProperty("timezone").GetString());

        var range = body.GetProperty("range");
        var from = range.GetProperty("from").GetDateTimeOffset();
        var to = range.GetProperty("to").GetDateTimeOffset();
        Assert.Equal(24, Math.Round((to - from).TotalHours));
    }

    /// <summary>
    /// The cursor moves the page and not the total: a second page of the same range still says
    /// how big the range is. Paging past a row must not make the club's night look smaller.
    /// </summary>
    [SkippableFact]
    public async Task The_total_is_the_ranges_and_does_not_shrink_as_the_cursor_walks_it()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logrange2", JohannesburgSettings);
        var doorId = await club.AddDoorAsync(factory, "gate-lr0002", "front-door", name: "Front door");
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < 5; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-(i + 1)),
                reason: GateAccess.Ok, doorName: "Front door");
        }

        var client = club.AdminClient(factory);
        var first = await client.GetFromJsonAsync<JsonElement>($"{LogPath}?limit=2");
        var cursor = first.GetProperty("next_cursor").GetString();
        var second = await client.GetFromJsonAsync<JsonElement>($"{LogPath}?limit=2&cursor={cursor}");

        Assert.Equal(5, first.GetProperty("total").GetInt32());
        Assert.Equal(5, second.GetProperty("total").GetInt32());
        Assert.Equal(2, Items(second).Count);
    }

    /// <summary>
    /// A4: every period the console offers, resolved on the server in the club's zone — and
    /// <c>yesterday</c> is a CLOSED day, which is the one the chair was nearly given half of.
    /// </summary>
    [SkippableTheory]
    [InlineData(DoorPeriod.Today)]
    [InlineData(DoorPeriod.Yesterday)]
    [InlineData(DoorPeriod.Last24h)]
    [InlineData(DoorPeriod.Last7d)]
    [InlineData(DoorPeriod.Last30d)]
    public async Task Every_period_resolves_to_a_range_the_response_states(string period)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logperiod", JohannesburgSettings);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>($"{LogPath}?period={period}");
        var range = body.GetProperty("range");
        var from = range.GetProperty("from").GetDateTimeOffset();
        var to = range.GetProperty("to").GetDateTimeOffset();

        Assert.True(from < to, $"{period}: {from:O} .. {to:O}");

        var zone = TimeZoneInfo.FindSystemTimeZoneById("Africa/Johannesburg");

        // Every whole-day period starts at a club-local midnight; last_24h is rolling and says
        // so in its own name, which is the distinction A4 is about.
        if (period != DoorPeriod.Last24h)
        {
            Assert.True(DoorClock.IsStartOfLocalDay(zone, from), $"{period} did not start at a club midnight: {from:O}");
        }

        if (period == DoorPeriod.Yesterday)
        {
            Assert.True(DoorClock.IsStartOfLocalDay(zone, to), $"yesterday did not end at a club midnight: {to:O}");
            Assert.Equal(1, Math.Round((to - from).TotalDays));
        }
    }

    /// <summary>
    /// A4: one named day, in the club's zone, from its own midnight to the next — and the rows
    /// that belong to the day before it are not in it.
    /// </summary>
    [SkippableFact]
    public async Task A_named_day_is_that_clubs_day_and_excludes_the_minute_before_it()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logday", JohannesburgSettings);
        var doorId = await club.AddDoorAsync(factory, "gate-lr0003", "front-door", name: "Front door");

        var zone = TimeZoneInfo.FindSystemTimeZoneById("Africa/Johannesburg");
        var today = DoorClock.LocalDateOf(zone, DateTimeOffset.UtcNow);
        var yesterday = today.AddDays(-1);
        var yesterdayStart = DoorClock.StartOfLocalDay(zone, yesterday);
        var todayStart = DoorClock.StartOfLocalDay(zone, today);

        // One a minute after yesterday began, one a minute before it did.
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, yesterdayStart.AddMinutes(1),
            reason: GateAccess.Ok, doorName: "Front door");
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, yesterdayStart.AddMinutes(-1),
            reason: GateAccess.Ok, doorName: "Front door");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(
            $"{LogPath}?day={yesterday:yyyy-MM-dd}");

        Assert.Equal(1, body.GetProperty("total").GetInt32());
        Assert.Equal(yesterdayStart, body.GetProperty("range").GetProperty("from").GetDateTimeOffset());
        Assert.Equal(todayStart, body.GetProperty("range").GetProperty("to").GetDateTimeOffset());
    }

    /// <summary>
    /// <b>Both midnights.</b> A row written in the first second of a club's day and one written
    /// in its last are each in exactly one day, and the boundary between them belongs to the
    /// later one. This is the test that fails if the boundary is computed with the wrong offset
    /// or with a <c>&gt;=</c> that should be a <c>&gt;</c>.
    /// </summary>
    [SkippableFact]
    public async Task A_row_at_either_midnight_lands_in_exactly_one_club_day()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logmidnite", JohannesburgSettings);
        var doorId = await club.AddDoorAsync(factory, "gate-lr0004", "front-door", name: "Front door");

        var zone = TimeZoneInfo.FindSystemTimeZoneById("Africa/Johannesburg");
        var today = DoorClock.LocalDateOf(zone, DateTimeOffset.UtcNow);
        var dayStart = DoorClock.StartOfLocalDay(zone, today.AddDays(-2));
        var dayEnd = DoorClock.StartOfLocalDay(zone, today.AddDays(-1));

        // The first instant of the day, and the last instant before the next one begins.
        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, dayStart, reason: GateAccess.Ok);
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, dayEnd.AddTicks(-1), reason: GateAccess.Ok);

        // And the boundary itself, which belongs to the day that is starting.
        await club.WriteRowAsync(factory, doorId, DeviceGateEndpoint.OpenedAction, dayEnd, reason: GateAccess.Ok);

        var client = club.AdminClient(factory);
        var first = await client.GetFromJsonAsync<JsonElement>($"{LogPath}?day={today.AddDays(-2):yyyy-MM-dd}");
        var second = await client.GetFromJsonAsync<JsonElement>($"{LogPath}?day={today.AddDays(-1):yyyy-MM-dd}");

        Assert.Equal(2, first.GetProperty("total").GetInt32());
        Assert.Equal(1, second.GetProperty("total").GetInt32());
    }

    /// <summary>
    /// A request that names the range twice is refused rather than silently resolved by a
    /// precedence rule nobody can see.
    /// </summary>
    [SkippableTheory]
    [InlineData("?period=today&day=2026-09-20")]
    [InlineData("?period=today&from=2026-09-20T00:00:00Z")]
    [InlineData("?day=2026-09-20&to=2026-09-21T00:00:00Z")]
    public async Task A_request_that_names_the_range_twice_is_refused(string query)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logconflict", JohannesburgSettings);

        foreach (var path in new[] { LogPath, CsvPath })
        {
            var response = await club.AdminClient(factory).GetAsync(path + query);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(DoorPeriod.RangeConflict, body.GetProperty("error").GetString());
        }
    }

    /// <summary>
    /// E-M3 and A4's refusals: four parameters this server cannot read, named, on both routes.
    /// A well-formed door id naming no board is NOT one of them — that is a real question with a
    /// real answer, and it is the shape a link to a removed door takes.
    /// </summary>
    [SkippableTheory]
    [InlineData("?door=notauuid", DoorLogQuery.DoorInvalid)]
    [InlineData("?removed_door=notauuid", DoorLogQuery.DoorInvalid)]
    [InlineData("?reason=bogus", DoorLogQuery.ReasonInvalid)]
    [InlineData("?period=last_week", DoorPeriod.PeriodInvalid)]
    [InlineData("?day=2026-13-40", DoorPeriod.DayInvalid)]
    [InlineData("?day=yesterday", DoorPeriod.DayInvalid)]
    public async Task A_filter_the_server_cannot_read_is_refused_by_name_on_both_routes(string query, string error)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logrefuse", JohannesburgSettings);

        foreach (var path in new[] { LogPath, CsvPath })
        {
            var response = await club.AdminClient(factory).GetAsync(path + query);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(error, body.GetProperty("error").GetString());
        }
    }

    /// <summary>
    /// A zone this platform has never heard of falls back to UTC and the wire SAYS UTC, never
    /// the club's own stored label beside times that are not in it. Reachable from a hand-edited
    /// settings row, because the PUT is not the only way a value gets into that column.
    /// </summary>
    [SkippableFact]
    public async Task A_zone_the_platform_does_not_know_is_reported_as_UTC_and_not_as_itself()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, "logbadzone", """{"timezone":"Mars/Olympus_Mons","grace_window_minutes":5}""");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>($"{LogPath}?period={DoorPeriod.Today}");

        Assert.Equal(TimeZoneInfo.Utc.Id, body.GetProperty("timezone").GetString());
        Assert.NotEqual("Mars/Olympus_Mons", body.GetProperty("timezone").GetString());
    }

    /// <summary>
    /// The other half of the rule, REVERSED by R3-13: a door id that is a UUID and names nothing
    /// this club has ever had is a named refusal, not an empty page.
    ///
    /// <para>
    /// <b>"The question was well formed" was the wrong test.</b> It is well formed and it is
    /// unanswerable, and the two are different — which is exactly what an empty list could not
    /// say. A stale bookmark to a deleted board reset the console's Door select to "All doors",
    /// printed "No scans at any door in the last 24 hours" over a filter that was in fact
    /// narrowed to one, and exported a zero-row file under the ordinary filename (A-C2). Three
    /// false sentences from one missing answer.
    /// </para>
    ///
    /// <para>
    /// It is not an existence oracle. Every id this club cannot answer for gets the identical
    /// refusal — invented, another club's, live or removed elsewhere — which is the same
    /// property the 404 on a foreign device id already has.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_well_formed_door_id_that_names_no_board_is_refused_by_name()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logunknown", JohannesburgSettings);

        var response = await club.AdminClient(factory).GetAsync($"{LogPath}?door={Guid.NewGuid()}");

        Assert.Equal(System.Net.HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(
            $"{{\"error\":\"{DoorLogQuery.DoorNotFound}\"}}", await response.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// A4: the file's name is the range it holds. Two dates when both ends are club midnights,
    /// date-and-time when they are not — which is the rolling default, the one that was lying.
    /// </summary>
    [SkippableFact]
    public async Task The_export_filename_carries_the_exact_local_range_and_says_when_it_is_not_whole_days()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logfile", JohannesburgSettings);
        var client = club.AdminClient(factory);

        var zone = TimeZoneInfo.FindSystemTimeZoneById("Africa/Johannesburg");
        var today = DoorClock.LocalDateOf(zone, DateTimeOffset.UtcNow);
        var yesterday = today.AddDays(-1);

        var whole = await client.GetAsync($"{CsvPath}?period={DoorPeriod.Yesterday}");
        Assert.Equal(
            $"attachment; filename=\"door-log-{yesterday:yyyy-MM-dd}-to-{today:yyyy-MM-dd}.csv\"",
            whole.Content.Headers.ContentDisposition!.ToString());

        // The rolling default: neither end is a midnight, so the name carries the times. The
        // shape rather than the exact minute, because the range is relative to now.
        var rolling = await client.GetAsync(CsvPath);
        var name = rolling.Content.Headers.ContentDisposition!.FileName!.Trim('"');
        Assert.Matches(@"^door-log-\d{4}-\d{2}-\d{2}T\d{4}-to-\d{4}-\d{2}-\d{2}T\d{4}\.csv$", name);
    }

    /// <summary>
    /// E-L1 / E-L2: the file's last column is the DELIVERY instant, blank where there was no
    /// delay to report, and an offline refusal says why it was refused instead of claiming
    /// nobody recorded a reason.
    /// </summary>
    [SkippableFact]
    public async Task The_export_carries_the_delivery_instant_and_says_why_an_offline_refusal_was_refused()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logdeliv", JohannesburgSettings);
        var doorId = await club.AddDoorAsync(factory, "gate-lr0005", "front-door", name: "Front door");

        var delivered = DateTimeOffset.UtcNow.AddMinutes(-5);
        var scanned = delivered.AddHours(-2);

        await club.WriteRowAsync(
            factory, doorId, DoorTrail.OfflineUnknownScanAction, delivered,
            seq: 3, occurredAt: scanned, doorName: "Front door");
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddMinutes(-1),
            reason: GateAccess.Ok, doorName: "Front door");

        var csv = await (await club.AdminClient(factory).GetAsync(CsvPath)).Content.ReadAsStringAsync();
        var lines = csv.Split("\r\n");

        Assert.Equal(AdminDoorLogEndpoint.Header, lines[0].TrimStart('﻿'));

        var online = lines[1].Split(',');
        var offline = lines[2].Split(',');

        // An online row has no delivery to name — a copy of at_utc there would be a delay the
        // file invented.
        Assert.Equal("", online[^1]);
        Assert.Equal(
            delivered.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture),
            offline[^1]);

        // E-L2: the reason IS recorded — it is the action. "No reason recorded" reads as the
        // system having lost the answer.
        Assert.Equal(DoorWords.NotOnTheSavedList, offline[7]);
        Assert.DoesNotContain(DoorWords.NoReason, csv);
    }

    /// <summary>
    /// Another club's rows are not in this club's total, however the range was named — the count
    /// is a second read of <c>audit_log</c> and the tenant filter carries the whole weight of
    /// isolation on that table.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_rows_are_not_in_this_clubs_total()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(factory, "logtotmine", JohannesburgSettings);
        var theirs = await DoorClub.SeedAsync(factory, "logtotthrs", JohannesburgSettings);

        var myDoor = await mine.AddDoorAsync(factory, "gate-lr0006", "front-door", name: "Front door");
        var theirDoor = await theirs.AddDoorAsync(factory, "gate-lr0007", "their-door", name: "Their door");
        var now = DateTimeOffset.UtcNow;

        await mine.WriteRowAsync(factory, myDoor, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-1), reason: GateAccess.Ok);
        for (var i = 0; i < 4; i++)
        {
            await theirs.WriteRowAsync(
                factory, theirDoor, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-(i + 2)), reason: GateAccess.Ok);
        }

        // And a row of THEIRS naming MY door id, which is the injection the tenant filter is the
        // only defence against: a guid inside a jsonb document proves nothing about whose it is.
        await theirs.WriteRowAsync(
            factory, myDoor, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-7), reason: GateAccess.Ok);

        var client = mine.AdminClient(factory);
        foreach (var query in new[] { "", "?period=today", "?period=last_7d", $"?door={myDoor}" })
        {
            var body = await client.GetFromJsonAsync<JsonElement>(LogPath + query);
            Assert.Equal(1, body.GetProperty("total").GetInt32());
        }
    }
}
