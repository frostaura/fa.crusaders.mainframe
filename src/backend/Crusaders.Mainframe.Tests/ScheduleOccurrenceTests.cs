using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The recurrence arithmetic: which dates a schedule falls on, and at which instant.
///
/// <para>
/// <b>Three clubs, not one, and that is the point of the file.</b> Every fixture club in this
/// repository runs <c>"timezone":"UTC"</c>, where a DST bug cannot be seen — the lesson
/// <c>memory/gotchas-postgres-offsets.md</c> records from the doors lane, arriving here from the
/// other direction. A league night is a weekly series that runs for a season, so it crosses a
/// transition roughly every third season; the failure is silent (the rows are written, the
/// courts are reserved) and league starts an hour late.
/// </para>
///
/// <para>
/// The DST cases assert an INVARIANT rather than a date: every occurrence reads 18:00 on the
/// club's own wall clock, and the range genuinely contains a transition. That second assertion
/// is what stops the test quietly becoming vacuous if a zone's rules change under it.
/// </para>
/// </summary>
public sealed class ScheduleOccurrenceTests
{
    private const string Dst = "America/Santiago";          // South of the equator, DST, UTC−3/−4.
    private const string WestOfUtc = "America/Chicago";     // North, DST, UTC−5/−6.
    private const string NoDst = "Africa/Johannesburg";     // The club this product was built for.

    private static TimeZoneInfo Zone(string id) => TimeZoneInfo.FindSystemTimeZoneById(id);

    private static BookingSchedule Rule(
        int days = 1 << (int)DayOfWeek.Tuesday,
        int start = 18 * 60,
        int end = 21 * 60,
        string from = "2026-10-06",
        string? to = "2026-12-16",
        short interval = 1)
        => new()
        {
            Name = "Tuesday league",
            Label = "League — Div 1",
            DaysOfWeek = days,
            StartMinute = start,
            EndMinute = end,
            StartDate = DateOnly.Parse(from),
            EndDate = to is null ? null : DateOnly.Parse(to),
            IntervalWeeks = interval,
        };

    private static List<ScheduleOccurrence> Expand(
        BookingSchedule rule, string zone, string from, string to,
        params BookingScheduleException[] exceptions)
        => ScheduleOccurrences.Expand(
            rule, exceptions, Zone(zone), DateOnly.Parse(from), DateOnly.Parse(to)).ToList();

    // ------------------------------------------------------------------ the weekly rule

    /// <summary>
    /// A schedule on Tuesdays produces Tuesdays, and nothing else. The first thing a club
    /// would notice, and the first thing a bitmask read with the wrong shift gets wrong.
    /// </summary>
    [Fact]
    public void A_weekly_rule_produces_only_the_weekdays_it_names()
    {
        var occurrences = Expand(Rule(), NoDst, "2026-10-01", "2026-11-01");

        Assert.NotEmpty(occurrences);
        Assert.All(occurrences, o => Assert.Equal(DayOfWeek.Tuesday, o.Date.DayOfWeek));
        Assert.Equal(DateOnly.Parse("2026-10-06"), occurrences[0].Date);
    }

    /// <summary>Two weekdays in one mask are both produced, interleaved in date order.</summary>
    [Fact]
    public void A_mask_naming_two_days_produces_both_in_date_order()
    {
        var mask = (1 << (int)DayOfWeek.Tuesday) | (1 << (int)DayOfWeek.Thursday);
        var occurrences = Expand(Rule(days: mask), NoDst, "2026-10-01", "2026-10-15");

        Assert.Equal(
            [DayOfWeek.Tuesday, DayOfWeek.Thursday, DayOfWeek.Tuesday, DayOfWeek.Thursday],
            occurrences.Select(o => o.Date.DayOfWeek));
        Assert.Equal(occurrences.Select(o => o.Date).OrderBy(d => d), occurrences.Select(o => o.Date));
    }

