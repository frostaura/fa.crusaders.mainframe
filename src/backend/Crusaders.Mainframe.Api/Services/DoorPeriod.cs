namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The ranges a club may ask its door log for by name, resolved on the SERVER in the club's own
/// zone.
///
/// <para>
/// <b>A4: the chair was nearly given half of yesterday.</b> The log's only range was a rolling
/// twenty-four hours, and the export it produced was named <c>door-log-&lt;date&gt;-&lt;date&gt;.csv</c>
/// — a file whose name says "a day" holding a window that starts at whatever time the admin
/// happened to click. There was no way at all to ask for yesterday, or for a particular day,
/// which is the question a committee actually asks. These five names plus <c>?day=</c> are that
/// vocabulary.
/// </para>
///
/// <para>
/// <b>Resolved here rather than in the browser, for the same reason <see cref="DoorDay"/>
/// computes the club's day here.</b> An admin travelling, an admin whose device clock is wrong
/// and a second club in another zone all produce a different "yesterday" from the same click,
/// and the number that comes out of the range is the one somebody quotes in a meeting. The page
/// states the resolved range in words above the rows, and the export carries it in the filename,
/// so the admin can see exactly what they were given.
/// </para>
///
/// <para>
/// <b>Rolling and whole-day ranges are both here and they are labelled differently on purpose.</b>
/// <see cref="Last24h"/> is rolling and says so; <see cref="Today"/>, <see cref="Yesterday"/>,
/// <see cref="Last7d"/> and <see cref="Last30d"/> start at a club-local midnight, which is what a
/// club means by those words. Mixing the two under one label is the defect A4 is about.
/// </para>
/// </summary>
public static class DoorPeriod
{
    /// <summary>Club-local midnight today until now.</summary>
    public const string Today = "today";

    /// <summary>Club-local midnight yesterday until club-local midnight today. A whole day, closed.</summary>
    public const string Yesterday = "yesterday";

    /// <summary>A rolling twenty-four hours. The log's original default, now named.</summary>
    public const string Last24h = "last_24h";

    /// <summary>Club-local midnight six days ago until now — seven club days, today included.</summary>
    public const string Last7d = "last_7d";

    /// <summary>Club-local midnight twenty-nine days ago until now — thirty club days, today included.</summary>
    public const string Last30d = "last_30d";

    /// <summary>Every value <c>?period=</c> accepts. A closed set; anything else is refused.</summary>
    public static readonly string[] All = [Today, Yesterday, Last24h, Last7d, Last30d];

    /// <summary>The refusal when <c>?period=</c> is not one of the five.</summary>
    public const string PeriodInvalid = "period_invalid";

    /// <summary>The refusal when <c>?day=</c> is not a <c>YYYY-MM-DD</c> calendar date.</summary>
    public const string DayInvalid = "day_invalid";

    /// <summary>
    /// The refusal when a request names the range more than one way. <c>?period=today&amp;from=…</c>
    /// is not a request this server can bound: one of the two was meant and guessing which is how
    /// an export lies about what it holds — the same argument <c>from_invalid</c> already carries.
    /// </summary>
    public const string RangeConflict = "range_conflict";

    /// <summary>
    /// The range one period name covers, or null when the name is not one of the five.
    ///
    /// <para>
    /// The whole-day periods count BACK IN LOCAL DATES rather than by subtracting hours, which is
    /// what makes them DST-safe: seven days ago is seven calendar days ago in the club's zone
    /// whether or not one of them was twenty-three or twenty-five hours long. Block body for the
    /// lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    public static (DateTimeOffset From, DateTimeOffset To)? Resolve(
        string period, TimeZoneInfo zone, DateTimeOffset now)
    {
        var today = DoorClock.LocalDateOf(zone, now);
        return period switch
        {
            Today => (DoorClock.StartOfLocalDay(zone, today), now),
            Yesterday => (DoorClock.StartOfLocalDay(zone, today.AddDays(-1)), DoorClock.StartOfLocalDay(zone, today)),
            Last24h => (now.AddHours(-24), now),
            Last7d => (DoorClock.StartOfLocalDay(zone, today.AddDays(-6)), now),
            Last30d => (DoorClock.StartOfLocalDay(zone, today.AddDays(-29)), now),
            _ => null,
        };
    }

    /// <summary>
    /// The range one club-local calendar day covers — its own midnight to the next — or null
    /// when the text is not a <c>YYYY-MM-DD</c> date.
    ///
    /// <para>
    /// <b>The upper edge is the next midnight and is not capped at <c>now</c>.</b> An admin who
    /// asks for today is asking for today, and a range that silently ended at 10:43 would put
    /// 10:43 in the export's filename and in the sentence above the rows — which is the "half of
    /// yesterday" complaint wearing a different hat. The rows that do not exist yet simply are
    /// not there. Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    public static (DateTimeOffset From, DateTimeOffset To)? Day(string text, TimeZoneInfo zone)
    {
        if (!DateOnly.TryParseExact(
                text, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out var day))
        {
            return null;
        }

        return (DoorClock.StartOfLocalDay(zone, day), DoorClock.StartOfLocalDay(zone, day.AddDays(1)));
    }
}
