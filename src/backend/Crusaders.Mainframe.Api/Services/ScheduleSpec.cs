namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The rule an admin described, before it is a row. <paramref name="SkipDates"/> are dates the
/// admin chose to leave out on creation — the way past court-time nobody can cancel (a no-show,
/// a game already played): each one the rule produces becomes a skipped date on the series.
/// </summary>
public sealed record ScheduleSpec(
    string Name, string Label, int DaysOfWeek, int StartMinute, int EndMinute,
    DateOnly StartDate, DateOnly? EndDate, short IntervalWeeks, IReadOnlyList<Guid> CourtIds,
    IReadOnlyCollection<DateOnly>? SkipDates = null);

/// <summary>One booking or block that already holds court-time a schedule wants.</summary>
public sealed record ScheduleConflict(
    DateOnly OccurrenceDate, Guid CourtId, string? CourtName,
    DateTimeOffset StartsAt, DateTimeOffset EndsAt,
    Guid BookingId, string Status, string Kind, string? Label,
    string? MemberName, int AmountMinutes, int WouldRefundMinutes, bool Cancellable);

/// <summary>
/// The dry run: what a rule would produce, and what already stands in its way.
/// <paramref name="LeftOut"/> is the subset of the spec's skip dates the rule really produces —
/// the dates a create records as skipped.
/// </summary>
public sealed record SchedulePreview(
    int Occurrences, DateOnly? First, DateOnly? Last, int RowsToCreate,
    IReadOnlyList<ScheduleConflict> Conflicts, IReadOnlyList<DateOnly> LeftOut);

/// <summary>How many occurrence rows a materialisation wrote, and how far it got.</summary>
public sealed record MaterialisationOutcome(int RowsWritten, DateTimeOffset? MaterialisedThrough, int Collisions);

/// <summary>
/// The three lookup maps a conflict row needs, resolved once per preview and passed together.
///
/// <para>
/// A parameter object rather than three arguments, because the complexity gate caps a
/// signature at six and these three are always read as a set — the same reasoning
/// <c>BookingPayer</c> already carries.
/// </para>
/// </summary>
public readonly record struct ConflictNames(
    IReadOnlyDictionary<Guid, string> Courts,
    IReadOnlyDictionary<Guid, string> Members,
    IReadOnlyDictionary<Guid, string> Schedules);
