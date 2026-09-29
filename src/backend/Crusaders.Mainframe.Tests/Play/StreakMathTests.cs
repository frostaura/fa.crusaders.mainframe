using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// The weekly streak's worked examples (<c>docs/specs/play.md</c> §5.4, A–D) as tables, and the
/// switches: rest weeks off (<c>K = 0</c>), pausing off (<c>Y = 0</c>), attendance inside a paused
/// week, and the current week never breaking a streak.
/// </summary>
public sealed class StreakMathTests
{
    private static readonly StreakRules Defaults = new(4, 2, 8);

    private static DateOnly D(string s) => DateOnly.Parse(s, System.Globalization.CultureInfo.InvariantCulture);

    private static HashSet<DateOnly> Weeks(params string[] mondays) => mondays.Select(D).ToHashSet();

    private static IEnumerable<DateOnly> Mondays(string from, int count) => Enumerable.Range(0, count).Select(i => D(from).AddDays(7 * i));

    /// <summary>Example A, week by week (the DST session is placed by <see cref="ClubWeekTests"/>).</summary>
    [Fact]
    public void Example_A_rest_weeks_and_a_pause_across_the_autumn_change()
    {
        var attended = Weeks("2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-12", "2026-10-19", "2026-10-26",
            "2026-11-02", "2026-12-07");
        var pause = StreakMath.PausedWeeks([(D("2026-11-11"), (DateOnly?)D("2026-11-20"))], attended, D("2026-12-07"), 8);
        Assert.Equal(Weeks("2026-11-09", "2026-11-16"), pause.Paused);
        Assert.Equal(2, pause.UsedIn(2026));

        var walk = StreakMath.Walk(attended, pause.Paused, D("2026-12-07"), Defaults);
        var expected = new (string Week, string State, int Streak)[]
        {
            ("2026-09-07", WeekStates.Attended, 1), ("2026-09-14", WeekStates.Attended, 2), ("2026-09-21", WeekStates.Attended, 3),
            ("2026-09-28", WeekStates.Attended, 4), ("2026-10-05", WeekStates.Rest, 4), ("2026-10-12", WeekStates.Attended, 5),
            ("2026-10-19", WeekStates.Attended, 6), ("2026-10-26", WeekStates.Attended, 7), ("2026-11-02", WeekStates.Attended, 8),
            ("2026-11-09", WeekStates.Paused, 8), ("2026-11-16", WeekStates.Paused, 8), ("2026-11-23", WeekStates.Rest, 8),
            ("2026-11-30", WeekStates.Missed, 0), ("2026-12-07", WeekStates.Attended, 1),
        };
        Assert.Equal(expected.Select(e => (D(e.Week), e.State, e.Streak)), walk.Weeks.Select(w => (w.Week, w.State, w.StreakAfter)));
        Assert.Equal(new StreakState(1, 8, 0), walk.State);
    }

    /// <summary>The bank after each week of example A — the table's own column.</summary>
    [Fact]
    public void Example_A_banks_one_rest_week_at_four_and_at_eight()
    {
        var s = StreakState.Empty;
        var banks = new List<int>();
        foreach (var (attended, paused) in new[] { (true, false), (true, false), (true, false), (true, false), (false, false), (true, false),
                     (true, false), (true, false), (true, false), (false, true), (false, true), (false, false), (false, false), (true, false) })
        {
            s = StreakMath.Step(s, attended, paused, false, Defaults).State;
            banks.Add(s.Bank);
        }
        Assert.Equal([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0], banks);
    }

    /// <summary>
    /// Example C: seven paused weeks already used in 2026, a pause from Wed 23 Dec: 12-21 is the
    /// eighth, 12-28 belongs to 2026 (its Monday's year) and is NOT paused, 2027-01-04 is 2027's first.
    /// </summary>
    [Fact]
    public void Example_C_the_allowance_belongs_to_the_Mondays_year()
    {
        var attended = new HashSet<DateOnly>();
        var pauses = new List<(DateOnly, DateOnly?)>
        {
            (D("2026-06-01"), D("2026-07-19")), // seven weeks: 06-01 … 07-13
            (D("2026-12-23"), null),
        };
        var coverage = StreakMath.PausedWeeks(pauses, attended, D("2027-01-04"), 8);
        Assert.Contains(D("2026-12-21"), coverage.Paused);
        Assert.DoesNotContain(D("2026-12-28"), coverage.Paused);
        Assert.Contains(D("2027-01-04"), coverage.Paused);
        Assert.Equal(8, coverage.UsedIn(2026));
        Assert.Equal(1, coverage.UsedIn(2027));
    }

