namespace Crusaders.Mainframe.Api.Services;

/// <summary>The club's three streak numbers, clamped (<see cref="PlaySettings.StreakRulesOf"/>).</summary>
/// <param name="RestEveryWeeks"><c>E</c> — attended weeks in a run that earn one rest week.</param>
/// <param name="RestCap"><c>K</c> — rest weeks that may be banked; 0 turns them off.</param>
/// <param name="PauseWeeksPerYear"><c>Y</c> — paused-and-not-attended weeks per club year; 0 turns pausing off.</param>
public sealed record StreakRules(int RestEveryWeeks, int RestCap, int PauseWeeksPerYear);

/// <summary>What one week was, as the streak strip draws it.</summary>
public static class WeekStates
{
    public const string Attended = "attended";
    public const string Rest = "rest";
    public const string Paused = "paused";
    public const string Missed = "missed";
    public const string Pending = "pending";
}

/// <summary>
/// The walk's state after some prefix of weeks: the streak, the longest so far, the rest weeks
/// banked, and <see cref="Progress"/> — attended weeks towards the next rest week (§5.2's
/// <c>counter</c>), which accrues only while the bank is below the cap.
/// </summary>
public readonly record struct StreakState(int Streak, int Longest, int Bank, int Progress = 0)
{
    public static readonly StreakState Empty = new(0, 0, 0, 0);
}

/// <summary>One walked week: its key, what it was, and the streak after it.</summary>
public readonly record struct WalkedWeek(DateOnly Week, string State, int StreakAfter);

/// <summary>The result of a walk: the final state and every week walked, oldest first.</summary>
public sealed record StreakWalk(StreakState State, IReadOnlyList<WalkedWeek> Weeks);

/// <summary>Which weeks an injury pause covers, after the yearly allowance (§5.3).</summary>
/// <param name="Paused">Weeks that are paused: inside a pause, not attended, and within the year's allowance.</param>
/// <param name="UsedByYear">Paused weeks counted against each club year's allowance.</param>
public sealed record PauseCoverage(IReadOnlySet<DateOnly> Paused, IReadOnlyDictionary<int, int> UsedByYear)
{
    public int UsedIn(int year) => UsedByYear.TryGetValue(year, out var n) ? n : 0;
}

/// <summary>
/// The weekly streak (<c>docs/specs/play.md</c> §5.2–5.3) as pure functions over week keys, so the
/// property tests drive it without a database or a clock.
///
/// <para>
/// <b>Weeks, not days; a week counts when the member attended at least one session in it.</b>
/// Rest weeks are earned (one per <c>E</c> attended weeks of progress, up to <c>K</c> banked) and spent
/// automatically and silently on a missed week; a break empties the bank and the progress.
/// <b>Progress accrues only while the bank is below the cap</b> — at the cap an attended week
/// builds nothing, and progress resumes once a rest week is spent; a spend keeps the progress.
/// </para>
///
/// <para>
/// <b>Why: a member who plays more must never see a shorter streak.</b> The first rule counted
/// earns by the streak's remainder (<c>streak % E</c>) and threw an earn away at the cap, so where
/// a run started decided which earns were lost: one extra attended week at the start of a run
/// could end a streak that the same history without it survived (the X/Y regression test).
/// Stated as credit <c>c = bank × E + progress</c>, this rule is: attend → <c>min(c + 1, K × E)</c>;
/// miss → <c>c − E</c> when <c>c ≥ E</c>, else broken. Both are non-decreasing in <c>c</c>, and a
/// break needs <c>c &lt; E</c> — so more attended or paused weeks can only keep <c>c</c>, and the
/// streak, at least as high. The seeded property test holds it to that.
/// </para>
///
/// <para>
/// The current week never
/// breaks a streak — it is judged only once it has ended, at the next read — and nothing is ever
/// sent about a streak at risk.
/// </para>
/// </summary>
public static class StreakMath
{
    /// <summary>The transition for one week (§5.2's table). <paramref name="isCurrent"/> is week <c>C</c>.</summary>
    public static (StreakState State, string WeekState) Step(StreakState s, bool attended, bool paused, bool isCurrent, StreakRules rules)
    {
        if (attended)
        {
            var streak = s.Streak + 1;
            var (bank, progress) = (s.Bank, s.Progress);
            if (bank < rules.RestCap && ++progress == rules.RestEveryWeeks) (bank, progress) = (bank + 1, 0);
            return (new StreakState(streak, Math.Max(s.Longest, streak), bank, progress), WeekStates.Attended);
        }

        if (paused) return (s, WeekStates.Paused);
        if (isCurrent) return (s, WeekStates.Pending);
        if (s.Streak == 0) return (s, WeekStates.Missed);
        if (s.Bank > 0) return (s with { Bank = s.Bank - 1 }, WeekStates.Rest);
        return (s with { Streak = 0, Bank = 0, Progress = 0 }, WeekStates.Missed);
    }