    /// <summary>
    /// "Every other Tuesday" is anchored on the start date's own week, so the first
    /// occurrence is always the start date's week and the gaps are exactly a fortnight.
    ///
    /// <para>
    /// An implementation anchored on the WINDOW instead — which is the easy mistake, because
    /// the window is the loop's own bound — gives a different series for every screen that asks,
    /// and an admin re-opening the page in November sees a league night on the wrong Tuesdays.
    /// </para>
    /// </summary>
    [Fact]
    public void An_interval_of_two_weeks_anchors_on_the_start_dates_own_week()
    {
        var rule = Rule(from: "2026-10-06", to: "2026-12-16", interval: 2);

        // Asked from a window that begins mid-series, the answer must still be the series the
        // start date defines — not "every other Tuesday counted from 1 November".
        var fromStart = Expand(rule, NoDst, "2026-10-01", "2026-12-31").Select(o => o.Date).ToList();

        Assert.Equal(DateOnly.Parse("2026-10-06"), fromStart[0]);
        Assert.All(fromStart.Zip(fromStart.Skip(1)), p => Assert.Equal(14, p.Second.DayNumber - p.First.DayNumber));

        // Every later window start, not one — and that is the fix to this test, not a
        // flourish.
        //
        // It used to ask from 2026-11-01 alone, which is exactly FOUR weeks after the start
        // date's own Sunday. An implementation anchored on the window instead of on the start
        // date therefore agreed with the correct one by arithmetic accident, and the test was
        // green over a real defect. The odd-numbered offsets below are the ones that disagree;
        // sweeping them all is what makes the assertion about the RULE rather than about one
        // lucky date.
        foreach (var offset in Enumerable.Range(0, 10))
        {
            var windowOpens = DateOnly.Parse("2026-10-01").AddDays(offset * 7);
            var fromLater = Expand(rule, NoDst, windowOpens.ToString("yyyy-MM-dd"), "2026-12-31")
                .Select(o => o.Date).ToList();

            Assert.Equal(fromStart.Where(d => d >= windowOpens), fromLater);
        }
    }

    /// <summary>An interval of one is every week — the degenerate case the modulo must not drop.</summary>
    [Fact]
    public void An_interval_of_one_week_skips_nothing()
    {
        var dates = Expand(Rule(interval: 1), NoDst, "2026-10-01", "2026-11-30").Select(o => o.Date).ToList();
        Assert.All(dates.Zip(dates.Skip(1)), p => Assert.Equal(7, p.Second.DayNumber - p.First.DayNumber));
    }

    /// <summary>The end date is inclusive — a season "until 15 December" includes 15 December.</summary>
    [Fact]
    public void The_end_date_is_inclusive()
    {
        var rule = Rule(from: "2026-10-06", to: "2026-12-15");
        var dates = Expand(rule, NoDst, "2026-10-01", "2026-12-31").Select(o => o.Date).ToList();
        Assert.Equal(DateOnly.Parse("2026-12-15"), dates[^1]);
    }

    /// <summary>An open-ended series runs to the window's end and no further.</summary>
    [Fact]
    public void An_open_ended_series_is_bounded_only_by_the_window()
    {
        var dates = Expand(Rule(to: null), NoDst, "2026-10-01", "2026-10-31").Select(o => o.Date).ToList();
        Assert.Equal(DateOnly.Parse("2026-10-06"), dates[0]);
        Assert.Equal(DateOnly.Parse("2026-10-27"), dates[^1]);
    }

    /// <summary>Nothing is produced before the start date, whatever the window asks for.</summary>
    [Fact]
    public void Nothing_is_produced_before_the_start_date()
    {
        var dates = Expand(Rule(from: "2026-10-20"), NoDst, "2026-09-01", "2026-11-01").Select(o => o.Date);
        Assert.All(dates, d => Assert.True(d >= DateOnly.Parse("2026-10-20")));
    }

    // ------------------------------------------------------------------ the instants