    /// <summary>Example C's streak: a session on Sat 2 Jan 2027 and one on Mon 4 Jan are consecutive weeks.</summary>
    [Fact]
    public void Example_C_a_streak_continues_across_the_year_boundary()
    {
        var zone = TimeZoneInfo.FindSystemTimeZoneById("Europe/London");
        var saturday = ClubWeek.KeyOf(zone, DateTimeOffset.Parse("2027-01-02T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var monday = ClubWeek.KeyOf(zone, DateTimeOffset.Parse("2027-01-04T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var walk = StreakMath.Walk(new HashSet<DateOnly> { saturday, monday }, new HashSet<DateOnly>(), monday, Defaults);
        Assert.Equal(2, walk.State.Streak);
    }

    /// <summary>Example D: twelve straight weeks earn at 4, 8 and 12; the cap loses the third; rest, rest, broken.</summary>
    [Fact]
    public void Example_D_the_cap_loses_the_third_earn()
    {
        var attended = Mondays("2026-01-05", 12).ToHashSet();
        var current = D("2026-01-05").AddDays(7 * 15);
        var walk = StreakMath.Walk(attended, new HashSet<DateOnly>(), current, Defaults);
        var tail = walk.Weeks.Skip(12).Select(w => (w.State, w.StreakAfter)).ToList();
        Assert.Equal([(WeekStates.Rest, 12), (WeekStates.Rest, 12), (WeekStates.Missed, 0), (WeekStates.Pending, 0)], tail);
        Assert.Equal(12, walk.State.Longest);
    }

    [Fact]
    public void With_rest_weeks_off_a_single_missed_week_breaks_the_streak()
    {
        var attended = Mondays("2026-01-05", 8).ToHashSet();
        var walk = StreakMath.Walk(attended, new HashSet<DateOnly>(), D("2026-01-05").AddDays(7 * 9), Defaults with { RestCap = 0 });
        Assert.Equal(0, walk.State.Streak);
        Assert.Equal(0, walk.State.Bank);
        Assert.Equal(8, walk.State.Longest);
    }

    [Fact]
    public void With_pausing_off_no_week_is_paused()
    {
        var coverage = StreakMath.PausedWeeks([(D("2026-03-02"), (DateOnly?)null)], new HashSet<DateOnly>(), D("2026-04-06"), 0);
        Assert.Empty(coverage.Paused);
    }

    [Fact]
    public void A_week_attended_inside_a_pause_counts_as_attended_and_uses_no_allowance()
    {
        var attended = Weeks("2026-03-02", "2026-03-09", "2026-03-16");
        var coverage = StreakMath.PausedWeeks([(D("2026-03-09"), (DateOnly?)D("2026-03-23"))], attended, D("2026-03-23"), 8);
        Assert.Equal(Weeks("2026-03-23"), coverage.Paused);
        var walk = StreakMath.Walk(attended, coverage.Paused, D("2026-03-30"), Defaults);
        Assert.Equal(3, walk.State.Streak);
        Assert.Equal(WeekStates.Attended, walk.Weeks.Single(w => w.Week == D("2026-03-09")).State);
    }

    [Fact]
    public void The_current_week_never_breaks_a_streak_and_reads_pending()
    {
        var attended = Mondays("2026-01-05", 3).ToHashSet();
        var current = D("2026-01-26");
        var walk = StreakMath.Walk(attended, new HashSet<DateOnly>(), current, Defaults with { RestCap = 0 });
        Assert.Equal(3, walk.State.Streak);
        Assert.Equal(WeekStates.Pending, walk.Weeks[^1].State);

        // The next week, with nothing played in the one before: now it was judged.
        var later = StreakMath.Walk(attended, new HashSet<DateOnly>(), current.AddDays(7), Defaults with { RestCap = 0 });
        Assert.Equal(0, later.State.Streak);
    }

    [Fact]
    public void A_member_who_never_attended_walks_nothing()
    {
        var walk = StreakMath.Walk(new HashSet<DateOnly>(), new HashSet<DateOnly>(), D("2026-01-05"), Defaults);
        Assert.Equal(StreakState.Empty, walk.State);
        Assert.Empty(walk.Weeks);
        var strip = StreakMath.Strip(walk, new HashSet<DateOnly>(), D("2026-01-05"));
        Assert.Equal(12, strip.Count);
        Assert.Equal(WeekStates.Pending, strip[^1].State);
        Assert.All(strip.Take(11), w => Assert.Equal(WeekStates.Missed, w.State));
    }

    /// <summary>
    /// SPEC DEFECT, pinned (reported with P12): §5.2 claims adding an attended week anywhere never
    /// lowers the current streak. Under the capped, phase-dependent rest rule it can. X attends weeks
    /// 1–12, misses 13, attends 14, misses 15–16 and is broken; Y — identical but for missing week 1,
    /// which at streak 0 costs nothing — earns its third rest week at its 12th attended week (week 14)
    /// instead of losing it to the cap, and is still on a 12-week streak. This test states the rule
    /// as built so a change to it is a decision, not an accident.
    /// </summary>
    [Fact]
    public void An_extra_attended_week_can_lower_the_streak_under_the_capped_rest_rule()
    {
        var weeks = Mondays("2026-01-05", 16).ToList();
        var x = weeks.Take(12).Append(weeks[13]).ToHashSet();
        var y = weeks.Skip(1).Take(11).Append(weeks[13]).ToHashSet();
        var current = weeks[15].AddDays(7);

        Assert.Equal(0, StreakMath.Walk(x, new HashSet<DateOnly>(), current, Defaults).State.Streak);
        Assert.Equal(12, StreakMath.Walk(y, new HashSet<DateOnly>(), current, Defaults).State.Streak);
    }
}
