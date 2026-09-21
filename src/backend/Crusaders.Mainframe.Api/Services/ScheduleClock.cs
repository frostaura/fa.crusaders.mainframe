namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// One club-local wall-clock time, resolved to the instant it actually happened at.
///
/// <para>
/// <b>Why this exists beside <see cref="DoorClock"/> rather than inside it.</b> §3.1 makes
/// <see cref="DoorClock"/> the single implementation of a club's DAY, and every surface in this
/// tree that needs a day boundary takes it from there. A repeating schedule needs something
/// <see cref="DoorClock"/> has never been asked for: a wall-clock time that is <i>not</i>
/// midnight — "18:00 on that Tuesday" — resolved on the offset in force at 18:00.
/// </para>
///
/// <para>
/// <b>And the obvious shortcut is wrong in exactly the case the schedule exists for.</b>
/// <c>StartOfLocalDay(zone, d).AddMinutes(1080)</c> is "1080 minutes after this club's day
/// started", which is the same thing as 18:00 on every day of the year except the two a DST
/// zone changes on — and on those it is 17:00 or 19:00. A league night is a weekly series that
/// runs for a season, so it crosses a transition roughly every third season, and the failure is
/// silent: the rows are written, the courts are reserved, and league starts an hour late. That
/// is the whole reason D2 §11.1 chose a local-minutes-past-midnight rule over an offset.
/// </para>
///
/// <para>
/// The resolution rule is <see cref="DoorClock.StartOfLocalDay"/>'s own, applied at an
/// arbitrary minute: a wall time that does not exist walks forward to the instant the clocks
/// jumped, and one that happened twice takes the earlier of its two offsets — which is the
/// larger, because a bigger offset is an earlier instant for the same wall clock. A wall time
/// that lands exactly on a midnight is handed to <see cref="DoorClock"/> rather than decided
/// here, so the two can never answer a day boundary differently.
/// </para>
/// </summary>
public static class ScheduleClock
{
    /// <summary>
    /// The instant at which <paramref name="minute"/> minutes past midnight on
    /// <paramref name="day"/> reads on <paramref name="zone"/>'s wall clock, carrying that
    /// instant's own offset.
    /// </summary>
    /// <param name="minute">
    /// Local minutes past midnight, <c>0..1440</c>. <c>1440</c> is the next day's midnight,
    /// which is what a club means by "ends at 24:00".
    /// </param>
    public static DateTimeOffset InstantAt(TimeZoneInfo zone, DateOnly day, int minute)
    {
        var wall = day.ToDateTime(TimeOnly.MinValue).AddMinutes(minute);

        // A midnight — including the 1440 case — is a day boundary and belongs to DoorClock.
        if (wall.TimeOfDay == TimeSpan.Zero) return DoorClock.StartOfLocalDay(zone, DateOnly.FromDateTime(wall));

        // A minute at a time rather than an hour, because a DST gap is not guaranteed to be a
        // whole hour (Lord Howe's is thirty minutes).
        while (zone.IsInvalidTime(wall)) wall = wall.AddMinutes(1);

        var offset = zone.IsAmbiguousTime(wall)
            ? zone.GetAmbiguousTimeOffsets(wall).Max()
            : zone.GetUtcOffset(wall);

        return new DateTimeOffset(wall, offset);
    }

    /// <summary>The club-local date it is right now, which is what every "not in the past" rule is measured against.</summary>
    public static DateOnly Today(TimeZoneInfo zone, DateTimeOffset now) => DoorClock.LocalDateOf(zone, now);
}