    /// <summary>
    /// The start and end instants read as the rule's own wall-clock times in the club's zone,
    /// and the occurrence's date is the club-local date of its start.
    /// </summary>
    [Fact]
    public void An_occurrence_starts_and_ends_at_the_rules_own_wall_clock_times()
    {
        var zone = Zone(NoDst);
        foreach (var occurrence in Expand(Rule(), NoDst, "2026-10-01", "2026-12-31"))
        {
            var start = TimeZoneInfo.ConvertTime(occurrence.StartsAt, zone);
            var end = TimeZoneInfo.ConvertTime(occurrence.EndsAt, zone);
            Assert.Equal(new TimeSpan(18, 0, 0), start.TimeOfDay);
            Assert.Equal(new TimeSpan(21, 0, 0), end.TimeOfDay);
            Assert.Equal(occurrence.Date, DoorClock.LocalDateOf(zone, occurrence.StartsAt));
        }
    }

    /// <summary>An end of 1440 is the next local midnight, not 00:00 on the same date.</summary>
    [Fact]
    public void An_end_minute_of_1440_is_the_next_local_midnight()
    {
        var rule = Rule(start: 22 * 60, end: 1440);
        var occurrence = Expand(rule, NoDst, "2026-10-01", "2026-10-10")[0];

        Assert.Equal(
            DoorClock.StartOfLocalDay(Zone(NoDst), occurrence.Date.AddDays(1)),
            occurrence.EndsAt);
        Assert.Equal(TimeSpan.FromHours(2), occurrence.EndsAt - occurrence.StartsAt);
    }

    // ------------------------------------------------------------------ DST

    /// <summary>
    /// A DST club's league night stays at 18:00 local on every date of the year, through both
    /// transitions.
    ///
    /// <para>
    /// This is the case <c>StartOfLocalDay(d).AddMinutes(1080)</c> gets wrong, and the only one:
    /// on every other day of the year the two agree exactly, which is why a suite of UTC
    /// fixtures could carry the defect indefinitely.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(Dst)]
    [InlineData(WestOfUtc)]
    [InlineData(NoDst)]
    public void A_league_night_keeps_its_local_time_across_a_whole_year(string zoneId)
    {
        var zone = Zone(zoneId);
        var rule = Rule(days: BookingSchedule.AllDays, from: "2026-01-01", to: "2026-12-31");
        var occurrences = Expand(rule, zoneId, "2026-01-01", "2026-12-31");

        Assert.Equal(365, occurrences.Count);
        Assert.All(occurrences, o =>
        {
            Assert.Equal(new TimeSpan(18, 0, 0), TimeZoneInfo.ConvertTime(o.StartsAt, zone).TimeOfDay);
            Assert.Equal(new TimeSpan(21, 0, 0), TimeZoneInfo.ConvertTime(o.EndsAt, zone).TimeOfDay);
            Assert.Equal(o.Date, DoorClock.LocalDateOf(zone, o.StartsAt));
        });
    }

    /// <summary>
    /// And the two DST clubs really do change offset inside that year, so the assertion above
    /// is not quietly vacuous.
    ///
    /// <para>
    /// Without this the whole DST case degrades silently the day a zone's rules change or a
    /// zone id is mistyped into one that has no transition — a green test proving nothing,
    /// which is the shape <c>memory/gotchas.md</c> is about.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(Dst, 2)]
    [InlineData(WestOfUtc, 2)]
    [InlineData(NoDst, 1)]
    public void The_fixture_clubs_are_the_clubs_the_case_needs(string zoneId, int distinctOffsets)
    {
        var rule = Rule(days: BookingSchedule.AllDays, from: "2026-01-01", to: "2026-12-31");
        var offsets = Expand(rule, zoneId, "2026-01-01", "2026-12-31")
            .Select(o => o.StartsAt.Offset).Distinct().ToList();

        Assert.Equal(distinctOffsets, offsets.Count);
        if (zoneId != NoDst) Assert.All(offsets, o => Assert.True(o < TimeSpan.Zero, $"{zoneId} should be west of UTC"));
    }

    /// <summary>An occurrence is the same length however the clocks move under it, except across a transition.</summary>
    [Fact]
    public void An_occurrence_is_three_hours_long_on_every_ordinary_day_of_a_dst_clubs_year()
    {
        var rule = Rule(days: BookingSchedule.AllDays, from: "2026-01-01", to: "2026-12-31");
        var lengths = Expand(rule, Dst, "2026-01-01", "2026-12-31")
            .Select(o => o.EndsAt - o.StartsAt).ToList();

        // 18:00–21:00 is three wall-clock hours; a transition at 24:00 (Chile's) never falls
        // inside it, so every single day is exactly three hours of real time.
        Assert.All(lengths, l => Assert.Equal(TimeSpan.FromHours(3), l));
    }

