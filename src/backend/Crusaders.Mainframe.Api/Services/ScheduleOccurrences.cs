using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>What one date of a schedule is, once its exceptions have been applied.</summary>
public enum ScheduleOccurrenceStatus
{
    /// <summary>The rule's own times, unmodified.</summary>
    Scheduled = 0,

    /// <summary>An admin took this date out. It is reported so a screen can say so, and never written.</summary>
    Skipped = 1,

    /// <summary>An admin re-timed this date. The times below are the exception's, not the rule's.</summary>
    Overridden = 2,
}

/// <summary>
/// One date a schedule produces, with the instants it actually starts and ends at.
/// </summary>
/// <param name="Date">The club-local date. This is the key an exception matches on.</param>
/// <param name="StartsAt">Carries the club's own offset; normalise before it reaches a query.</param>
/// <param name="EndsAt">The same.</param>
public readonly record struct ScheduleOccurrence(
    DateOnly Date, DateTimeOffset StartsAt, DateTimeOffset EndsAt, ScheduleOccurrenceStatus Status);

/// <summary>
/// The recurrence rule, expanded.
///
/// <para>
/// <b>Pure, and it touches no database on purpose.</b> This is the arithmetic the whole feature
/// rests on — which dates a league night falls on and at what instant — and it is the only part
/// of it that can be driven across a year of a DST club's calendar in milliseconds. A materialiser
/// that expanded inline would make every one of those cases need a Postgres fixture, and the
/// cases nobody would then write are precisely the two days a year the arithmetic is hard.
/// </para>
/// </summary>
public static class ScheduleOccurrences
{
    /// <summary>
    /// Every date the rule produces inside <paramref name="from"/>..<paramref name="to"/>
    /// inclusive, in ascending order, with its exceptions applied.
    ///
    /// <para>
    /// <b>Lazy, and the caller is expected to stop.</b> An open-ended weekly schedule is an
    /// infinite series; the callers bound it by a horizon or by the row cap, and a method that
    /// materialised a list first would have to be told the bound twice.
    /// </para>
    /// </summary>
    public static IEnumerable<ScheduleOccurrence> Expand(
        BookingSchedule schedule,
        IReadOnlyCollection<BookingScheduleException> exceptions,
        TimeZoneInfo zone,
        DateOnly from,
        DateOnly to)
    {
        var byDate = exceptions
            .Where(x => x.ScheduleId == schedule.Id || x.ScheduleId == Guid.Empty)
            .GroupBy(x => x.OccurrenceDate)
            .ToDictionary(g => g.Key, g => g.First());

        var first = Later(from, schedule.StartDate);
        var last = schedule.EndDate is { } end ? Earlier(to, end) : to;

        // The anchor is the START DATE's week, never the window's — and it is taken from
        // `schedule.StartDate` rather than from `first`, which is `max(window, StartDate)`.
        //
        // Anchoring on `first` is right whenever the window opens before the series does and
        // wrong the moment it does not, which is every screen that asks about next month. A
        // series asked for from November would then answer "every other Tuesday counted from
        // November", and an admin re-opening the page sees league night on the wrong Tuesdays.
        //
        // The test that covers this passed with the bug in place, because its window opened on
        // 2026-11-01 — exactly four weeks after the start date's own Sunday, so the two anchors
        // agreed by arithmetic accident. Varying that one fixture field to an odd number of
        // weeks is what made it visible; the code and the fixture were fixed together.
        var anchor = WeekStart(schedule.StartDate);

        // A stored zero or negative interval is a hand-edited column, not a PUT, and the honest
        // reading of "every 0 weeks" is "every week" — never a division by zero on a read.
        var interval = Math.Max((int)schedule.IntervalWeeks, 1);

        for (var day = first; day <= last; day = day.AddDays(1))
        {
            if ((schedule.DaysOfWeek & (1 << (int)day.DayOfWeek)) == 0) continue;
            if ((WeekStart(day).DayNumber - anchor.DayNumber) / 7 % interval != 0) continue;

            yield return At(schedule, zone, day, byDate.GetValueOrDefault(day));
        }
    }

    /// <summary>
    /// One date, with its exception applied.
    ///
    /// <para>
    /// A skipped date keeps the rule's own times rather than reporting nulls: the screen that
    /// lists a season's dates has to be able to draw the one that is not happening, and a row
    /// with no times is a row that cannot be drawn beside the others.
    /// </para>
    /// </summary>
    private static ScheduleOccurrence At(
        BookingSchedule schedule, TimeZoneInfo zone, DateOnly day, BookingScheduleException? exception)
    {
        var overridden = exception?.Kind == ScheduleExceptionKind.Overridden;
        var startMinute = (overridden ? exception!.StartMinute : null) ?? schedule.StartMinute;
        var endMinute = (overridden ? exception!.EndMinute : null) ?? schedule.EndMinute;

        var status = exception?.Kind switch
        {
            ScheduleExceptionKind.Skipped => ScheduleOccurrenceStatus.Skipped,
            ScheduleExceptionKind.Overridden => ScheduleOccurrenceStatus.Overridden,
            _ => ScheduleOccurrenceStatus.Scheduled,
        };

        return new ScheduleOccurrence(
            day,
            ScheduleClock.InstantAt(zone, day, startMinute),
            ScheduleClock.InstantAt(zone, day, endMinute),
            status);
    }

    /// <summary>The Sunday on or before <paramref name="day"/> — the same Sunday-first week the bitmask is written in.</summary>
    private static DateOnly WeekStart(DateOnly day) => day.AddDays(-(int)day.DayOfWeek);

    private static DateOnly Later(DateOnly a, DateOnly b) => a > b ? a : b;

    private static DateOnly Earlier(DateOnly a, DateOnly b) => a < b ? a : b;
}
