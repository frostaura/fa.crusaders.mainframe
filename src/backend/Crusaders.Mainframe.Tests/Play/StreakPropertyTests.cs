using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// Seeded random histories (<c>docs/specs/play.md</c> §5.2, §11) checked against a separately
/// written model. 2,000 seeds by default; <c>PLAY_PROPERTY_SEEDS</c> asks for more.
///
/// <para>
/// <b>The headline property: a member who plays more must never see a shorter streak.</b> With
/// rest weeks ON, adding an attended week or a paused week anywhere never lowers the current
/// streak. The first rule failed it (earns counted by the streak's remainder and lost to the cap);
/// the rule as built accrues progress only below the cap. Also: current ≤ longest ≤ |A|,
/// bank ≤ K, resumable from any prefix, independent of input order, paused-and-not-attended
/// weeks per club year ≤ Y, and the zone moving only the week assignment.
/// </para>
/// </summary>
public sealed class StreakPropertyTests
{
    private static int Seeds =>
        int.TryParse(Environment.GetEnvironmentVariable("PLAY_PROPERTY_SEEDS"), out var n) && n > 0 ? n : 2000;

    private static readonly DateOnly Origin = new(2025, 12, 29);

    private sealed record History(HashSet<DateOnly> Attended, List<(DateOnly, DateOnly?)> Pauses, DateOnly Current, StreakRules Rules);

    private static History Generate(int seed)
    {
        var rng = new Random(seed);
        var weeks = rng.Next(1, 90);
        var current = Origin.AddDays(7 * weeks);
        var density = rng.NextDouble();
        var attended = Enumerable.Range(0, weeks + 1).Where(_ => rng.NextDouble() < density).Select(i => Origin.AddDays(7 * i)).ToHashSet();
        var pauses = new List<(DateOnly, DateOnly?)>();
        for (var p = rng.Next(0, 4); p > 0; p--)
        {
            var start = Origin.AddDays(7 * rng.Next(0, weeks + 1) + rng.Next(0, 7));
            pauses.Add((start, rng.NextDouble() < 0.2 ? null : start.AddDays(rng.Next(0, 60))));
        }
        var rules = new StreakRules(rng.Next(2, 13), rng.Next(0, 5), rng.Next(0, 27));
        return new History(attended, pauses, current, rules);
    }

    /// <summary>
    /// The model: the same rule stated as one credit number, <c>c = bank × E + progress</c> —
    /// attend: <c>min(c + 1, K × E)</c>; miss: <c>c − E</c> when <c>c ≥ E</c>, else broken — over
    /// weeks built by stepping a <see cref="DateTime"/> rather than a key.
    /// </summary>
    private static (int Current, int Longest, int Bank) Model(ISet<DateOnly> attended, ISet<DateOnly> paused, DateOnly current, StreakRules r)
    {
        var inRange = attended.Where(w => w <= current).ToList();
        if (inRange.Count == 0) return (0, 0, 0);
        int run = 0, best = 0, credit = 0;
        var ceiling = r.RestCap * r.RestEveryWeeks;
        for (var t = inRange.Min().ToDateTime(TimeOnly.MinValue); t <= current.ToDateTime(TimeOnly.MinValue); t = t.AddDays(7))
        {
            var w = DateOnly.FromDateTime(t);
            if (attended.Contains(w))
            {
                run++;
                credit = Math.Min(credit + 1, ceiling);
                best = Math.Max(best, run);
            }
            else if (paused.Contains(w) || w == current || run == 0)
            {
                continue;
            }
            else if (credit >= r.RestEveryWeeks)
            {
                credit -= r.RestEveryWeeks;
            }
            else
            {
                run = 0; credit = 0;
            }
        }
        return (run, best, credit / r.RestEveryWeeks);
    }

