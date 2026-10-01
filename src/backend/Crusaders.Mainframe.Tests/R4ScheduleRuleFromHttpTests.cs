using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 4 wave B, the A4-3 remainder: a repeating booking changed "from this date on"
/// keeps its OLD rule — days, hours and interval — for every date before that date.
///
/// <para>
/// B2 kept the earlier dates' HOURS by keying "already held" on the date, but the rule itself had
/// no "governs from" field: a change of DAY materialised the new days between today and the
/// effective date, booking courts the club never asked for. The schedule now carries the rules it
/// replaced (<c>EarlierRulesJson</c>), each with the date it stopped governing. The club is UTC
/// (<see cref="DoorClub.DefaultSettings"/>), so "18:00" is asserted directly.
/// </para>
/// </summary>
public sealed class R4ScheduleRuleFromHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string Path = "/api/v1/admin/schedules";

    private TestWebAppFactory Factory => pg.SharedHost;

    private static DateOnly NextTuesday()
    {
        var day = DateOnly.FromDateTime(DateTime.UtcNow.Date).AddDays(7);
        while (day.DayOfWeek != DayOfWeek.Tuesday) day = day.AddDays(1);
        return day;
    }

    private static object Rule(DoorClub club, DateOnly first, string[] days, string start, DateOnly? from = null)
        => new
        {
            name = "League",
            label = "League",
            days,
            start,
            end = "21:00",
            startDate = first.ToString("yyyy-MM-dd"),
            endDate = first.AddDays(41).ToString("yyyy-MM-dd"),
            intervalWeeks = 1,
            courts = new[] { club.CourtId },
            effectiveFrom = from?.ToString("yyyy-MM-dd"),
            reason = "Changed",
        };

    private async Task<(DoorClub Club, HttpClient Client, Guid Id, DateOnly First)> TuesdaysAsync(string prefix)
    {
        var club = await DoorClub.SeedAsync(Factory, prefix, DoorClub.DefaultSettings);
        var client = club.AdminClient(Factory);
        var first = NextTuesday();
        var created = await client.PostAsJsonAsync(Path + "/", Rule(club, first, ["tue"], "18:00"));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("schedule").GetProperty("id").GetGuid();
        return (club, client, id, first);
    }

    private async Task<List<(DateOnly Date, string Clock)>> HeldAsync(Guid tenantId)
    {
        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var rows = await db.Bookings.IgnoreQueryFilters()
            .Where(b => b.TenantId == tenantId && b.ScheduleId != null && b.Status != BookingStatus.Cancelled)
            .OrderBy(b => b.StartsAt)
            .ToListAsync();
        return [.. rows.Select(b => (b.ScheduleOccurrenceDate!.Value, b.StartsAt.UtcDateTime.ToString("HH:mm")))];
    }

    /// <summary>
    /// Tuesdays become Wednesdays from the third week: no Wednesday before that date is held or
    /// listed, the two Tuesdays before it stay held at 18:00, and every Wednesday from it is held.
    /// </summary>
    [SkippableFact]
    public async Task A_day_change_from_a_future_date_books_no_new_day_before_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        var (club, client, id, first) = await TuesdaysAsync("r4rfday");
        var from = first.AddDays(14);

        var changed = await client.PatchAsJsonAsync($"{Path}/{id}", Rule(club, first, ["wed"], "18:00", from));
        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);

        var held = await HeldAsync(club.TenantId);
        Assert.DoesNotContain(held, h => h.Date < from && h.Date.DayOfWeek == DayOfWeek.Wednesday);
        Assert.Equal([first, first.AddDays(7)], held.Where(h => h.Date < from).Select(h => h.Date).ToList());
        Assert.All(held.Where(h => h.Date < from), h => Assert.Equal("18:00", h.Clock));
        Assert.Equal(
            [from.AddDays(1), from.AddDays(8), from.AddDays(15), from.AddDays(22)],
            held.Where(h => h.Date >= from).Select(h => h.Date).ToList());

        var listed = (await client.GetFromJsonAsync<JsonElement>($"{Path}/{id}/occurrences"))
            .GetProperty("occurrences").EnumerateArray()
            .Select(d => DateOnly.Parse(d.GetProperty("date").GetString()!)).ToList();
        Assert.DoesNotContain(listed, d => d < from && d.DayOfWeek == DayOfWeek.Wednesday);
    }

    /// <summary>
    /// The dates before the change are read at the rule that governs THEM: on the list, a Tuesday
    /// before the date is on its (old) rule at 18:00, and the series' next night is that Tuesday.
    /// </summary>
    [SkippableFact]
    public async Task A_date_before_the_change_is_on_the_rule_that_governs_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        var (club, client, id, first) = await TuesdaysAsync("r4rfrule");
        var from = first.AddDays(14);

        var changed = await client.PatchAsJsonAsync($"{Path}/{id}", Rule(club, first, ["tue"], "18:30", from));
        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);

        var dates = (await client.GetFromJsonAsync<JsonElement>($"{Path}/{id}/occurrences"))
            .GetProperty("occurrences").EnumerateArray().ToList();
        var early = dates.Single(d => d.GetProperty("date").GetString() == first.ToString("yyyy-MM-dd"));
        Assert.Equal("18:00", early.GetProperty("rule_starts_at").GetDateTimeOffset().UtcDateTime.ToString("HH:mm"));
        Assert.True(early.GetProperty("on_rule").GetBoolean());
        var late = dates.Single(d => d.GetProperty("date").GetString() == from.ToString("yyyy-MM-dd"));
        Assert.Equal("18:30", late.GetProperty("starts_at").GetDateTimeOffset().UtcDateTime.ToString("HH:mm"));
    }

    /// <summary>
    /// Two changes waiting at once — days from week three, then hours from week four — each date
    /// is held at the rule in force on it: Tuesdays 18:00, then Wednesdays 18:00, then 19:00.
    /// </summary>
    [SkippableFact]
    public async Task Two_waiting_changes_each_govern_their_own_dates()
    {
        Skip.IfNot(pg.Available, Skipped);
        var (club, client, id, first) = await TuesdaysAsync("r4rftwo");
        var days = first.AddDays(14);
        var hours = first.AddDays(21);

        Assert.Equal(HttpStatusCode.OK, (await client.PatchAsJsonAsync($"{Path}/{id}", Rule(club, first, ["wed"], "18:00", days))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PatchAsJsonAsync($"{Path}/{id}", Rule(club, first, ["wed"], "19:00", hours))).StatusCode);

        var held = await HeldAsync(club.TenantId);
        Assert.Equal(
            [
                (first, "18:00"), (first.AddDays(7), "18:00"),
                (days.AddDays(1), "18:00"),
                (hours.AddDays(1), "19:00"), (hours.AddDays(8), "19:00"), (hours.AddDays(15), "19:00"),
            ],
            held);
    }

    /// <summary>
    /// A later change that starts EARLIER than one already waiting replaces it from its own date:
    /// days from week four, then hours from week two — Tuesdays 18:00 for one week, then 19:00
    /// Wednesdays, and the waiting Tuesday-to-Wednesday change no longer holds week two and three
    /// at 18:00.
    /// </summary>
    [SkippableFact]
    public async Task An_earlier_change_supersedes_a_waiting_one_from_its_own_date()
    {
        Skip.IfNot(pg.Available, Skipped);
        var (club, client, id, first) = await TuesdaysAsync("r4rfearly");
        var later = first.AddDays(21);
        var earlier = first.AddDays(7);

        Assert.Equal(HttpStatusCode.OK, (await client.PatchAsJsonAsync($"{Path}/{id}", Rule(club, first, ["wed"], "18:00", later))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PatchAsJsonAsync($"{Path}/{id}", Rule(club, first, ["wed"], "19:00", earlier))).StatusCode);

        var held = await HeldAsync(club.TenantId);
        Assert.Equal((first, "18:00"), held[0]);
        Assert.All(held.Skip(1), h => Assert.Equal(DayOfWeek.Wednesday, h.Date.DayOfWeek));
        Assert.All(held.Skip(1), h => Assert.Equal("19:00", h.Clock));
        Assert.Equal(earlier.AddDays(1), held[1].Date);
    }
}
