namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The club's own clock: which zone a club keeps, when one of its days starts, and whether an
/// instant is one of its midnights.
///
/// <para>
/// <b>It exists because "midnight in the club's zone" was being computed with the wrong
/// offset.</b> <see cref="DoorDay"/> converted <c>now</c> into the club's zone and then built
/// midnight with <c>local.Offset</c> — the offset at <i>now</i>, not the offset at midnight.
/// Those are the same number on every day of the year in Johannesburg, which has no DST, and in
/// UTC, which is what every fixture club in this repository runs; they differ by an hour on the
/// two days a year a DST zone changes, in which case the club's day was said to have started an
/// hour before or after it did and every count taken against it was a different day's. A whole
/// suite of green tests could not see it, which is the shape <c>memory/gotchas.md</c> warns
/// about.
/// </para>
///
/// <para>
/// <b>And midnight is not guaranteed to exist.</b> A zone that springs forward at 00:00 has no
/// 00:00 on that date at all (<see cref="TimeZoneInfo.IsInvalidTime"/>), and one that falls back
/// through 00:00 has two of them. The day starts at the FIRST instant that is on that date, so
/// an invalid midnight walks forward to the instant the clocks jumped and an ambiguous one takes
/// the earlier of its two offsets — which is the larger, because a bigger offset is an earlier
/// instant for the same wall clock.
/// </para>
/// </summary>
public static class DoorClock
{
    /// <summary>
    /// The club's zone, the name to put on the wire for it, and whether the platform knew it.
    ///
    /// <para>
    /// <c>TenantSettingsAccessor</c> reads <c>timezone</c> with no validation — the PUT
    /// validates it and the PUT is not the only way a value reaches that column — so a zone id
    /// this platform has never heard of is reachable from a hand-edited row. The fallback is
    /// UTC and the NAME reported is UTC's, never the stored string: a page that printed the
    /// club's own label beside times that are not in it would be worse than one that says UTC.
    /// </para>
    /// </summary>
    public static (TimeZoneInfo Zone, string Name, bool Known) ZoneOf(TenantSettingsView settings)
    {
        var stored = settings.Timezone?.Trim() ?? "";
        if (TimeZoneInfo.TryFindSystemTimeZoneById(stored, out var zone)) return (zone, stored, true);
        return (TimeZoneInfo.Utc, TimeZoneInfo.Utc.Id, false);
    }

    /// <summary>The club-local calendar date <paramref name="instant"/> falls on.</summary>
    public static DateOnly LocalDateOf(TimeZoneInfo zone, DateTimeOffset instant)
    {
        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(instant, zone).DateTime);
    }

    /// <summary>
    /// The first instant of <paramref name="day"/> in <paramref name="zone"/>, carrying the
    /// offset that is in force AT THAT INSTANT rather than the one in force now.
    ///
    /// <para>
    /// The wire keeps the club's own offset deliberately — it is what lets a page say "since
    /// 00:00 club time" rather than converting and guessing — and every caller that puts the
    /// value in a query parameter calls <c>.ToUniversalTime()</c> first, because Npgsql refuses
    /// a non-zero offset on a <c>timestamptz</c>. See <c>memory/gotchas-postgres-offsets.md</c>.
    /// </para>
    /// </summary>
    public static DateTimeOffset StartOfLocalDay(TimeZoneInfo zone, DateOnly day)
    {
        var wall = day.ToDateTime(TimeOnly.MinValue);

        // A day whose midnight does not exist starts when the clocks jumped. A minute at a
        // time rather than an hour, because a DST gap is not guaranteed to be a whole hour
        // (Lord Howe's is thirty minutes) and the loop runs at most a couple of dozen times.
        while (zone.IsInvalidTime(wall)) wall = wall.AddMinutes(1);

        var offset = zone.IsAmbiguousTime(wall)
            ? zone.GetAmbiguousTimeOffsets(wall).Max()
            : zone.GetUtcOffset(wall);

        return new DateTimeOffset(wall, offset);
    }

    /// <summary>
    /// Whether <paramref name="instant"/> is the first instant of a club-local day — which is
    /// what decides whether the export's filename may be written as two dates rather than two
    /// date-and-times (A4).
    /// </summary>
    public static bool IsStartOfLocalDay(TimeZoneInfo zone, DateTimeOffset instant)
    {
        return StartOfLocalDay(zone, LocalDateOf(zone, instant)) == instant;
    }
}