    [Fact]
    public void The_walk_agrees_with_an_independent_model_and_its_bounds_hold()
    {
        for (var seed = 0; seed < Seeds; seed++)
        {
            var h = Generate(seed);
            var coverage = StreakMath.PausedWeeks(h.Pauses, h.Attended, h.Current, h.Rules.PauseWeeksPerYear);
            var walk = StreakMath.Walk(h.Attended, coverage.Paused, h.Current, h.Rules);
            var model = Model(h.Attended, coverage.Paused.ToHashSet(), h.Current, h.Rules);

            Assert.True((walk.State.Streak, walk.State.Longest, walk.State.Bank) == model, $"seed {seed}: walk {walk.State}, model {model}");
            Assert.True(walk.State.Streak <= walk.State.Longest, $"seed {seed}");
            Assert.True(walk.State.Longest <= h.Attended.Count(w => w <= h.Current), $"seed {seed}");
            Assert.True(walk.State.Bank <= h.Rules.RestCap, $"seed {seed}");
        }
    }

    [Fact]
    public void The_walk_resumed_from_any_intermediate_state_ends_where_one_pass_ends()
    {
        for (var seed = 0; seed < Seeds; seed++)
        {
            var h = Generate(seed);
            var paused = StreakMath.PausedWeeks(h.Pauses, h.Attended, h.Current, h.Rules.PauseWeeksPerYear).Paused;
            var whole = StreakMath.Walk(h.Attended, paused, h.Current, h.Rules);
            if (whole.Weeks.Count < 2) continue;

            var cut = new Random(seed ^ 0x5eed).Next(1, whole.Weeks.Count);
            var start = Replay(whole.Weeks.Take(cut).ToList(), h.Rules, h.Attended, paused);
            var resumed = StreakMath.Resume(start, whole.Weeks[cut].Week, h.Attended, paused, h.Current, h.Rules);
            Assert.True(whole.State == resumed.State, $"seed {seed} cut {cut}: {whole.State} vs {resumed.State}");
        }
    }

    /// <summary>The state after a prefix of already-judged weeks (none of them the current week).</summary>
    private static StreakState Replay(List<WalkedWeek> weeks, StreakRules rules, HashSet<DateOnly> attended, IReadOnlySet<DateOnly> paused)
    {
        var s = StreakState.Empty;
        foreach (var w in weeks) s = StreakMath.Step(s, attended.Contains(w.Week), paused.Contains(w.Week), false, rules).State;
        return s;
    }

    [Fact]
    public void The_result_is_independent_of_the_order_the_inputs_arrive_in()
    {
        for (var seed = 0; seed < Seeds; seed++)
        {
            var h = Generate(seed);
            var rng = new Random(seed * 31 + 7);
            var shuffledPauses = h.Pauses.OrderBy(_ => rng.Next()).ToList();
            var shuffledAttended = h.Attended.OrderBy(_ => rng.Next()).ToHashSet();

            var a = StreakMath.PausedWeeks(h.Pauses, h.Attended, h.Current, h.Rules.PauseWeeksPerYear);
            var b = StreakMath.PausedWeeks(shuffledPauses, shuffledAttended, h.Current, h.Rules.PauseWeeksPerYear);
            Assert.True(a.Paused.SetEquals(b.Paused), $"seed {seed}");
            Assert.Equal(
                StreakMath.Walk(h.Attended, a.Paused, h.Current, h.Rules).State,
                StreakMath.Walk(shuffledAttended, b.Paused, h.Current, h.Rules).State);
        }
    }

    [Fact]
    public void Paused_weeks_are_never_attended_never_future_and_never_over_the_yearly_allowance()
    {
        for (var seed = 0; seed < Seeds; seed++)
        {
            var h = Generate(seed);
            var coverage = StreakMath.PausedWeeks(h.Pauses, h.Attended, h.Current, h.Rules.PauseWeeksPerYear);
            Assert.DoesNotContain(coverage.Paused, w => h.Attended.Contains(w));
            Assert.DoesNotContain(coverage.Paused, w => w > h.Current);
            foreach (var year in coverage.Paused.GroupBy(ClubWeek.YearOf))
            {
                Assert.True(year.Count() <= h.Rules.PauseWeeksPerYear, $"seed {seed}: {year.Count()} paused in {year.Key}");
                Assert.Equal(year.Count(), coverage.UsedIn(year.Key));
            }
        }
    }