    /// <summary>
    /// Walks every week from the first attended week to <paramref name="current"/>, oldest first. A
    /// member who never attended walks nothing and reads zeros.
    /// </summary>
    public static StreakWalk Walk(IReadOnlySet<DateOnly> attended, IReadOnlySet<DateOnly> paused, DateOnly current, StreakRules rules)
    {
        var upTo = attended.Where(w => w <= current).ToList();
        if (upTo.Count == 0) return new StreakWalk(StreakState.Empty, []);
        return Resume(StreakState.Empty, upTo.Min(), attended, paused, current, rules);
    }

    /// <summary>
    /// The same walk, resumed at <paramref name="from"/> from a state an earlier walk reached — the
    /// "identical whether run in one pass or resumed" property (§5.2) is this and <see cref="Walk"/>.
    /// </summary>
    public static StreakWalk Resume(
        StreakState start, DateOnly from, IReadOnlySet<DateOnly> attended, IReadOnlySet<DateOnly> paused, DateOnly current, StreakRules rules)
    {
        var state = start;
        var weeks = new List<WalkedWeek>();
        for (var w = ClubWeek.KeyOf(from); w <= current; w = w.AddDays(7))
        {
            var (next, kind) = Step(state, attended.Contains(w), paused.Contains(w), w == current, rules);
            state = next;
            weeks.Add(new WalkedWeek(w, kind, state.Streak));
        }
        return new StreakWalk(state, weeks);
    }

    /// <summary>
    /// The paused weeks (§5.3): every week from each pause's first week to its last (or
    /// <paramref name="current"/> while it is on), inclusive — except a week the member attended,
    /// which simply counts as attended — and at most <c>Y</c> of them per club year, counted oldest
    /// first. Weeks past the allowance are ordinary weeks even while the pause is on.
    /// </summary>
    public static PauseCoverage PausedWeeks(
        IEnumerable<(DateOnly FirstWeek, DateOnly? LastWeek)> pauses, IReadOnlySet<DateOnly> attended, DateOnly current, int perYear)
    {
        var inside = new SortedSet<DateOnly>();
        foreach (var (first, last) in pauses)
        {
            var end = last ?? current;
            if (end > current) end = current;
            for (var w = ClubWeek.KeyOf(first); w <= end; w = w.AddDays(7)) inside.Add(w);
        }

        var paused = new HashSet<DateOnly>();
        var used = new Dictionary<int, int>();
        foreach (var w in inside.Where(w => !attended.Contains(w)))
        {
            var year = ClubWeek.YearOf(w);
            var n = used.TryGetValue(year, out var u) ? u : 0;
            if (n >= perYear) continue;
            used[year] = n + 1;
            paused.Add(w);
        }
        return new PauseCoverage(paused, used);
    }

    /// <summary>The last <paramref name="count"/> weeks up to <paramref name="current"/>, oldest first, as the strip draws them.</summary>
    public static IReadOnlyList<(DateOnly Week, string State)> Strip(StreakWalk walk, IReadOnlySet<DateOnly> paused, DateOnly current, int count = 12)
    {
        var walked = walk.Weeks.ToDictionary(w => w.Week, w => w.State);
        var strip = new List<(DateOnly, string)>();
        for (var i = count - 1; i >= 0; i--)
        {
            var week = current.AddDays(-7 * i);
            strip.Add((week, walked.TryGetValue(week, out var state) ? state : Unwalked(week, paused, current)));
        }
        return strip;
    }

    /// <summary>A week before the member's first attendance: nothing to count, but still drawn honestly.</summary>
    private static string Unwalked(DateOnly week, IReadOnlySet<DateOnly> paused, DateOnly current)
    {
        if (paused.Contains(week)) return WeekStates.Paused;
        return week == current ? WeekStates.Pending : WeekStates.Missed;
    }
}
