using System.Text.Json;
using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>The part of a schedule that decides its dates and hours: which days, what times, how often.</summary>
public sealed record ScheduleRule(int DaysOfWeek, int StartMinute, int EndMinute, short IntervalWeeks);

/// <summary>
/// A rule a "from this date on" change replaced, and the first date it no longer governs.
/// Stored on the schedule as <c>EarlierRulesJson</c>, oldest first.
/// </summary>
public sealed record EarlierScheduleRule(
    [property: JsonPropertyName("until")] DateOnly Until,
    [property: JsonPropertyName("days_of_week")] int DaysOfWeek,
    [property: JsonPropertyName("start_minute")] int StartMinute,
    [property: JsonPropertyName("end_minute")] int EndMinute,
    [property: JsonPropertyName("interval_weeks")] short IntervalWeeks)
{
    public ScheduleRule Rule => new(DaysOfWeek, StartMinute, EndMinute, IntervalWeeks);
}

/// <summary>
/// Which rule governs which date of a schedule (review round 4 wave B, the A4-3 remainder).
///
/// <para>
/// <b>Why the replaced rules are kept.</b> A change "from 20 Oct" left the schedule with one rule
/// and no date it governs from, so everything that expands the rule — the materialiser, the date
/// list, the next night, the edit's own conflict check — applied the NEW rule to the dates before
/// 20 Oct: a Tuesday league moved to Wednesdays booked the Wednesdays between today and 20 Oct.
/// Round 4's first fix kept the earlier dates' hours only because their rows were already held;
/// a date past the horizon, or one a clash had kept unheld, still came out at the new rule.
/// </para>
///
/// <para>
/// <b>Why a list, not one earlier rule.</b> Two changes can be waiting at once (days from week
/// three, hours from week four), and each date must be read at the rule in force on it. A new
/// change that starts EARLIER than one already waiting supersedes it from its own date: every
/// kept rule is cut back to end there, and the one the change replaces is kept only if it still
/// governed some date before it. The list is never pruned of past rules — the date list reads a
/// held past date at the rule it was held under.
/// </para>
/// </summary>
public static class ScheduleRuleHistory
{
    private static readonly JsonSerializerOptions Json = new();

    /// <summary>The schedule's own (latest) rule.</summary>
    public static ScheduleRule Current(BookingSchedule s) => new(s.DaysOfWeek, s.StartMinute, s.EndMinute, s.IntervalWeeks);

    /// <summary>The rules the schedule's changes replaced, oldest first; empty when it was never changed from a date.</summary>
    public static IReadOnlyList<EarlierScheduleRule> Earlier(BookingSchedule s)
    {
        if (string.IsNullOrWhiteSpace(s.EarlierRulesJson)) return [];
        return JsonSerializer.Deserialize<List<EarlierScheduleRule>>(s.EarlierRulesJson, Json) ?? [];
    }

    /// <summary>The rule in force on <paramref name="day"/>: the first kept rule that still governed it, else the current one.</summary>
    public static ScheduleRule For(DateOnly day, IReadOnlyList<EarlierScheduleRule> earlier, ScheduleRule current)
    {
        foreach (var rule in earlier)
        {
            if (day < rule.Until) return rule.Rule;
        }
        return current;
    }

    /// <summary>The rule in force on <paramref name="day"/> for a stored schedule.</summary>
    public static ScheduleRule For(BookingSchedule s, DateOnly day) => For(day, Earlier(s), Current(s));

    /// <summary>
    /// The kept rules once the schedule's current rule is replaced from <paramref name="effective"/>
    /// on. Called BEFORE the new rule is applied to the row.
    /// </summary>
    public static IReadOnlyList<EarlierScheduleRule> Supersede(BookingSchedule s, DateOnly effective)
    {
        var kept = new List<EarlierScheduleRule>();
        var from = DateOnly.MinValue;
        foreach (var rule in Earlier(s))
        {
            if (from >= effective) break;
            kept.Add(rule.Until > effective ? rule with { Until = effective } : rule);
            from = rule.Until;
        }

        // The rule being replaced governed [from, ∞); it is kept only for the dates it still has.
        if (from < effective)
        {
            var current = Current(s);
            kept.Add(new EarlierScheduleRule(
                effective, current.DaysOfWeek, current.StartMinute, current.EndMinute, current.IntervalWeeks));
        }
        return kept;
    }

    /// <summary>The stored form, or null for none.</summary>
    public static string? Store(IReadOnlyList<EarlierScheduleRule> rules)
        => rules.Count == 0 ? null : JsonSerializer.Serialize(rules, Json);
}