    // ------------------------------------------------------------------ exceptions

    /// <summary>A skipped date is reported as skipped — a screen has to be able to say so — and never scheduled.</summary>
    [Fact]
    public void A_skipped_date_is_reported_and_is_never_scheduled()
    {
        var skipped = DateOnly.Parse("2026-10-13");
        var occurrences = Expand(Rule(), NoDst, "2026-10-01", "2026-11-01", new BookingScheduleException
        {
            OccurrenceDate = skipped,
            Kind = ScheduleExceptionKind.Skipped,
            Reason = "Public holiday",
        });

        var row = Assert.Single(occurrences, o => o.Date == skipped);
        Assert.Equal(ScheduleOccurrenceStatus.Skipped, row.Status);
        Assert.All(occurrences.Where(o => o.Date != skipped),
            o => Assert.Equal(ScheduleOccurrenceStatus.Scheduled, o.Status));
    }

    /// <summary>An overridden date takes the exception's times, and only that date does.</summary>
    [Fact]
    public void An_overridden_date_takes_the_exceptions_times()
    {
        var moved = DateOnly.Parse("2026-10-20");
        var zone = Zone(NoDst);
        var occurrences = Expand(Rule(), NoDst, "2026-10-01", "2026-11-01", new BookingScheduleException
        {
            OccurrenceDate = moved,
            Kind = ScheduleExceptionKind.Overridden,
            StartMinute = 19 * 60,
            EndMinute = (21 * 60) + 30,
        });

        var row = Assert.Single(occurrences, o => o.Date == moved);
        Assert.Equal(ScheduleOccurrenceStatus.Overridden, row.Status);
        Assert.Equal(new TimeSpan(19, 0, 0), TimeZoneInfo.ConvertTime(row.StartsAt, zone).TimeOfDay);
        Assert.Equal(new TimeSpan(21, 30, 0), TimeZoneInfo.ConvertTime(row.EndsAt, zone).TimeOfDay);

        Assert.All(occurrences.Where(o => o.Date != moved),
            o => Assert.Equal(new TimeSpan(18, 0, 0), TimeZoneInfo.ConvertTime(o.StartsAt, zone).TimeOfDay));
    }

    /// <summary>
    /// An override that names no times falls back to the rule's, rather than producing a
    /// zero-length occurrence out of two nulls.
    /// </summary>
    [Fact]
    public void An_override_with_no_times_keeps_the_rules_own()
    {
        var zone = Zone(NoDst);
        var row = Assert.Single(
            Expand(Rule(), NoDst, "2026-10-01", "2026-10-10", new BookingScheduleException
            {
                OccurrenceDate = DateOnly.Parse("2026-10-06"),
                Kind = ScheduleExceptionKind.Overridden,
            }));

        Assert.Equal(new TimeSpan(18, 0, 0), TimeZoneInfo.ConvertTime(row.StartsAt, zone).TimeOfDay);
        Assert.Equal(new TimeSpan(21, 0, 0), TimeZoneInfo.ConvertTime(row.EndsAt, zone).TimeOfDay);
    }

    /// <summary>An exception naming a date the rule does not produce changes nothing.</summary>
    [Fact]
    public void An_exception_on_a_date_the_rule_never_produces_is_ignored()
    {
        var occurrences = Expand(Rule(), NoDst, "2026-10-01", "2026-11-01", new BookingScheduleException
        {
            OccurrenceDate = DateOnly.Parse("2026-10-14"),   // a Wednesday
            Kind = ScheduleExceptionKind.Skipped,
        });

        Assert.All(occurrences, o => Assert.Equal(DayOfWeek.Tuesday, o.Date.DayOfWeek));
        Assert.All(occurrences, o => Assert.Equal(ScheduleOccurrenceStatus.Scheduled, o.Status));
    }
}