    /// <summary>
    /// A member who plays more must never see a shorter streak: with rest weeks ON (and every other
    /// rule drawn at random), adding an attended week, or a paused week, anywhere — before the run,
    /// inside it, or the current week — never lowers the current streak.
    /// </summary>
    [Fact]
    public void Adding_an_attended_or_paused_week_anywhere_never_lowers_the_streak()
    {
        for (var seed = 0; seed < Seeds; seed++)
        {
            var h = Generate(seed);
            var rules = h.Rules.RestCap == 0 ? h.Rules with { RestCap = 1 + (seed % 4) } : h.Rules;
            var paused = StreakMath.PausedWeeks(h.Pauses, h.Attended, h.Current, rules.PauseWeeksPerYear).Paused.ToHashSet();
            var baseline = StreakMath.Walk(h.Attended, paused, h.Current, rules).State.Streak;
            var span = (h.Current.DayNumber - Origin.DayNumber) / 7;
            var rng = new Random(seed + 99);
            for (var k = 0; k < 4; k++)
            {
                var extra = Origin.AddDays(7 * rng.Next(-3, span + 1));
                var moreAttended = h.Attended.Append(extra).ToHashSet();
                var attendedStreak = StreakMath.Walk(moreAttended, paused.Where(w => !moreAttended.Contains(w)).ToHashSet(), h.Current, rules).State.Streak;
                Assert.True(attendedStreak >= baseline, $"seed {seed}: attending {extra} lowered {baseline} to {attendedStreak} ({rules})");

                if (h.Attended.Contains(extra)) continue;
                var morePaused = paused.Append(extra).ToHashSet();
                var pausedStreak = StreakMath.Walk(h.Attended, morePaused, h.Current, rules).State.Streak;
                Assert.True(pausedStreak >= baseline, $"seed {seed}: pausing {extra} lowered {baseline} to {pausedStreak} ({rules})");
            }
        }
    }

    /// <summary>Attending the current week always adds one (whatever the rules): the week only ever counts.</summary>
    [Fact]
    public void Attending_the_current_week_never_lowers_the_streak()
    {
        for (var seed = 0; seed < Seeds; seed++)
        {
            var h = Generate(seed);
            var paused = StreakMath.PausedWeeks(h.Pauses, h.Attended, h.Current, h.Rules.PauseWeeksPerYear).Paused;
            var before = StreakMath.Walk(h.Attended, paused, h.Current, h.Rules).State.Streak;
            var after = StreakMath.Walk(h.Attended.Append(h.Current).ToHashSet(), paused.Where(w => w != h.Current).ToHashSet(), h.Current, h.Rules).State.Streak;
            Assert.True(after >= before, $"seed {seed}");
        }
    }

    /// <summary>
    /// The club zone changes only which week a session falls in, never the walk: sessions placed at
    /// random local times in a zone (DST-observing ones included) map back to the week of their
    /// local date, so the walk over them is the walk over the local weeks.
    /// </summary>
    [Theory]
    [InlineData("Europe/London")]
    [InlineData("America/New_York")]
    [InlineData("Australia/Lord_Howe")]
    [InlineData("Africa/Johannesburg")]
    public void The_zone_moves_only_the_week_assignment(string zoneId)
    {
        var zone = TimeZoneInfo.FindSystemTimeZoneById(zoneId);
        for (var seed = 0; seed < Math.Min(Seeds, 300); seed++)
        {
            var rng = new Random(seed);
            var localWeeks = new HashSet<DateOnly>();
            var instantWeeks = new HashSet<DateOnly>();
            for (var i = rng.Next(1, 40); i > 0; i--)
            {
                var day = new DateOnly(2026, 1, 1).AddDays(rng.Next(0, 420));
                var wall = day.ToDateTime(new TimeOnly(rng.Next(0, 24), rng.Next(0, 60)));
                if (zone.IsInvalidTime(wall)) continue;
                var instant = new DateTimeOffset(wall, zone.GetUtcOffset(wall));
                localWeeks.Add(ClubWeek.KeyOf(day));
                instantWeeks.Add(ClubWeek.KeyOf(zone, instant));
            }
            Assert.True(localWeeks.SetEquals(instantWeeks), $"{zoneId} seed {seed}");
            var current = new DateOnly(2027, 3, 1);
            var rules = new StreakRules(4, 2, 8);
            Assert.Equal(StreakMath.Walk(localWeeks, new HashSet<DateOnly>(), current, rules).State,
                StreakMath.Walk(instantWeeks, new HashSet<DateOnly>(), current, rules).State);
        }
    }
}
