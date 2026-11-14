using System.Net.Http.Json;
using System.Text.Json;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 2, C7 (ADM-H, F3-1): the repeating-booking console read <c>GET /{id}</c> as the
/// schedule itself while the server wraps it (<c>{schedule, timezone}</c>), and create's answer
/// as a schedule while it is <c>{schedule, rows_created}</c> — "Holds no courts yet on no days",
/// "End undefined". The frontend now pins the response shapes in its contract test; this is the
/// server's half: every schedule route's answer, key for key, so a change to either side is red
/// on that side. <b>If you change a key set here, change <c>src/frontend/src/test/serverContract.ts</c>
/// in the same commit.</b>
/// </summary>
public sealed class R2ScheduleResponseShapeHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string Path = "/api/v1/admin/schedules";

    /// <summary>The schedule object every route that carries one carries.</summary>
    public static readonly string[] ScheduleKeys =
    [
        "id", "name", "label", "days", "start", "end", "start_date", "end_date", "interval_weeks", "status", "courts",
        "next_occurrence", "materialised_through", "created_by_name", "created_at",
        // R5 A5-4: every rule in the schedule's history, so the console can say what changes when.
        "rules",
    ];

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static DateOnly NextTuesday(int weeksAhead)
    {
        var day = DateOnly.FromDateTime(DateTime.UtcNow.Date).AddDays(weeksAhead * 7);
        while (day.DayOfWeek != DayOfWeek.Tuesday) day = day.AddDays(1);
        return day;
    }

    private static void Keys(JsonElement body, params string[] expected) =>
        Assert.Equal(expected.Order(), body.EnumerateObject().Select(p => p.Name).Order());

    private static async Task<JsonElement> OkAsync(Task<HttpResponseMessage> call)
    {
        var response = await call;
        Assert.True(response.IsSuccessStatusCode, $"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    [SkippableFact]
    public async Task Every_schedule_route_answers_the_shape_the_console_is_pinned_to()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r2schedshape", DoorClub.DefaultSettings);
        var client = club.AdminClient(factory);
        var from = NextTuesday(1);
        object Rule(string name) => new
        {
            name,
            label = "League",
            days = new[] { "tue" },
            start = "18:00",
            end = "21:00",
            startDate = from.ToString("yyyy-MM-dd"),
            intervalWeeks = 1,
            courts = new[] { club.CourtId },
        };

        var created = await OkAsync(client.PostAsJsonAsync(Path, Rule("Tuesday league")));
        Keys(created, "schedule", "rows_created");
        Keys(created.GetProperty("schedule"), ScheduleKeys);
        var id = created.GetProperty("schedule").GetProperty("id").GetGuid();

        var list = await OkAsync(client.GetAsync(Path));
        Keys(list, "schedules", "timezone");
        Keys(list.GetProperty("schedules").EnumerateArray().First(), ScheduleKeys);

        var one = await OkAsync(client.GetAsync($"{Path}/{id}"));
        Keys(one, "schedule", "timezone");
        Keys(one.GetProperty("schedule"), ScheduleKeys);

        var edited = await OkAsync(client.PatchAsJsonAsync($"{Path}/{id}", new
        {
            name = "Tuesday league",
            label = "League",
            days = new[] { "tue" },
            start = "18:30",
            end = "21:00",
            startDate = from.ToString("yyyy-MM-dd"),
            intervalWeeks = 1,
            courts = new[] { club.CourtId },
            reason = "later start",
        }));
        Keys(edited, "schedule", "rows_created", "effective_from", "effective_from_clamped_to");
        Keys(edited.GetProperty("schedule"), ScheduleKeys);

        var skipped = await OkAsync(client.PatchAsJsonAsync($"{Path}/{id}/occurrences/{NextTuesday(2):yyyy-MM-dd}", new { skip = true, reason = "hall hired" }));
        Keys(skipped, "occurrence_date", "status", "rows_created");

        var ended = await OkAsync(client.PostAsJsonAsync($"{Path}/{id}/end", new { reason = "Season over" }));
        Keys(ended, "status", "end_date", "occurrences_cancelled", "effective_from", "effective_from_clamped_to");
    }
}
