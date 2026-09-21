namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The club's day, and the only correct way to compute one.
///
/// <para>
/// <b>D2-B36: there were three implementations of "when does this club's day start", and two of
/// them were wrong.</b> <see cref="DoorClock"/> and <c>ReportingEndpoints</c> each carried a
/// DST-correct version — walk past an invalid midnight, take the later of an ambiguous one's
/// offsets — while <c>ScheduleService</c>, <c>BookingService.OpenWindowUtc</c> and
/// <c>BookingService.CheckPerDayCapAsync</c> used raw
/// <c>ConvertTimeToUtc(SpecifyKind(date, Unspecified), tz)</c>, which <b>throws</b> on a zone
/// whose midnight does not exist and silently picks standard time on an ambiguous one. None of
/// it is reachable for Johannesburg, which has no DST, or for UTC, which is what every fixture
/// club in this repository runs — which is exactly why a whole green suite could not see it.
/// </para>
///
/// <para>
/// <b>Two more traps live here, and both were in the old code.</b> A club day's END is the NEXT
/// day's start, never <c>start.AddDays(1)</c>: on a spring-forward day that difference is an
/// hour of court time that belongs to neither day, and on a fall-back day it is an hour counted
/// twice against a member's cap. And a club's opening hours are WALL TIMES — "we open at 06:00"
/// — so turning one into an instant is <see cref="InstantAt"/>'s job and not
/// <c>start.AddMinutes(360)</c>'s, which is an hour out on the same two days a year.
/// </para>
///
/// <para>
/// Everything that asks a club what day it is now goes through this type: the booking grid, both
/// per-day caps, the group windows, the operating-hours rule. The two hard primitives are
/// <see cref="DoorClock"/>'s, unchanged and not re-derived — it was the one implementation that
/// was right, and the fix for having three of something is not to write a fourth.
/// </para>
/// </summary>
public static class ClubClock
{
    /// <summary>
    /// The club's zone, resolved once. Falls back to UTC for a zone this platform does not know,
    /// which is reachable because <c>TenantSettingsAccessor</c> reads <c>timezone</c> raw and the
    /// settings PUT is not the only way a value reaches that column.
    ///
    /// <para>
    /// The four private <c>ResolveTz</c>-shaped copies this replaces each swallowed the exception
    /// and fell back to UTC on their own, so a club with a mistyped zone silently ran its
    /// bookings in one zone and its door log in another.
    /// </para>
    /// </summary>
    public static TimeZoneInfo ZoneOf(TenantSettingsView settings) => DoorClock.ZoneOf(settings).Zone;

    /// <summary>The club-local calendar date an instant falls on.</summary>
    public static DateOnly DateOf(TenantSettingsView settings, DateTimeOffset instant)
        => DoorClock.LocalDateOf(ZoneOf(settings), instant);

    /// <summary>The club-local calendar date it is right now.</summary>
    public static DateOnly Today(TenantSettingsView settings) => DateOf(settings, DateTimeOffset.UtcNow);

    /// <summary>
    /// The half-open window <c>[start, end)</c> of one club day, as UTC instants ready for a
    /// <c>timestamptz</c> parameter.
    ///
    /// <para>
    /// <b>Normalised to UTC before it leaves.</b> Npgsql refuses any <c>DateTimeOffset</c> whose
    /// offset is not zero on a <c>timestamptz</c> parameter — the request 500s, and every UTC
    /// fixture in this repository stays green while every real club is outside UTC
    /// (<c>memory/gotchas-postgres-offsets.md</c>). The offset is what makes the arithmetic right
    /// and it is dropped at the query boundary, never at the wire boundary.
    /// </para>
    ///
    /// <para>
    /// <b>The end is the next day's START.</b> Not <c>+24h</c>, and not <c>+1 day</c> on the
    /// offset-carrying value: a club day is 23 or 25 hours long twice a year, and a cap counted
    /// over a fixed 24 hours either loses an hour of a member's allowance or lets them have an
    /// extra one.
    /// </para>
    /// </summary>
    public static (DateTimeOffset Start, DateTimeOffset End) DayWindow(TenantSettingsView settings, DateOnly day)
    {
        var zone = ZoneOf(settings);
        return (
            DoorClock.StartOfLocalDay(zone, day).ToUniversalTime(),
            DoorClock.StartOfLocalDay(zone, day.AddDays(1)).ToUniversalTime());
    }

    /// <summary>The club day containing an instant, as a half-open UTC window.</summary>
    public static (DateTimeOffset Start, DateTimeOffset End) DayWindowContaining(
        TenantSettingsView settings, DateTimeOffset instant)
        => DayWindow(settings, DateOf(settings, instant));

    /// <summary>
    /// The instant at which a given wall-clock minute of a given club day occurs — "06:00 on
    /// Tuesday", as a moment.
    ///
    /// <para>
    /// This is what opening hours, peak windows and group windows are all made of, and
    /// <c>start-of-day + minutes</c> is wrong for every one of them on a DST day: the clocks move
    /// between midnight and 06:00, so the sum lands an hour out and the club either sells an hour
    /// it is shut or refuses an hour it is open.
    /// </para>
    ///
    /// <para>
    /// <paramref name="minutesPastMidnight"/> of 1440 means the end of the day, which is the next
    /// day's start — the half-open convention the whole codebase uses, and the only way to say
    /// "until closing" without naming 23:59.
    /// </para>
    /// </summary>
    public static DateTimeOffset InstantAt(TenantSettingsView settings, DateOnly day, int minutesPastMidnight)
    {
        var zone = ZoneOf(settings);
        var clamped = Math.Clamp(minutesPastMidnight, 0, 1440);
        if (clamped == 1440) return DoorClock.StartOfLocalDay(zone, day.AddDays(1)).ToUniversalTime();

        var wall = day.ToDateTime(TimeOnly.MinValue).AddMinutes(clamped);

        // The same two hazards midnight has, at any hour: a wall time inside a spring-forward gap
        // does not exist, and one inside a fall-back overlap happens twice. Walking forward and
        // taking the earlier instant matches StartOfLocalDay, so a window's edges and the day's
        // edges cannot disagree about which side of a transition they are on.
        while (zone.IsInvalidTime(wall)) wall = wall.AddMinutes(1);
        var offset = zone.IsAmbiguousTime(wall)
            ? zone.GetAmbiguousTimeOffsets(wall).Max()
            : zone.GetUtcOffset(wall);

        return new DateTimeOffset(wall, offset).ToUniversalTime();
    }

    /// <summary>
    /// How many minutes past the club's midnight an instant falls, on the day it falls on.
    ///
    /// <para>
    /// The inverse of <see cref="InstantAt"/> for the purpose every window rule needs: "is this
    /// booking inside 17:00–21:00". Computed from the local wall clock rather than by subtracting
    /// instants, because a subtraction across a DST change answers 25 hours for a day that ended
    /// at midnight.
    /// </para>
    /// </summary>
    public static int MinutesIntoDay(TenantSettingsView settings, DateTimeOffset instant)
    {
        var local = TimeZoneInfo.ConvertTime(instant, ZoneOf(settings));
        return (local.Hour * 60) + local.Minute;
    }
}
