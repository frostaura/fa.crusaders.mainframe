namespace Crusaders.Mainframe.Api.Services;

/// <summary>A badge whose criteria hold, with the QUALIFYING instant and what qualified it (§5.6).</summary>
public sealed record BadgeAward(string Key, DateTimeOffset QualifiedAt, Guid? BookingId, Guid? ResultId);

/// <summary>Everything the badge rules read about one member — attendance and participation, never money.</summary>
/// <param name="Sessions">Attended sessions, ordered by (evidence check-in, booking id).</param>
/// <param name="Results">Confirmed results from the member's side.</param>
/// <param name="Walk">The member's streak walk (every week from the first attended one).</param>
public sealed record BadgeInputs(
    IReadOnlyList<AttendedSession> Sessions, IReadOnlyList<MemberResult> Results, StreakWalk Walk, TimeZoneInfo Zone,
    int EarlyBirdBeforeMinute, int NightOwlFromMinute);

/// <summary>
/// Which catalogue badges a member's history qualifies for, and when (<c>docs/specs/play.md</c>
/// §5.6). Pure: the evaluator inserts what this returns with <c>ON CONFLICT DO NOTHING</c>, so it
/// may run any number of times. Nothing here reads a ledger row, a price, a top-up or a share.
///
/// <para>
/// Sessions are ordered by the member's own evidence — their seat's check-in when set, else the
/// booking's — then by booking id, so "the 10th session" is deterministic.
/// </para>
/// </summary>
public static class BadgeRules
{
    public static IReadOnlyList<BadgeAward> Qualified(BadgeInputs input)
    {
        var sessions = input.Sessions.OrderBy(s => s.EvidenceAt).ThenBy(s => s.BookingId).ToList();
        var awards = new List<BadgeAward>();
        AddNth(awards, sessions, BadgeCatalogue.FirstSession, 1);
        AddNth(awards, sessions, BadgeCatalogue.Sessions10, 10);
        AddNth(awards, sessions, BadgeCatalogue.Sessions50, 50);
        AddNth(awards, sessions, BadgeCatalogue.Sessions100, 100);

        var confirmed = input.Results.OrderBy(r => r.ConfirmedAt).ThenBy(r => r.ResultId).ToList();
        if (confirmed.FirstOrDefault() is { } first) awards.Add(new(BadgeCatalogue.FirstResult, first.ConfirmedAt, first.BookingId, first.ResultId));
        if (confirmed.FirstOrDefault(r => r.Won) is { } win) awards.Add(new(BadgeCatalogue.FirstWin, win.ConfirmedAt, win.BookingId, win.ResultId));

        if (PartnersMilestone(sessions, 5) is { } fifth) awards.Add(new(BadgeCatalogue.Partners5, fifth.EvidenceAt, fifth.BookingId, null));
        AddFirst(awards, sessions, BadgeCatalogue.EarlyBird, s => MinuteOf(input.Zone, s) < input.EarlyBirdBeforeMinute);
        AddFirst(awards, sessions, BadgeCatalogue.NightOwl, s => MinuteOf(input.Zone, s) >= input.NightOwlFromMinute);

        AddStreak(awards, input, sessions, BadgeCatalogue.Streak4, 4);
        AddStreak(awards, input, sessions, BadgeCatalogue.Streak12, 12);
        AddStreak(awards, input, sessions, BadgeCatalogue.Streak26, 26);
        return awards;
    }

    /// <summary>Distinct other members across attended sessions, in session order (the <c>partners_5</c> count).</summary>
    public static int DistinctPartners(IReadOnlyList<AttendedSession> sessions) =>
        sessions.SelectMany(s => s.OtherPlayers).Distinct().Count();

    /// <summary>The count a locked badge shows progress towards its target with, or null for a badge with no count.</summary>
    public static int? ProgressValue(string key, int sessions, int partners, int currentStreak)
    {
        if (key is BadgeCatalogue.Sessions10 or BadgeCatalogue.Sessions50 or BadgeCatalogue.Sessions100) return sessions;
        if (key == BadgeCatalogue.Partners5) return partners;
        if (key is BadgeCatalogue.Streak4 or BadgeCatalogue.Streak12 or BadgeCatalogue.Streak26) return currentStreak;
        return null;
    }

    private static void AddNth(List<BadgeAward> awards, List<AttendedSession> sessions, string key, int n)
    {
        if (sessions.Count < n) return;
        var s = sessions[n - 1];
        awards.Add(new BadgeAward(key, s.EvidenceAt, s.BookingId, null));
    }

    private static void AddFirst(List<BadgeAward> awards, List<AttendedSession> sessions, string key, Func<AttendedSession, bool> match)
    {
        if (sessions.FirstOrDefault(match) is { } s) awards.Add(new BadgeAward(key, s.EvidenceAt, s.BookingId, null));
    }

    /// <summary>The session that brought the distinct partners to <paramref name="target"/>, if any did.</summary>
    private static AttendedSession? PartnersMilestone(List<AttendedSession> sessions, int target)
    {
        var seen = new HashSet<Guid>();
        foreach (var s in sessions)
        {
            seen.UnionWith(s.OtherPlayers);
            if (seen.Count >= target) return s;
        }
        return null;
    }

    /// <summary>
    /// The first week the streak reached <paramref name="weeks"/>; qualifying at the check-in of the
    /// first session in that week.
    /// </summary>
    private static void AddStreak(List<BadgeAward> awards, BadgeInputs input, List<AttendedSession> sessions, string key, int weeks)
    {
        var week = input.Walk.Weeks.FirstOrDefault(w => w.StreakAfter >= weeks);
        if (week == default) return;
        var first = sessions.FirstOrDefault(s => ClubWeek.KeyOf(input.Zone, s.StartsAt) == week.Week);
        if (first is not null) awards.Add(new BadgeAward(key, first.EvidenceAt, first.BookingId, null));
    }

    private static int MinuteOf(TimeZoneInfo zone, AttendedSession s)
    {
        var local = TimeZoneInfo.ConvertTime(s.StartsAt, zone);
        return (local.Hour * 60) + local.Minute;
    }
}
