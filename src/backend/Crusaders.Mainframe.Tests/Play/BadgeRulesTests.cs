using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// Each badge's criteria and qualifying instant (<c>docs/specs/play.md</c> §5.6), ordering ties,
/// and the rule that no badge reads money.
/// </summary>
public sealed class BadgeRulesTests
{
    private static readonly TimeZoneInfo Utc = TimeZoneInfo.Utc;
    private static readonly DateTimeOffset T0 = new(2026, 3, 2, 18, 0, 0, TimeSpan.Zero); // a Monday

    private static AttendedSession Session(int day, int hour = 18, params Guid[] others)
    {
        var starts = T0.Date.AddDays(day).AddHours(hour);
        var at = new DateTimeOffset(starts, TimeSpan.Zero);
        return new AttendedSession(Guid.NewGuid(), at, at.AddMinutes(2), 45, others);
    }

    private static IReadOnlyList<BadgeAward> Qualified(IReadOnlyList<AttendedSession> sessions, IReadOnlyList<MemberResult>? results = null)
    {
        var attended = sessions.Select(s => ClubWeek.KeyOf(Utc, s.StartsAt)).ToHashSet();
        var current = attended.Count == 0 ? ClubWeek.KeyOf(Utc, T0) : attended.Max();
        var walk = StreakMath.Walk(attended, new HashSet<DateOnly>(), current, new StreakRules(4, 2, 8));
        return BadgeRules.Qualified(new BadgeInputs(sessions, results ?? [], walk, Utc, 7 * 60, 21 * 60));
    }

    private static BadgeAward? Of(IReadOnlyList<BadgeAward> awards, string key) => awards.SingleOrDefault(a => a.Key == key);

    [Fact]
    public void Nothing_attended_qualifies_for_nothing()
    {
        Assert.Empty(Qualified([]));
    }

    [Fact]
    public void The_nth_session_qualifies_at_its_own_check_in()
    {
        var sessions = Enumerable.Range(0, 10).Select(i => Session(i * 2)).ToList();
        var awards = Qualified(sessions);
        Assert.Equal(sessions[0].EvidenceAt, Of(awards, BadgeCatalogue.FirstSession)!.QualifiedAt);
        Assert.Equal(sessions[9].EvidenceAt, Of(awards, BadgeCatalogue.Sessions10)!.QualifiedAt);
        Assert.Equal(sessions[9].BookingId, Of(awards, BadgeCatalogue.Sessions10)!.BookingId);
        Assert.Null(Of(awards, BadgeCatalogue.Sessions50));
    }

    [Fact]
    public void Sessions_are_ordered_by_evidence_then_booking_id_whatever_order_they_arrive_in()
    {
        var at = T0.AddDays(1);
        var a = new AttendedSession(Guid.Parse("00000000-0000-0000-0000-000000000002"), at, at, 45, []);
        var b = new AttendedSession(Guid.Parse("00000000-0000-0000-0000-000000000001"), at, at, 45, []);
        Assert.Equal(b.BookingId, Of(Qualified([a, b]), BadgeCatalogue.FirstSession)!.BookingId);
        Assert.Equal(b.BookingId, Of(Qualified([b, a]), BadgeCatalogue.FirstSession)!.BookingId);
    }

    [Fact]
    public void First_result_and_first_win_qualify_at_their_confirmations()
    {
        var lost = new MemberResult(Guid.NewGuid(), Guid.NewGuid(), T0, T0.AddHours(3), false, 1, 3, []);
        var won = new MemberResult(Guid.NewGuid(), Guid.NewGuid(), T0.AddDays(2), T0.AddDays(2).AddHours(1), true, 3, 0, []);
        var awards = Qualified([Session(0)], [won, lost]);
        Assert.Equal(lost.ConfirmedAt, Of(awards, BadgeCatalogue.FirstResult)!.QualifiedAt);
        Assert.Equal(lost.ResultId, Of(awards, BadgeCatalogue.FirstResult)!.ResultId);
        Assert.Equal(won.ConfirmedAt, Of(awards, BadgeCatalogue.FirstWin)!.QualifiedAt);
    }

