using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// One CONFIRMED result from one member's side (§5.1): whether they won, the games each way, and
/// the other side's members. Guests have no member and appear in neither list.
/// </summary>
public sealed record MemberResult(
    Guid ResultId, Guid BookingId, DateTimeOffset StartsAt, DateTimeOffset ConfirmedAt, bool Won, int GamesFor, int GamesAgainst,
    IReadOnlyList<Guid> Opponents);

/// <summary>A partner: sessions shared, and the most recent one (the tie-break).</summary>
public sealed record PartnerCount(Guid UserId, int Sessions, DateTimeOffset LastShared);

/// <summary>An opponent: confirmed matches against them, head to head, and the most recent (the tie-break).</summary>
public sealed record OpponentCount(Guid UserId, int Matches, int Won, int Lost, DateTimeOffset LastPlayed);

/// <summary>One of the last five confirmed results.</summary>
public sealed record FormEntry(Guid ResultId, Guid BookingId, DateTimeOffset StartsAt, bool Won);

/// <summary>A member's personal figures (§5.1). Derived on every read; nothing here is stored.</summary>
public sealed record PersonalStats(
    int SessionsAttended, int MinutesOnCourt, int MinutesThisYear,
    int MatchesPlayed, int MatchesWon, int MatchesLost, int GamesWon, int GamesLost, int? WinRatePercent,
    IReadOnlyList<PartnerCount> Partners, IReadOnlyList<OpponentCount> Opponents, IReadOnlyList<FormEntry> Form);

/// <summary>
/// Personal stats and the monthly ring (<c>docs/specs/play.md</c> §5.1, §5.5) as pure functions
/// over sessions and confirmed results. Minutes come from ATTENDANCE, never from results.
/// </summary>
public static class PlayStats
{
    public const int TopPeople = 3;
    public const int FormLength = 5;

    public static PersonalStats Compute(
        IReadOnlyList<AttendedSession> sessions, IReadOnlyList<MemberResult> results, TimeZoneInfo zone, DateTimeOffset now)
    {
        var year = DoorClock.LocalDateOf(zone, now).Year;
        var won = results.Count(r => r.Won);
        return new PersonalStats(
            SessionsAttended: sessions.Count,
            MinutesOnCourt: sessions.Sum(s => s.PlayedMinutes),
            MinutesThisYear: sessions.Where(s => DoorClock.LocalDateOf(zone, s.StartsAt).Year == year).Sum(s => s.PlayedMinutes),
            MatchesPlayed: results.Count,
            MatchesWon: won,
            MatchesLost: results.Count - won,
            GamesWon: results.Sum(r => r.GamesFor),
            GamesLost: results.Sum(r => r.GamesAgainst),
            WinRatePercent: WinRate(won, results.Count),
            Partners: Partners(sessions),
            Opponents: Opponents(results),
            Form: results.OrderByDescending(r => r.StartsAt).ThenByDescending(r => r.ConfirmedAt).Take(FormLength)
                .Select(r => new FormEntry(r.ResultId, r.BookingId, r.StartsAt, r.Won)).ToList());
    }

    /// <summary><c>round(100 × won / played)</c>, half away from zero; null when nothing was played.</summary>
    public static int? WinRate(int won, int played) =>
        played == 0 ? null : (int)Math.Round(100m * won / played, MidpointRounding.AwayFromZero);

    /// <summary>Top members by sessions shared; ties go to the most recent shared session.</summary>
    public static IReadOnlyList<PartnerCount> Partners(IReadOnlyList<AttendedSession> sessions) =>
        sessions.SelectMany(s => s.OtherPlayers.Select(u => (User: u, s.StartsAt)))
            .GroupBy(x => x.User)
            .Select(g => new PartnerCount(g.Key, g.Count(), g.Max(x => x.StartsAt)))
            .OrderByDescending(p => p.Sessions).ThenByDescending(p => p.LastShared).ThenBy(p => p.UserId)
            .Take(TopPeople).ToList();

    /// <summary>Top members most often on the other side of a confirmed result, with the head-to-head.</summary>
    public static IReadOnlyList<OpponentCount> Opponents(IReadOnlyList<MemberResult> results) =>
        results.SelectMany(r => r.Opponents.Select(u => (User: u, Result: r)))
            .GroupBy(x => x.User)
            .Select(g => new OpponentCount(
                g.Key, g.Count(), g.Count(x => x.Result.Won), g.Count(x => !x.Result.Won), g.Max(x => x.Result.StartsAt)))
            .OrderByDescending(o => o.Matches).ThenByDescending(o => o.LastPlayed).ThenBy(o => o.UserId)
            .Take(TopPeople).ToList();

    /// <summary>The monthly ring's progress (§5.5): minutes and sessions whose start is in <paramref name="month"/> (club-local).</summary>
    public static (int Minutes, int Sessions) Month(IReadOnlyList<AttendedSession> sessions, TimeZoneInfo zone, string month)
    {
        var inMonth = sessions.Where(s => ClubWeek.MonthOf(zone, s.StartsAt) == month).ToList();
        return (inMonth.Sum(s => s.PlayedMinutes), inMonth.Count);
    }

    /// <summary>
    /// A confirmed result from <paramref name="userId"/>'s side, or null when they are not a member
    /// of its lineup.
    /// </summary>
    public static MemberResult? FromSide(MatchResult r, DateTimeOffset startsAt, Guid userId)
    {
        var mine = r.Players.FirstOrDefault(p => p.UserId == userId);
        if (mine is null || r.ConfirmedAt is not { } confirmedAt) return null;
        var forA = mine.Side == MatchSide.A;
        return new MemberResult(
            r.Id, r.BookingId, startsAt, confirmedAt, r.WinnerSide == mine.Side,
            forA ? r.GamesWonA : r.GamesWonB, forA ? r.GamesWonB : r.GamesWonA,
            r.Players.Where(p => p.Side != mine.Side && p.UserId != null).Select(p => p.UserId!.Value).ToList());
    }
}
