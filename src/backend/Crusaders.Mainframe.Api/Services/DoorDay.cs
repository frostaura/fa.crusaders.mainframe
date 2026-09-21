namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// When the club's day started — the boundary every door count is taken against.
///
/// <para>
/// <b>The day is the CLUB's, and the server is the only party that can say so.</b> A count
/// computed in a browser is a different day for an admin travelling, for an admin whose device
/// clock is wrong, and for the second club in another zone that this product has been
/// multi-tenant for since day one. A2.3 makes the point in operational terms: today's opens is
/// the one number on the doors page somebody will quote in a committee meeting, so it is
/// computed once, here, and the boundary is stated on the wire so the page can name it rather
/// than assert one.
/// </para>
///
/// <para>
/// <b>A zone this platform does not know is a day that cannot be established</b>, and the
/// answer to that is no counts at all — not counts against UTC wearing the club's label.
/// <c>TenantSettingsAccessor</c> reads <c>timezone</c> with no validation (the PUT validates
/// it, and the PUT is not the only way a value reaches that column), so this is reachable from
/// a hand-edited row. The caller withholds every count and reports the zone it actually used,
/// which is what lets the console show "we could not read today's scans" beside a boundary that
/// is at least a real instant.
/// </para>
/// </summary>
public static class DoorDay
{
    /// <summary>
    /// Midnight today in the club's zone, and the zone that boundary was taken in.
    /// <paramref name="countable"/> is false when the stored zone id is not one this platform
    /// knows — in which case the boundary is UTC's and no count derived from it may be
    /// published as the club's.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The boundary is built by <see cref="DoorClock.StartOfLocalDay"/> and no longer here.</b>
    /// This method used to convert <paramref name="now"/> into the club's zone and then construct
    /// midnight with <c>local.Offset</c> — the offset in force at <i>now</i> rather than at
    /// midnight. On the two days a year a DST zone changes those are different numbers, so the
    /// club's day was said to have begun an hour early or an hour late and every count taken
    /// against it belonged to a different day. Every fixture club in this repository runs UTC and
    /// the first real one runs Africa/Johannesburg, neither of which has DST, so nothing could
    /// go red. See <see cref="DoorClock"/> for the invalid- and ambiguous-midnight cases too.
    /// </para>
    /// </remarks>
    public static (DateTimeOffset DayStartedAt, string Timezone, bool Countable) StartOfToday(
        TenantSettingsView settings, DateTimeOffset now)
    {
        var (zone, name, known) = DoorClock.ZoneOf(settings);
        return (DoorClock.StartOfLocalDay(zone, DoorClock.LocalDateOf(zone, now)), name, known);
    }
}
