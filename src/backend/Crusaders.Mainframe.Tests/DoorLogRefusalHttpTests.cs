using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// E3 / E5 — what the door log refuses, what it clamps, and why the two are different rules.
///
/// <para>
/// <b>A mistyped range answered 200 with the whole log.</b> <c>?from=not-a-date</c> fell through
/// to the default window and the CSV to the whole retention period, so an admin exporting "last
/// Tuesday" was handed the club's entire trail and filed it as last Tuesday's. The same was true
/// of a truncated cursor, which answered the FIRST page to a console that then labelled it as
/// the next one.
/// </para>
///
/// <para>
/// <b>A limit is not the same kind of mistake.</b> "Give me a million rows" is unambiguous and
/// bounded, so it is clamped, and an error screen where somebody wanted a list is the worse
/// answer. That line — clamp what is unambiguous, refuse what is a guess — is the whole of these
/// two findings and it is pinned here in both directions.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DoorLogRefusalHttpTests
{
    private readonly PostgresFixture _pg;

    public DoorLogRefusalHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string LogPath = "/api/v1/admin/doors/activity";
    private const string CsvPath = "/api/v1/admin/doors/activity.csv";
    private const string HistoryPath = "/api/v1/me/door/history";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>A date that is not a date is refused by name, on the log AND on the export.</summary>
    [SkippableTheory]
    [InlineData("from=not-a-date", DoorLogQuery.FromInvalid)]
    [InlineData("from=2026-13-45", DoorLogQuery.FromInvalid)]
    [InlineData("from=", null)]
    [InlineData("to=banana", DoorLogQuery.ToInvalid)]
    [InlineData("to=yesterday", DoorLogQuery.ToInvalid)]
    [InlineData("cursor=not-base64!!", DoorLogQuery.CursorInvalid)]
    [InlineData("cursor=aGVsbG8=", DoorLogQuery.CursorInvalid)]
    public async Task A_parameter_the_server_cannot_read_is_refused_by_name(string query, string? error)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, $"logbad{query.Length}");
        var doorId = await club.AddDoorAsync(factory, $"gate-{Guid.NewGuid():N}"[..14], "front-door");
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddMinutes(-5));

        var admin = club.AdminClient(factory);

        foreach (var path in new[] { LogPath, CsvPath })
        {
            var res = await admin.GetAsync($"{path}?{query}");
            if (error is null)
            {
                // An EMPTY parameter is an absent one — a console clearing a filter sends it.
                Assert.Equal(HttpStatusCode.OK, res.StatusCode);
                continue;
            }

            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
            Assert.Equal(
                error,
                (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
        }
    }

    /// <summary>
    /// A refused export writes NO audit row and no file. The trail records exports a club
    /// actually took, and a 400 is not one.
    /// </summary>
    [SkippableFact]
    public async Task A_refused_export_is_not_recorded_as_an_export()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logbadaud");
        var doorId = await club.AddDoorAsync(factory, "gate-rf0001", "front-door");
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddMinutes(-5));

        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await club.AdminClient(factory).GetAsync($"{CsvPath}?from=not-a-date")).StatusCode);

        Assert.Empty(await club.AuditRowsAsync(factory, AdminDoorLogEndpoint.ExportedAction));
    }

    /// <summary>The member's own history refuses a cursor it did not mint, for the same reason.</summary>
    [SkippableFact]
    public async Task A_members_history_refuses_a_cursor_it_did_not_mint()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "logbadme");
        var member = club.ClientFor(factory, club.MemberUserId, null);

        var res = await member.GetAsync($"{HistoryPath}?cursor=aGVsbG8=");
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(
            DoorLogQuery.CursorInvalid,
            (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        // …and an absent one is still the first page, which is what a console asks for.
        Assert.Equal(HttpStatusCode.OK, (await member.GetAsync(HistoryPath)).StatusCode);
    }

    /// <summary>
    /// E5: the clamp, pinned. Nought and a negative are one row rather than none and rather
    /// than a refusal; a million is the ceiling. Documented 1–200 on the log, 1–200 on the
    /// member's history, and the same on both because a member's page is a console too.
    /// </summary>
    [SkippableTheory]
    [InlineData("0", 1)]
    [InlineData("-1", 1)]
    [InlineData("-999", 1)]
    [InlineData("1", 1)]
    [InlineData("abc", 3)]
    [InlineData("", 3)]
    [InlineData("1000000", 3)]
    public async Task A_limit_outside_the_range_is_clamped_and_never_refused(string limit, int expected)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, $"logclamp{limit.Length}");
        var doorId = await club.AddDoorAsync(factory, $"gate-{Guid.NewGuid():N}"[..14], "front-door");
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < 3; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-i - 1),
                subjectUserId: club.MemberUserId);
        }

        var log = await club.AdminClient(factory).GetAsync($"{LogPath}?limit={limit}");
        Assert.Equal(HttpStatusCode.OK, log.StatusCode);
        Assert.Equal(
            expected,
            (await log.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").GetArrayLength());

        var history = await club.ClientFor(factory, club.MemberUserId, null)
            .GetAsync($"{HistoryPath}?limit={limit}");
        Assert.Equal(HttpStatusCode.OK, history.StatusCode);
        Assert.Equal(
            expected,
            (await history.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items").GetArrayLength());
    }
}
