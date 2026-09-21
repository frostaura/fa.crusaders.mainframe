namespace Crusaders.Mainframe.Api.Domain;

/// <summary>Whether a schedule still produces occurrences. A schedule that ran is history and is never deleted.</summary>
public enum ScheduleStatus
{
    Active = 0,
    Ended = 1,
}

/// <summary>
/// A repeating court booking — league night, a coaching block, a practice slot.
///
/// <para>
/// <b>A constrained weekly rule, not RFC 5545 RRULE.</b> The club's actual need is a strict
/// subset: "every Tuesday 18:00–21:00 on courts 1 and 2, from 7 October until 15 December" is
/// <c>FREQ=WEEKLY;BYDAY=TU;UNTIL=…</c> and nothing more. The expensive parts of RRULE —
/// <c>RECURRENCE-ID</c> overrides and their <c>UID</c> matching, <c>EXDATE</c> semantics that
/// real providers do not honour consistently, infinite series, and turning a range query into
/// "expand every instance then check exceptions" — are calendar INTEROP cost, and there is no
/// calendar to interop with: nothing in this product imports or exports iCalendar.
/// </para>
///
/// <para>
/// <b>And the stored form has to be readable by a volunteer admin inside a refusal message.</b>
/// "Tuesdays 18:00–21:00 until 15 December" is; <c>FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T000000Z</c>
/// is not, and a refusal that quotes it is a refusal nobody can act on.
/// </para>
///
/// <para>
/// <b>The choice is reversible, which is why it is safe.</b> These columns map one-to-one onto
/// <c>FREQ=WEEKLY;INTERVAL=n;BYDAY=…;UNTIL=…</c>, so an iCalendar export would be a projection
/// over them rather than a migration.
/// </para>
/// </summary>
public sealed class BookingSchedule : ITenantScoped
{
    /// <summary>Sunday. The bitmask's low bit, matching <see cref="DayOfWeek"/>'s own numbering.</summary>
    public const int SundayBit = 1;

    /// <summary>Every weekday set. A mask outside <c>[1, 127]</c> names no day or a day that does not exist.</summary>
    public const int AllDays = 127;

    /// <summary>Minutes in a day — the ceiling <see cref="EndMinute"/> may take.</summary>
    public const int MinutesPerDay = 1440;

    /// <summary>Longest interval a club's calendar means anything by. Eight weeks is two months.</summary>
    public const int MaxIntervalWeeks = 8;

    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>What the club calls this schedule. Unique per tenant, case-insensitively.</summary>
    public required string Name { get; set; }

    /// <summary>What the GRID shows on each occurrence — "League — Div 1". Becomes each block's label.</summary>
    public required string Label { get; set; }

    /// <summary>
    /// Weekday bitmask, <c>1&lt;&lt;0</c> = Sunday … <c>1&lt;&lt;6</c> = Saturday.
    ///
    /// <para>
    /// Sunday-first because that is <see cref="DayOfWeek"/>'s own numbering, so the shift is the
    /// enum value and no conversion table exists to get backwards.
    /// </para>
    /// </summary>
    public int DaysOfWeek { get; set; }

    /// <summary>Local minutes past midnight the occurrence starts at. DST-stable by construction.</summary>
    public int StartMinute { get; set; }

    /// <summary>Local minutes past midnight it ends. Greater than the start, at most 1440 — no midnight crossing.</summary>
    public int EndMinute { get; set; }

    /// <summary>The first club-local date the rule may produce an occurrence on.</summary>
    public DateOnly StartDate { get; set; }

    /// <summary>The last, inclusive — or null for an open-ended series.</summary>
    public DateOnly? EndDate { get; set; }

    /// <summary>1..8. Anchored on <see cref="StartDate"/>'s own week, so "every other Tuesday" is stable.</summary>
    public short IntervalWeeks { get; set; } = 1;

    public ScheduleStatus Status { get; set; } = ScheduleStatus.Active;

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public Guid CreatedByUserId { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>
    /// How far ahead occurrences have actually been written.
    ///
    /// <para>
    /// Advanced only after a materialisation tick completes without conflict, so a horizon that
    /// has stalled — because a member booked into it, or a court was deactivated — is visible on
    /// the schedule's own row rather than discovered on the night.
    /// </para>
    /// </summary>
    public DateTimeOffset? MaterialisedThrough { get; set; }
}

/// <summary>
/// One court a schedule occupies.
///
/// <para>
/// <b>A child table, not a <c>uuid[]</c> column.</b> The conflict check joins against
/// <c>bookings.CourtId</c>, and a join is what this repository's style does everywhere else; an
/// array would need <c>= ANY</c> in every reader and could not carry a unique constraint saying
/// a court appears once.
/// </para>
/// </summary>
public sealed class BookingScheduleCourt : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid ScheduleId { get; set; }
    public Guid CourtId { get; set; }
}

/// <summary>What a single-occurrence edit did to one date.</summary>
public enum ScheduleExceptionKind
{
    /// <summary>That date does not happen. Its rows are lifted and never re-materialised.</summary>
    Skipped = 0,

    /// <summary>That date happens at different times from the rule's.</summary>
    Overridden = 1,
}

/// <summary>
/// One date of a schedule that does not follow the rule — GOAL item 14's "these schedules and so
/// on should be editable… the future occurrences of a schedule would change if needed".
///
/// <para>
/// <b>An exception row rather than splitting the series.</b> Google Calendar's model — end the
/// old series, create a new one from the edit date — fragments one league night across three
/// schedule rows over a season, and "who changed league night, and when" becomes a join instead
/// of a read. One schedule row plus an append-only change record answers it in one query, which
/// is what the GOAL asks for.
/// </para>
/// </summary>
public sealed class BookingScheduleException : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid ScheduleId { get; set; }

    /// <summary>The club-local date this exception is about.</summary>
    public DateOnly OccurrenceDate { get; set; }

    public ScheduleExceptionKind Kind { get; set; }

    /// <summary>Local minutes past midnight. Set only on <see cref="ScheduleExceptionKind.Overridden"/>.</summary>
    public int? StartMinute { get; set; }

    /// <summary>The same for the end.</summary>
    public int? EndMinute { get; set; }

    /// <summary>The admin's own words. Required when a date is skipped — somebody lost a court.</summary>
    public string? Reason { get; set; }

    public Guid CreatedByUserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