    [Fact]
    public void Good_company_qualifies_at_the_session_that_made_five_distinct_members()
    {
        var p = Enumerable.Range(0, 5).Select(_ => Guid.NewGuid()).ToArray();
        var sessions = new[] { Session(0, 18, p[0], p[1]), Session(1, 18, p[0], p[2]), Session(2, 18, p[3]), Session(3, 18, p[1], p[4]) };
        Assert.Equal(sessions[3].EvidenceAt, Of(Qualified(sessions), BadgeCatalogue.Partners5)!.QualifiedAt);
        Assert.Null(Of(Qualified(sessions.Take(3).ToList()), BadgeCatalogue.Partners5));
        Assert.Equal(4, BadgeRules.DistinctPartners(sessions.Take(3).ToList()));
    }

    [Fact]
    public void Early_bird_is_before_the_threshold_and_night_owl_at_or_after_it()
    {
        var awards = Qualified([Session(0, 7), Session(1, 20), Session(2, 6), Session(3, 21)]);
        Assert.Equal(T0.Date.AddDays(2).AddHours(6), Of(awards, BadgeCatalogue.EarlyBird)!.QualifiedAt.AddMinutes(-2).UtcDateTime);
        Assert.Equal(T0.Date.AddDays(3).AddHours(21), Of(awards, BadgeCatalogue.NightOwl)!.QualifiedAt.AddMinutes(-2).UtcDateTime);
    }

    [Fact]
    public void A_streak_badge_qualifies_at_the_first_session_of_the_week_it_was_reached()
    {
        var sessions = Enumerable.Range(0, 4).SelectMany(w => new[] { Session(w * 7 + 3), Session(w * 7 + 1) }).ToList();
        var award = Of(Qualified(sessions), BadgeCatalogue.Streak4)!;
        Assert.Equal(sessions.Single(s => s.StartsAt == new DateTimeOffset(T0.Date.AddDays(22).AddHours(18), TimeSpan.Zero)).EvidenceAt, award.QualifiedAt);
        Assert.Null(Of(Qualified(sessions.Take(6).ToList()), BadgeCatalogue.Streak4));
    }

    [Fact]
    public void Progress_is_counted_only_for_badges_with_a_count()
    {
        Assert.Equal(58, BadgeRules.ProgressValue(BadgeCatalogue.Sessions100, 58, 3, 2));
        Assert.Equal(3, BadgeRules.ProgressValue(BadgeCatalogue.Partners5, 58, 3, 2));
        Assert.Equal(2, BadgeRules.ProgressValue(BadgeCatalogue.Streak12, 58, 3, 2));
        foreach (var key in new[] { BadgeCatalogue.FirstSession, BadgeCatalogue.FirstResult, BadgeCatalogue.FirstWin, BadgeCatalogue.EarlyBird, BadgeCatalogue.NightOwl })
        {
            Assert.Null(BadgeRules.ProgressValue(key, 58, 3, 2));
        }
    }

    [Fact]
    public void The_catalogue_is_the_twelve_of_the_spec_in_order_with_unique_keys()
    {
        Assert.Equal(
            ["first_session", "sessions_10", "sessions_50", "sessions_100", "first_result", "first_win", "partners_5", "early_bird", "night_owl", "streak_4", "streak_12", "streak_26"],
            BadgeCatalogue.All.Select(b => b.Key));
        Assert.Equal(1, BadgeCatalogue.Version);
    }

    /// <summary>Attendance and participation only — never money: nothing in the badge path names a ledger, a price or a share.</summary>
    [Fact]
    public void No_badge_rule_reads_money()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src", "backend"))) dir = dir.Parent;
        Assert.NotNull(dir);
        var play = Path.Combine(dir!.FullName, "src", "backend", "Crusaders.Mainframe.Api", "Services", "Play");
        foreach (var file in new[] { "BadgeRules.cs", "BadgeCatalogue.cs", "PlayEvaluator.cs", "AttendanceQuery.cs", "PlayStats.cs", "PlayRecord.cs" })
        {
            var text = File.ReadAllText(Path.Combine(play, file));
            foreach (var money in new[] { "LedgerEntr", "AmountCharged", "ShareMinutes", "Topup", "TopUp", "Credits" })
            {
                Assert.False(text.Contains(money, StringComparison.Ordinal), $"{file} mentions {money}");
            }
        }
    }
}
