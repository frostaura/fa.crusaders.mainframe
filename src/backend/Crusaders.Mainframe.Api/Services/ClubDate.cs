namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The club's date words, in one place (review round 1, lane F4): <c>Thu 1 Oct, 10:00</c> — no
/// leading zero on the day, the three-letter month ("Sep", never "Sept"), a comma before the time.
/// Every screen formats a club date this way; the mails and new ledger comments used
/// <c>Thu 01 Oct</c> and <c>2026-10-01 10:00</c>, so one booking read three ways.
/// Always with <see cref="System.Globalization.CultureInfo.InvariantCulture"/> and in the club's zone.
/// </summary>
public static class ClubDate
{
    public const string Format = "ddd d MMM, HH:mm";

    /// <summary>The same with the year, for a document that outlives the season (the receipt).</summary>
    public const string WithYear = "ddd d MMM yyyy, HH:mm";
}
