using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Which rule governs which date once a schedule has been changed "from a date" (review round 4
/// wave B, the A4-3 remainder) — pure, so the far-future case is cheap: a date past the
/// materialisation horizon has no held row to keep it at its old rule, and is read at the rule
/// in force on it or not at all.
/// </summary>
public sealed class ScheduleRuleHistoryTests
{
    private const int Tue = 1 << (int)DayOfWeek.Tuesday;
    private const int Wed = 1 << (int)DayOfWeek.Wednesday;
    private static readonly TimeZoneInfo Utc = TimeZoneInfo.Utc;

    private static BookingSchedule Series(int days = Tue, int start = 18 * 60) => new()
    {
        Name = "League",
        Label = "League",
        DaysOfWeek = days,
        StartMinute = start,
        EndMinute = 21 * 60,
        StartDate = new DateOnly(2026, 10, 6),
        IntervalWeeks = 1,
    };

    /// <summary>The change the endpoint makes: keep the replaced rule, then apply the new one.</summary>
    private static void Change(BookingSchedule s, DateOnly from, int days, int start)
    {
        s.EarlierRulesJson = ScheduleRuleHistory.Store(ScheduleRuleHistory.Supersede(s, from));
        s.DaysOfWeek = days;
        s.StartMinute = start;
    }

    private static List<(DateOnly Date, string Clock)> Dates(BookingSchedule s, DateOnly from, DateOnly to)
        => [.. ScheduleOccurrences.Expand(s, [], Utc, from, to).Select(o => (o.Date, o.StartsAt.ToString("HH:mm")))];

    [Fact]
    public void Dates_far_ahead_of_the_change_keep_the_old_days_and_hours_until_it()
    {
        var s = Series();
        var from = new DateOnly(2027, 3, 2);
        Change(s, from, Wed, 19 * 60);

        var before = Dates(s, new DateOnly(2027, 2, 14), from.AddDays(-1));
        Assert.Equal([(new DateOnly(2027, 2, 16), "18:00"), (new DateOnly(2027, 2, 23), "18:00")], before);

        var after = Dates(s, from, from.AddDays(13));
        Assert.Equal([(new DateOnly(2027, 3, 3), "19:00"), (new DateOnly(2027, 3, 10), "19:00")], after);
    }

    [Fact]
    public void A_series_never_changed_from_a_date_stores_nothing_and_reads_its_own_rule()
    {
        var s = Series();
        Assert.Null(s.EarlierRulesJson);
        Assert.Empty(ScheduleRuleHistory.Earlier(s));
        Assert.Equal(ScheduleRuleHistory.Current(s), ScheduleRuleHistory.For(s, new DateOnly(2026, 10, 6)));
    }

    [Fact]
    public void Two_waiting_changes_are_kept_in_order()
    {
        var s = Series();
        Change(s, new DateOnly(2026, 11, 3), Wed, 18 * 60);
        Change(s, new DateOnly(2026, 11, 17), Wed, 19 * 60);

        var kept = ScheduleRuleHistory.Earlier(s);
        Assert.Equal([new DateOnly(2026, 11, 3), new DateOnly(2026, 11, 17)], kept.Select(r => r.Until).ToList());
        Assert.Equal([Tue, Wed], kept.Select(r => r.DaysOfWeek).ToList());
    }

    /// <summary>
    /// A change that starts before one already waiting cuts it back to its own date; the waiting
    /// rule, which governed nothing before that date, is not kept at all.
    /// </summary>
    [Fact]
    public void A_change_earlier_than_a_waiting_one_cuts_it_back()
    {
        var s = Series();
        Change(s, new DateOnly(2026, 11, 17), Wed, 18 * 60);
        Change(s, new DateOnly(2026, 10, 20), Wed, 19 * 60);

        var kept = Assert.Single(ScheduleRuleHistory.Earlier(s));
        Assert.Equal(new DateOnly(2026, 10, 20), kept.Until);
        Assert.Equal(Tue, kept.DaysOfWeek);

        Assert.Equal(
            [(new DateOnly(2026, 10, 13), "18:00"), (new DateOnly(2026, 10, 21), "19:00"), (new DateOnly(2026, 11, 18), "19:00")],
            Dates(s, new DateOnly(2026, 10, 13), new DateOnly(2026, 11, 18)).Where(d => d.Date.Day is 13 or 21 or 18).ToList());
    }

    /// <summary>A change from the same date as the last one replaces it rather than keeping an empty rule.</summary>
    [Fact]
    public void A_second_change_from_the_same_date_keeps_no_empty_rule()
    {
        var s = Series();
        var from = new DateOnly(2026, 11, 3);
        Change(s, from, Wed, 18 * 60);
        Change(s, from, Wed, 19 * 60);

        var kept = Assert.Single(ScheduleRuleHistory.Earlier(s));
        Assert.Equal(Tue, kept.DaysOfWeek);
        Assert.Equal(from, kept.Until);
    }
}
