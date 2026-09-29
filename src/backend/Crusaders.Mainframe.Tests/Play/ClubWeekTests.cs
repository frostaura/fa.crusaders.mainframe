using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// Week keys (<c>docs/specs/play.md</c> §1, §5.2, §5.4 examples B and C): the Monday's club-local
/// date, DST- and year-safe by construction.
/// </summary>
public sealed class ClubWeekTests
{
    private static TimeZoneInfo Zone(string id) => TimeZoneInfo.FindSystemTimeZoneById(id);

    private static DateOnly D(string s) => DateOnly.Parse(s, System.Globalization.CultureInfo.InvariantCulture);

    private static DateTimeOffset At(string s) => DateTimeOffset.Parse(s, System.Globalization.CultureInfo.InvariantCulture);

    [Theory]
    // Example A: the clocks went back at 02:00 BST on Sun 25 Oct 2026; 23:30Z is Sunday 23:30 GMT.
    [InlineData("Europe/London", "2026-10-25T23:30:00Z", "2026-10-19")]
    [InlineData("Europe/London", "2026-10-26T00:30:00Z", "2026-10-26")]
    // Example B: 29 Mar 23:30Z is Monday 30 Mar 00:30 BST; 29 Mar 00:30Z is Sunday 00:30 GMT.
    [InlineData("Europe/London", "2026-03-29T23:30:00Z", "2026-03-30")]
    [InlineData("Europe/London", "2026-03-29T00:30:00Z", "2026-03-23")]
    // New York falls back on Sun 1 Nov 2026; 03:30Z Monday is Sunday 22:30 EST.
    [InlineData("America/New_York", "2026-11-02T03:30:00Z", "2026-10-26")]
    [InlineData("America/New_York", "2026-11-02T05:30:00Z", "2026-11-02")]
    // Lord Howe's half-hour DST (spring forward Sun 4 Oct 2026, +10:30 → +11): Monday 00:10 local.
    [InlineData("Australia/Lord_Howe", "2026-10-04T13:10:00Z", "2026-10-05")]
    [InlineData("Australia/Lord_Howe", "2026-10-04T12:50:00Z", "2026-09-28")]
    // Troll's two-hour shift (+00 → +02 on 29 Mar 2026): Sunday 23:30Z is Monday 01:30 local.
    [InlineData("Antarctica/Troll", "2026-03-29T23:30:00Z", "2026-03-30")]
    // Johannesburg has no DST: Sunday 22:30Z is Monday 00:30 SAST.
    [InlineData("Africa/Johannesburg", "2026-10-25T22:30:00Z", "2026-10-26")]
    [InlineData("UTC", "2026-10-25T23:59:59Z", "2026-10-19")]
    public void An_instant_belongs_to_the_week_of_its_club_local_date(string zone, string instant, string monday)
    {
        Assert.Equal(D(monday), ClubWeek.KeyOf(Zone(zone), At(instant)));
    }

    /// <summary>Example C: 2026's ISO week 53 runs Mon 28 Dec 2026 – Sun 3 Jan 2027, and it is one key.</summary>
    [Fact]
    public void The_week_that_straddles_the_new_year_is_one_week_and_is_followed_by_the_next()
    {
        Assert.Equal(D("2026-12-28"), ClubWeek.KeyOf(D("2027-01-02")));
        Assert.Equal(D("2026-12-28"), ClubWeek.KeyOf(D("2026-12-31")));
        Assert.Equal(D("2027-01-04"), ClubWeek.KeyOf(D("2027-01-04")));
        Assert.Equal(7, D("2027-01-04").DayNumber - ClubWeek.KeyOf(D("2027-01-02")).DayNumber);
        // Mon 29 Dec 2025 is ISO "2026-W01"; its key is its own Monday, in 2025.
        Assert.Equal(D("2025-12-29"), ClubWeek.KeyOf(D("2025-12-31")));
        Assert.Equal(2026, ClubWeek.YearOf(ClubWeek.KeyOf(D("2027-01-03"))));
    }

    [Fact]
    public void Every_key_is_a_Monday_and_every_date_is_zero_to_six_days_after_its_key()
    {
        for (var d = D("2024-01-01"); d <= D("2028-12-31"); d = d.AddDays(1))
        {
            var key = ClubWeek.KeyOf(d);
            Assert.Equal(DayOfWeek.Monday, key.DayOfWeek);
            Assert.InRange(d.DayNumber - key.DayNumber, 0, 6);
        }
    }

    [Theory]
    [InlineData("Europe/London")]
    [InlineData("America/New_York")]
    [InlineData("Australia/Lord_Howe")]
    [InlineData("Antarctica/Troll")]
    [InlineData("Africa/Johannesburg")]
    [InlineData("UTC")]
    public void Every_hour_of_two_years_lands_in_the_week_of_its_local_date(string zoneId)
    {
        var zone = Zone(zoneId);
        for (var t = At("2026-01-01T00:00:00Z"); t < At("2028-01-01T00:00:00Z"); t = t.AddMinutes(30))
        {
            var local = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(t, zone).DateTime);
            Assert.Equal(ClubWeek.KeyOf(local), ClubWeek.KeyOf(zone, t));
        }
    }

    [Fact]
    public void A_session_crossing_midnight_on_the_last_day_belongs_to_the_month_it_started()
    {
        Assert.Equal("2026-09", ClubWeek.MonthOf(Zone("Africa/Johannesburg"), At("2026-09-30T21:30:00Z")));
        Assert.Equal("2026-10", ClubWeek.MonthOf(Zone("Africa/Johannesburg"), At("2026-09-30T22:30:00Z")));
    }
}
