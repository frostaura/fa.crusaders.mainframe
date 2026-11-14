using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 3, A-1: "this and every one after" and "end the series" with a FUTURE effective
/// date both 500'd — <c>ScheduleClock.InstantAt</c> carries the club's own offset, and Npgsql
/// refuses a non-zero offset on a <c>timestamptz</c> parameter
/// (<c>memory/gotchas-postgres-offsets.md</c>). Every other schedule test runs a UTC club, where
/// the offset is zero and the bug cannot be seen; a past or today's date is clamped to
/// <c>UtcNow</c> first, which hid it too. So this class runs in Johannesburg (+02:00 all year)
/// and asks for a date two weeks out.
///
/// <para>
/// The same audit found the admin quote's query-string <c>startsAt</c> keeping the offset it was
/// sent with — a console in the club's zone sends exactly that — and refusing the same way.
/// </para>
/// </summary>
public sealed class R3ClubLocalInstantHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string Path = "/api/v1/admin/schedules";

    private const string JohannesburgSettings =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"Africa/Johannesburg","heartbeat_seconds":45}""";

    private static readonly TimeZoneInfo Johannesburg = TimeZoneInfo.FindSystemTimeZoneById("Africa/Johannesburg");

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static DateOnly NextTuesday(int weeksAhead)
    {
        var day = DateOnly.FromDateTime(DateTime.UtcNow.Date).AddDays(weeksAhead * 7);
        while (day.DayOfWeek != DayOfWeek.Tuesday) day = day.AddDays(1);
        return day;
    }

    private static object Rule(DoorClub club, DateOnly from, string start = "18:00", string? reason = null) => new
    {
        name = "Tuesday league",
        label = "League",
        days = new[] { "tue" },
        start,
        end = "21:00",
        startDate = from.ToString("yyyy-MM-dd"),
        endDate = from.AddDays(35).ToString("yyyy-MM-dd"),
        intervalWeeks = 1,
        courts = new[] { club.CourtId },
        reason,
    };

    private static async Task<Guid> CreateAsync(HttpClient client, DoorClub club, DateOnly from)
    {
        var created = await client.PostAsJsonAsync(Path, Rule(club, from));
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
        return (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("schedule").GetProperty("id").GetGuid();
    }

    private static async Task<List<Booking>> RowsAsync(TestWebAppFactory factory, Guid scheduleId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.Bookings.IgnoreQueryFilters().AsNoTracking()
            .Where(b => b.ScheduleId == scheduleId).OrderBy(b => b.StartsAt).ToListAsync();
    }

    private static DateOnly LocalDate(DateTimeOffset at) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(at, Johannesburg).DateTime);

    [SkippableFact]
    public async Task This_and_every_one_after_from_a_future_date_keeps_the_dates_before_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3a1edit", JohannesburgSettings);
        var client = club.AdminClient(factory);
        var from = NextTuesday(1);
        var id = await CreateAsync(client, club, from);
        var effective = from.AddDays(14);

        var response = await client.PatchAsJsonAsync($"{Path}/{id}", new
        {
            name = "Tuesday league",
            label = "League",
            days = new[] { "tue" },
            start = "18:30",
            end = "21:00",
            startDate = from.ToString("yyyy-MM-dd"),
            endDate = from.AddDays(35).ToString("yyyy-MM-dd"),
            intervalWeeks = 1,
            courts = new[] { club.CourtId },
            reason = "later start",
            effectiveFrom = effective.ToString("yyyy-MM-dd"),
        });

        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(effective.ToString("yyyy-MM-dd"), body.GetProperty("effective_from").GetString());

        var rows = await RowsAsync(factory, id);
        // The two dates before the effective date are untouched, still live at 18:00 club time.
        var before = rows.Where(r => LocalDate(r.StartsAt) < effective).ToList();
        Assert.Equal(2, before.Count);
        Assert.All(before, r =>
        {
            Assert.Equal(BookingStatus.AdminBlock, r.Status);
            Assert.Equal(18, TimeZoneInfo.ConvertTime(r.StartsAt, Johannesburg).Hour);
        });
        // From the effective date on, the old 18:00 rows are cancelled and 18:30 rows written.
        var liveAfter = rows.Where(r => LocalDate(r.StartsAt) >= effective && r.Status == BookingStatus.AdminBlock).ToList();
        Assert.NotEmpty(liveAfter);
        Assert.All(liveAfter, r => Assert.Equal(30, TimeZoneInfo.ConvertTime(r.StartsAt, Johannesburg).Minute));
    }

    [SkippableFact]
    public async Task Ending_a_series_from_a_future_date_cancels_only_the_dates_from_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3a1end", JohannesburgSettings);
        var client = club.AdminClient(factory);
        var from = NextTuesday(1);
        var id = await CreateAsync(client, club, from);
        var effective = from.AddDays(14);

        var response = await client.PostAsJsonAsync($"{Path}/{id}/end", new
        {
            effectiveFrom = effective.ToString("yyyy-MM-dd"),
            reason = "Season ends early",
        });

        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(effective.AddDays(-1).ToString("yyyy-MM-dd"), body.GetProperty("end_date").GetString());

        var rows = await RowsAsync(factory, id);
        Assert.All(rows.Where(r => LocalDate(r.StartsAt) < effective), r => Assert.Equal(BookingStatus.AdminBlock, r.Status));
        var fromEffective = rows.Where(r => LocalDate(r.StartsAt) >= effective).ToList();
        Assert.NotEmpty(fromEffective);
        Assert.All(fromEffective, r => Assert.Equal(BookingStatus.Cancelled, r.Status));
        Assert.Equal(fromEffective.Count, body.GetProperty("occurrences_cancelled").GetInt32());
    }

    [SkippableFact]
    public async Task The_admin_quote_accepts_a_start_sent_in_the_clubs_own_offset()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3a1quote", JohannesburgSettings);
        var client = club.AdminClient(factory);
        var day = DateTime.UtcNow.Date.AddDays(2);
        var local = new DateTimeOffset(day.Year, day.Month, day.Day, 10, 0, 0, TimeSpan.FromHours(2));

        var response = await client.GetAsync(
            $"/api/v1/admin/bookings/quote?courtId={club.CourtId}&startsAt={Uri.EscapeDataString(local.ToString("o"))}&slices=4");

        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(local.UtcDateTime, body.GetProperty("starts_at").GetDateTimeOffset().UtcDateTime);
    }
}
