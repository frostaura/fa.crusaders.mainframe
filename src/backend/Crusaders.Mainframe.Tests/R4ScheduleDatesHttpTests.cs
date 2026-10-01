using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 4, A4-3 and A4-10: what a repeating booking's detail says about its dates after
/// a "from this date on" change, and after it was ended from a future date.
///
/// <para>
/// The club is UTC (<see cref="DoorClub.DefaultSettings"/>), so an instant's clock is the wall
/// clock and "18:00" can be asserted directly.
/// </para>
/// </summary>
public sealed class R4ScheduleDatesHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string Path = "/api/v1/admin/schedules";

    private static DateOnly NextTuesday(int weeksAhead = 1)
    {
        var day = DateOnly.FromDateTime(DateTime.UtcNow.Date).AddDays(weeksAhead * 7);
        while (day.DayOfWeek != DayOfWeek.Tuesday) day = day.AddDays(1);
        return day;
    }

    private static object Rule(DoorClub club, DateOnly from, DateOnly to, string start = "18:00", string[]? days = null)
        => new
        {
            name = "Tuesday league",
            label = "League",
            days = days ?? ["tue"],
            start,
            end = "21:00",
            startDate = from.ToString("yyyy-MM-dd"),
            endDate = to.ToString("yyyy-MM-dd"),
            intervalWeeks = 1,
            courts = new[] { club.CourtId },
        };

    private TestWebAppFactory Factory => pg.SharedHost;

    private async Task<(DoorClub Club, HttpClient Client, Guid Id, DateOnly First)> SeriesAsync(string prefix)
    {
        var factory = Factory;
        var club = await DoorClub.SeedAsync(factory, prefix, DoorClub.DefaultSettings);
        var client = club.AdminClient(factory);
        var first = NextTuesday();
        var created = await client.PostAsJsonAsync(Path + "/", Rule(club, first, first.AddDays(35)));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("schedule").GetProperty("id").GetGuid();
        return (club, client, id, first);
    }

    private static async Task<List<Booking>> LiveRowsAsync(TestWebAppFactory factory, Guid tenantId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.Bookings.IgnoreQueryFilters()
            .Where(b => b.TenantId == tenantId && b.ScheduleId != null && b.Status != BookingStatus.Cancelled)
            .OrderBy(b => b.StartsAt).ToListAsync();
    }

    private static string Clock(JsonElement instant) => instant.GetDateTimeOffset().ToUniversalTime().ToString("HH:mm");

    /// <summary>
    /// A new start time from the third Tuesday: the first two stay held at 18:00 and are LISTED at
    /// 18:00, the header's next night is the first Tuesday at 18:00, each date is held once (the
    /// series never collides with itself), and the change record names the date it runs from.
    /// </summary>
    [SkippableFact]
    public async Task A_change_from_a_date_keeps_the_earlier_dates_hours_everywhere_they_are_read()
    {
        Skip.IfNot(pg.Available, Skipped);
        var (club, client, id, first) = await SeriesAsync("r4sch");
        var from = first.AddDays(14);

        var changed = await client.PatchAsJsonAsync($"{Path}/{id}", new
        {
            name = "Tuesday league",
            label = "League",
            days = new[] { "tue" },
            start = "18:30",
            end = "21:00",
            startDate = first.ToString("yyyy-MM-dd"),
            endDate = first.AddDays(35).ToString("yyyy-MM-dd"),
            intervalWeeks = 1,
            courts = new[] { club.CourtId },
            effectiveFrom = from.ToString("yyyy-MM-dd"),
            reason = "Later start",
        });
        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);

        var rows = await LiveRowsAsync(Factory, club.TenantId);
        Assert.Equal(6, rows.Count);
        Assert.All(rows.GroupBy(r => r.ScheduleOccurrenceDate), g => Assert.Single(g));
        Assert.All(rows.Where(r => r.ScheduleOccurrenceDate < from), r => Assert.Equal(18, r.StartsAt.UtcDateTime.Hour));
        Assert.All(rows.Where(r => r.ScheduleOccurrenceDate >= from), r => Assert.Equal(30, r.StartsAt.UtcDateTime.Minute));

        var dates = (await client.GetFromJsonAsync<JsonElement>($"{Path}/{id}/occurrences"))
            .GetProperty("occurrences").EnumerateArray().ToList();
        var firstDate = dates.Single(d => d.GetProperty("date").GetString() == first.ToString("yyyy-MM-dd"));
        Assert.Equal("18:00", Clock(firstDate.GetProperty("starts_at")));
        // Wave B: a date before the change is read at the rule that governs IT — the old one.
        Assert.Equal("18:00", Clock(firstDate.GetProperty("rule_starts_at")));
        Assert.True(firstDate.GetProperty("on_rule").GetBoolean());
        Assert.Equal("18:00", Clock(firstDate.GetProperty("courts")[0].GetProperty("starts_at")));
        var laterDate = dates.Single(d => d.GetProperty("date").GetString() == from.ToString("yyyy-MM-dd"));
        Assert.Equal("18:30", Clock(laterDate.GetProperty("starts_at")));
        Assert.True(laterDate.GetProperty("on_rule").GetBoolean());

        var detail = (await client.GetFromJsonAsync<JsonElement>($"{Path}/{id}")).GetProperty("schedule");
        var next = detail.GetProperty("next_occurrence").GetDateTimeOffset();
        Assert.Equal(first, DateOnly.FromDateTime(next.UtcDateTime));
        Assert.Equal("18:00", next.ToUniversalTime().ToString("HH:mm"));

        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var record = await db.AdminChangeLogs.IgnoreQueryFilters()
            .SingleAsync(r => r.TenantId == club.TenantId && r.Action == AdminChangeActions.ScheduleUpdatedFuture);
        using var after = JsonDocument.Parse(record.AfterJson!);
        Assert.Equal(from.ToString("yyyy-MM-dd"), after.RootElement.GetProperty("effective_from").GetString());
        Assert.Equal(0, await db.AdminNotifications.IgnoreQueryFilters().CountAsync(n => n.TenantId == club.TenantId));
    }

    /// <summary>A day change from a date: the Tuesdays still held before it stay on the list.</summary>
    [SkippableFact]
    public async Task Dates_the_new_rule_no_longer_produces_but_are_still_held_stay_listed()
    {
        Skip.IfNot(pg.Available, Skipped);
        var (club, client, id, first) = await SeriesAsync("r4schday");
        var from = first.AddDays(14);

        var changed = await client.PatchAsJsonAsync($"{Path}/{id}", new
        {
            name = "Tuesday league",
            label = "League",
            days = new[] { "wed" },
            start = "18:00",
            end = "21:00",
            startDate = first.ToString("yyyy-MM-dd"),
            endDate = first.AddDays(35).ToString("yyyy-MM-dd"),
            intervalWeeks = 1,
            courts = new[] { club.CourtId },
            effectiveFrom = from.ToString("yyyy-MM-dd"),
            reason = "Moved to Wednesdays",
        });
        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);

        var listed = (await client.GetFromJsonAsync<JsonElement>($"{Path}/{id}/occurrences"))
            .GetProperty("occurrences").EnumerateArray()
            .Select(d => DateOnly.Parse(d.GetProperty("date").GetString()!)).ToList();
        Assert.Contains(first, listed);
        Assert.Contains(first.AddDays(7), listed);
        Assert.DoesNotContain(from, listed);
        Assert.Contains(from.AddDays(1), listed);
    }

    /// <summary>
    /// Ended from a future date (A4-10): still running until then — "active", its last date
    /// named, listed with the running ones, its nights before the date still held.
    /// </summary>
    [SkippableFact]
    public async Task A_series_ended_from_a_future_date_runs_until_then()
    {
        Skip.IfNot(pg.Available, Skipped);
        var (club, client, id, first) = await SeriesAsync("r4schend");
        var from = first.AddDays(14);

        var ended = await client.PostAsJsonAsync($"{Path}/{id}/end", new
        {
            effectiveFrom = from.ToString("yyyy-MM-dd"),
            reason = "Season ends early",
        });
        Assert.Equal(HttpStatusCode.OK, ended.StatusCode);
        Assert.Equal("active", (await ended.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());

        var detail = (await client.GetFromJsonAsync<JsonElement>($"{Path}/{id}")).GetProperty("schedule");
        Assert.Equal("active", detail.GetProperty("status").GetString());
        Assert.Equal(from.AddDays(-1).ToString("yyyy-MM-dd"), detail.GetProperty("end_date").GetString());
        Assert.Equal(first, DateOnly.FromDateTime(detail.GetProperty("next_occurrence").GetDateTimeOffset().UtcDateTime));

        var running = (await client.GetFromJsonAsync<JsonElement>(Path + "/")).GetProperty("schedules").EnumerateArray();
        Assert.Contains(running, s => s.GetProperty("id").GetGuid() == id);

        var rows = await LiveRowsAsync(Factory, club.TenantId);
        Assert.Equal([first, first.AddDays(7)], rows.Select(r => r.ScheduleOccurrenceDate!.Value).ToList());
    }

    /// <summary>A series whose last date is behind it reads ended, and is listed with the ended ones.</summary>
    [SkippableFact]
    public async Task A_series_past_its_last_date_reads_ended()
    {
        Skip.IfNot(pg.Available, Skipped);
        var (_, client, id, _) = await SeriesAsync("r4schold");

        using (var scope = Factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.BookingSchedules.IgnoreQueryFilters().SingleAsync(s => s.Id == id);
            row.EndDate = DateOnly.FromDateTime(DateTime.UtcNow.Date).AddDays(-1);
            await db.SaveChangesAsync();
        }

        var detail = (await client.GetFromJsonAsync<JsonElement>($"{Path}/{id}")).GetProperty("schedule");
        Assert.Equal("ended", detail.GetProperty("status").GetString());
        var endedList = (await client.GetFromJsonAsync<JsonElement>(Path + "/?status=ended")).GetProperty("schedules").EnumerateArray();
        Assert.Contains(endedList, s => s.GetProperty("id").GetGuid() == id);
    }
}
