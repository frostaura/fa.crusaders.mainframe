namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The club week (<c>docs/specs/play.md</c> §1, §5.2): Monday 00:00 to the next Monday 00:00,
/// club-local. <b>A week's key is its Monday's club-local date</b> — never (year, ISO week number)
/// and never an instant plus 7 × 24 h.
///
/// <para>
/// An instant becomes a club-local date through the one DST-correct primitive
/// (<see cref="DoorClock.LocalDateOf"/>, which <see cref="ClubClock.DateOf"/> uses), and the key is
/// that date minus <c>(dayOfWeek + 6) % 7</c> days — pure calendar arithmetic, so a 167- or 169-hour
/// week cannot shift a session across a boundary, and a year boundary is not special.
/// </para>
/// </summary>
public static class ClubWeek
{
    /// <summary>The Monday of <paramref name="date"/>'s week.</summary>
    public static DateOnly KeyOf(DateOnly date) => date.AddDays(-(((int)date.DayOfWeek + 6) % 7));

    /// <summary>The Monday of the club-local week <paramref name="instant"/> falls in.</summary>
    public static DateOnly KeyOf(TimeZoneInfo zone, DateTimeOffset instant) => KeyOf(DoorClock.LocalDateOf(zone, instant));

    /// <summary>The club-local calendar month of <paramref name="instant"/>, as <c>yyyy-MM</c>.</summary>
    public static string MonthOf(TimeZoneInfo zone, DateTimeOffset instant)
    {
        var date = DoorClock.LocalDateOf(zone, instant);
        return $"{date.Year:D4}-{date.Month:D2}";
    }

    /// <summary>The club year a week belongs to: its Monday's calendar year (§5.3).</summary>
    public static int YearOf(DateOnly weekKey) => weekKey.Year;
}
