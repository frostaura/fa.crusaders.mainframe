namespace Crusaders.Mainframe.Api.Services;

/// <summary>One row a schedule holds, as the date list reads it.</summary>
public sealed record HeldRow(
    Guid Id, Guid CourtId, DateOnly? Date, DateTimeOffset StartsAt, DateTimeOffset EndsAt);

/// <summary>
/// One date of a schedule as the console lists it: the hours it is HELD at, and the rule's own.
/// </summary>
/// <param name="Status"><c>past</c>, <c>skipped</c>, <c>overridden</c> or <c>scheduled</c>.</param>
/// <param name="RuleStartsAt">Null for a held date the current rule no longer produces.</param>
/// <param name="OnRule">True when the date is held at the rule's own times, or not held yet.</param>
public sealed record ScheduleDate(
    DateOnly Date,
    DateTimeOffset StartsAt,
    DateTimeOffset EndsAt,
    string Status,
    DateTimeOffset? RuleStartsAt,
    DateTimeOffset? RuleEndsAt,
    bool OnRule,
    IReadOnlyList<HeldRow> Rows);

/// <summary>
/// The dates a schedule's detail lists (review round 4, A4-3).
///
/// <para>
/// <b>A held date is reported at the hours it is held at.</b> A "from this date on" change keeps
/// the nights before its date at their old hours — they are already on members' grids — while
/// the rule now carries the new ones, so the list drew every date at the new hours and the club
/// saw "18:30" for a court it was holding from 18:00. A date the new rule no longer produces
/// (a day-of-week change) but that is still held is listed too: it is happening.
/// </para>
/// </summary>
public static class ScheduleDates
{
    public static IReadOnlyList<ScheduleDate> Project(
        IReadOnlyList<ScheduleOccurrence> rule,
        IReadOnlyList<HeldRow> held,
        TimeZoneInfo zone,
        DateOnly from,
        DateOnly to,
        DateTimeOffset now)
    {
        var rowsByDate = held
            .GroupBy(r => r.Date ?? DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(r.StartsAt, zone).DateTime))
            .ToDictionary(g => g.Key, g => (IReadOnlyList<HeldRow>)g.OrderBy(r => r.StartsAt).ToList());
        var ruleByDate = rule.GroupBy(o => o.Date).ToDictionary(g => g.Key, g => g.First());

        return ruleByDate.Keys
            .Concat(rowsByDate.Keys.Where(d => d >= from && d <= to))
            .Distinct()
            .Order()
            .Select(date => One(
                date,
                ruleByDate.TryGetValue(date, out var o) ? o : null,
                rowsByDate.GetValueOrDefault(date) ?? [],
                zone,
                now))
            .ToList();
    }

    private static ScheduleDate One(
        DateOnly date, ScheduleOccurrence? rule, IReadOnlyList<HeldRow> rows, TimeZoneInfo zone, DateTimeOffset now)
    {
        var startsAt = rows.Count > 0 ? TimeZoneInfo.ConvertTime(rows.Min(r => r.StartsAt), zone) : rule!.Value.StartsAt;
        var endsAt = rows.Count > 0 ? TimeZoneInfo.ConvertTime(rows.Max(r => r.EndsAt), zone) : rule!.Value.EndsAt;
        var onRule = rule is { } o && rows.All(r => r.StartsAt == o.StartsAt && r.EndsAt == o.EndsAt);

        return new ScheduleDate(
            date, startsAt, endsAt, StatusOf(rule, startsAt, now),
            rule?.StartsAt, rule?.EndsAt, onRule,
            rows.Select(r => r with
            {
                StartsAt = TimeZoneInfo.ConvertTime(r.StartsAt, zone),
                EndsAt = TimeZoneInfo.ConvertTime(r.EndsAt, zone),
            }).ToList());
    }

    private static string StatusOf(ScheduleOccurrence? rule, DateTimeOffset startsAt, DateTimeOffset now)
    {
        if (startsAt <= now) return "past";
        return rule?.Status switch
        {
            ScheduleOccurrenceStatus.Skipped => "skipped",
            ScheduleOccurrenceStatus.Overridden => "overridden",
            _ => "scheduled",
        };
    }
}
