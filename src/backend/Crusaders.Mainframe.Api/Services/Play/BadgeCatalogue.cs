namespace Crusaders.Mainframe.Api.Services;

/// <summary>One badge as the member reads it: the key, and the name and description the API sends.</summary>
/// <param name="Target">The count a locked badge shows progress towards; null for a badge with no count.</param>
public sealed record Badge(string Key, string Name, string Description, int? Target);

/// <summary>
/// The server-authoritative badge catalogue (<c>docs/specs/play.md</c> §5.6). Attendance and
/// participation only — <b>never money</b>. The API sends <see cref="Badge.Name"/> and
/// <see cref="Badge.Description"/>, so the inbox headline, the PWA and the catalogue cannot drift.
///
/// <para>
/// <b>Bumping <see cref="Version"/> re-evaluates every member</b> (<c>PlayWorker</c>'s catch-up),
/// silently for anything older than the fresh window.
/// </para>
/// </summary>
public static class BadgeCatalogue
{
    public const int Version = 1;

    public const string FirstSession = "first_session";
    public const string Sessions10 = "sessions_10";
    public const string Sessions50 = "sessions_50";
    public const string Sessions100 = "sessions_100";
    public const string FirstResult = "first_result";
    public const string FirstWin = "first_win";
    public const string Partners5 = "partners_5";
    public const string EarlyBird = "early_bird";
    public const string NightOwl = "night_owl";
    public const string Streak4 = "streak_4";
    public const string Streak12 = "streak_12";
    public const string Streak26 = "streak_26";

    /// <summary>The whole catalogue, in catalogue order — the order <c>GET /me/play</c> lists it.</summary>
    public static readonly IReadOnlyList<Badge> All =
    [
        new(FirstSession, "First court", "Played your first session at the club.", null),
        new(Sessions10, "Ten up", "Played 10 sessions.", 10),
        new(Sessions50, "Regular", "Played 50 sessions.", 50),
        new(Sessions100, "Centurion", "Played 100 sessions.", 100),
        new(FirstResult, "On the record", "Your first match result is on the record.", null),
        new(FirstWin, "First win", "Won a match.", null),
        new(Partners5, "Good company", "Played with 5 different members.", 5),
        new(EarlyBird, "Early bird", "Played a session that started before 07:00.", null),
        new(NightOwl, "Night owl", "Played a session that started at 21:00 or later.", null),
        new(Streak4, "Four-week streak", "Played every week for 4 weeks.", 4),
        new(Streak12, "Twelve-week streak", "Played every week for 12 weeks.", 12),
        new(Streak26, "Half a year", "Played every week for 26 weeks.", 26),
    ];

    public static Badge? Find(string key) => All.FirstOrDefault(b => b.Key == key);
}
