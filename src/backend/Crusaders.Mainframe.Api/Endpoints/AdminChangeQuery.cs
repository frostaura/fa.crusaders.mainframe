using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// What a club asked its own change record for — area, action, actor, subject and a range.
///
/// <para>
/// <b>Every closed-set parameter is REFUSED when it is not one of ours, never silently
/// ignored.</b> That is <see cref="DoorLogQuery"/>'s rule and it is here for the same reason:
/// <c>?area=bookings</c> (plural, which is what a console will send first) answering
/// <c>200</c> with an empty list reads as "this club's admins changed no bookings", which is a
/// different and false sentence. The range is clamped, the limit is clamped, the vocabularies
/// are refused.
/// </para>
///
/// <para>
/// <b>There is no retention clamp on the range, and that is the one difference from the door
/// log.</b> These rows are never deleted, so a <c>from</c> of three years ago is a question
/// this table can actually answer. The response says so in words rather than leaving an admin
/// to infer it from an empty list.
/// </para>
///
/// <para>
/// <b><c>subject_id</c> is accepted for a USER only on the member and <c>credit</c> (minutes) areas.</b> It
/// answers "what did an admin do to this member", never "where was this member" — the
/// structural distinction the night trace turns on. Filtering the record by a user id without
/// naming one of those two areas would be a second way to ask the trace's question through a
/// surface that has no business answering it, so it is refused.
/// </para>
/// </summary>
public sealed record AdminChangeQuery(
    string? Area, string? Action, Guid? Actor, string? SubjectKind, Guid? SubjectId,
    DateTimeOffset From, DateTimeOffset To, int Limit, AdminChangeCursor? Cursor)
{
    /// <summary>The club's zone, resolved once when the request was parsed.</summary>
    public required TimeZoneInfo Zone { get; init; }

    /// <summary>The name of <see cref="Zone"/> as the wire reports it.</summary>
    public required string Timezone { get; init; }

    /// <summary>Rows per page when the caller does not ask. A console page.</summary>
    public const int DefaultLimit = 50;

    /// <summary>Most rows one page returns, clamped rather than refused.</summary>
    public const int MaxLimit = 200;

    /// <summary>Most rows one export contains — the door log's ceiling, for the door log's reasons.</summary>
    public const int MaxExportRows = 10_000;

    /// <summary>How far back the record looks when the caller names no range. Thirty club days.</summary>
    public const int DefaultWindowDays = 30;

    /// <summary>The earliest instant this endpoint will resolve. Nothing predates the product.</summary>
    public static readonly DateTimeOffset Floor = new(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);

    public const string AreaInvalid = "area_invalid";
    public const string ActionInvalid = "action_invalid";
    public const string ActorInvalid = "actor_invalid";
    public const string SubjectKindInvalid = "subject_kind_invalid";
    public const string SubjectIdInvalid = "subject_id_invalid";

    /// <summary>
    /// The refusal when <c>?subject_id=</c> names a user outside the two areas where a user is
    /// what a subject means. See the type's own summary — this is the night-trace boundary.
    /// </summary>
    public const string SubjectIdNeedsArea = "subject_id_needs_area";

    public const string LimitInvalid = DoorLogQuery.LimitInvalid;
    public const string CursorInvalid = DoorLogQuery.CursorInvalid;
    public const string FromInvalid = DoorLogQuery.FromInvalid;
    public const string ToInvalid = DoorLogQuery.ToInvalid;

    /// <summary>What the response says about how long these rows live. A sentence, because it is one.</summary>
    public const string RetentionSentence =
        "kept indefinitely — these records cannot be deleted, including by admins";

    /// <summary>
    /// A uuid query parameter, and whether it was present and unreadable.
    ///
    /// <para>
    /// Present-and-unreadable is a REFUSAL, never a silent null: <c>?actor=notauuid</c>
    /// answering 200 with the whole club's record, under a heading naming one admin, is the
    /// <c>door_invalid</c> defect at a different parameter.
    /// </para>
    /// </summary>
    private static (Guid? Value, bool Invalid) Id(HttpRequest request, string name)
    {
        var text = Text(request, name);
        if (text is null) return (null, false);
        return Guid.TryParse(text, out var parsed) ? (parsed, false) : (null, true);
    }

    /// <summary>
    /// Where in the list to start and how much to take — the cursor refused when malformed, the
    /// limit clamped by the caller.
    ///
    /// <para>
    /// A malformed cursor is a <c>400</c> rather than page one: a console that truncated it
    /// would otherwise get page one back labelled as page nine, and an admin walks a list that
    /// silently restarted.
    /// </para>
    /// </summary>
    private static (AdminChangeCursor? Cursor, int? Limit, string? Error) Paging(HttpRequest request)
    {
        var cursorText = Text(request, "cursor");
        var cursor = AdminChangeCursor.Parse(cursorText);
        if (cursorText is not null && cursor is null) return (null, null, CursorInvalid);

        var limitText = Text(request, "limit");
        if (limitText is null) return (cursor, null, null);

        return int.TryParse(limitText, out var parsed)
            ? (cursor, parsed, null)
            : (null, null, LimitInvalid);
    }

    /// <summary>
    /// The five closed-set filters, each REFUSED when it is not one of ours.
    ///
    /// <para>
    /// Split out of <see cref="Parse"/> because the two halves answer different questions —
    /// "which rows" and "which page of them" — and together they were past the complexity
    /// gate. Every refusal here is a VOCABULARY refusal: <c>?area=bookings</c> (plural, which
    /// is what a console sends first) answering <c>200</c> with an empty list reads as "this
    /// club's admins changed no bookings", which is a different and false sentence.
    /// </para>
    /// </summary>
    private static ((string? Area, string? Action, Guid? Actor, string? SubjectKind, Guid? SubjectId) Filters,
        string? Error) Filters(HttpRequest request)
    {
        var none = ((string?)null, (string?)null, (Guid?)null, (string?)null, (Guid?)null);

        var area = Text(request, "area");
        if (area is not null && Array.IndexOf(AdminChangeAreas.All, area) < 0) return (none, AreaInvalid);

        var action = Text(request, "action");
        if (action is not null && Array.IndexOf(AdminChangeActions.All, action) < 0) return (none, ActionInvalid);

        var (actor, actorBad) = Id(request, "actor");
        if (actorBad) return (none, ActorInvalid);

        var subjectKind = Text(request, "subject_kind");
        if (subjectKind is not null && Array.IndexOf(AdminChangeSubjects.All, subjectKind) < 0)
            return (none, SubjectKindInvalid);

        var (subjectId, subjectBad) = Id(request, "subject_id");
        if (subjectBad) return (none, SubjectIdInvalid);

        return ((area, action, actor, subjectKind, subjectId), null);
    }
    /// <summary>
    /// Reads the query string. Refuses the five closed sets and the three malformed-value
    /// cases; clamps the limit and the range.
    /// </summary>
    public static (AdminChangeQuery? Query, string? Error) Parse(
        HttpRequest request, TenantSettingsView settings, DateTimeOffset now, Guid? schedule = null)
    {
        var (zone, timezone, _) = DoorClock.ZoneOf(settings);

        var (filters, filterError) = Filters(request);
        if (filterError is not null) return (null, filterError);
        var (area, action, actor, subjectKind, subjectId) = filters;

        // A schedule's own view is a subject filter the ROUTE supplies, not one the caller
        // names, so it overrides rather than combines.
        if (schedule is { } scheduleId)
        {
            subjectKind = AdminChangeSubjects.Schedule;
            subjectId = scheduleId;
        }
        else if (subjectId is not null
                 && (subjectKind is null || subjectKind == AdminChangeSubjects.User)
                 && area is not AdminChangeAreas.Member and not AdminChangeAreas.Credit)
        {
            // Asking this record about a person, without saying which kind of administrative
            // act you mean, is the night trace's question arriving at the wrong surface.
            return (null, SubjectIdNeedsArea);
        }

        var (range, rangeError) = Range(request, zone, now);
        if (rangeError is not null) return (null, rangeError);
        if (range is not { } window) return (null, DoorPeriod.RangeConflict);

        var from = window.From.ToUniversalTime();
        var to = window.To.ToUniversalTime();
        if (from < Floor) from = Floor;
        if (to < from) to = from;

        var (cursor, limit, pagingError) = Paging(request);
        if (pagingError is not null) return (null, pagingError);

        return (new AdminChangeQuery(
            Area: area, Action: action, Actor: actor, SubjectKind: subjectKind, SubjectId: subjectId,
            From: from, To: to,
            Limit: Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit),
            Cursor: cursor)
        {
            Zone = zone,
            Timezone = timezone,
        }, null);
    }

    /// <summary>
    /// The window this request asks for — <see cref="DoorPeriod"/>'s grammar verbatim, because
    /// a club that learned it on the door log should not learn a second one here.
    ///
    /// <para>
    /// Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static ((DateTimeOffset From, DateTimeOffset To)? Window, string? Error) Range(
        HttpRequest request, TimeZoneInfo zone, DateTimeOffset now)
    {
        var period = Text(request, "period");
        var day = Text(request, "day");
        var explicitEdge = Text(request, "from") is not null || Text(request, "to") is not null;

        var named = (period is not null ? 1 : 0) + (day is not null ? 1 : 0) + (explicitEdge ? 1 : 0);
        if (named > 1) return (null, DoorPeriod.RangeConflict);

        if (period is not null)
        {
            return DoorPeriod.Resolve(period, zone, now) is { } window
                ? ((window.From, window.To), null)
                : (null, DoorPeriod.PeriodInvalid);
        }

        if (day is not null)
        {
            return DoorPeriod.Day(day, zone, now) is { } window
                ? ((window.From, window.To), null)
                : (null, DoorPeriod.DayInvalid);
        }

        var (fromValue, fromBad) = Instant(request, "from");
        if (fromBad) return (null, FromInvalid);
        var (toValue, toBad) = Instant(request, "to");
        if (toBad) return (null, ToInvalid);

        var defaultFrom = DoorClock.StartOfLocalDay(
            zone, DoorClock.LocalDateOf(zone, now).AddDays(-(DefaultWindowDays - 1)));
        return ((fromValue ?? defaultFrom, toValue ?? now), null);
    }

    /// <summary>The rows this query names, newest first, tenant-filtered by the global query filter.</summary>
    public IQueryable<AdminChangeLog> Filtered(MainframeDbContext db)
    {
        var rows = db.AdminChangeLogs.AsNoTracking()
            .Where(a => a.OccurredAt >= From && a.OccurredAt < To);

        if (Area is { } area) rows = rows.Where(a => a.Area == area);
        if (Action is { } action) rows = rows.Where(a => a.Action == action);
        if (Actor is { } actor) rows = rows.Where(a => a.ActorUserId == actor);
        if (SubjectKind is { } kind) rows = rows.Where(a => a.SubjectKind == kind);
        if (SubjectId is { } subject) rows = rows.Where(a => a.SubjectId == subject);

        return rows;
    }

    /// <summary>
    /// <see cref="Filtered"/> plus the cursor, ordered by the same pair the cursor keys on.
    ///
    /// <para>
    /// The sort column and the cursor column must be the same or pages silently skip and repeat
    /// rows at every boundary — the defect <see cref="DoorLogCursor"/> documents at length.
    /// </para>
    /// </summary>
    public IQueryable<AdminChangeLog> Apply(MainframeDbContext db)
    {
        var rows = Filtered(db);

        if (Cursor is { } cursor)
        {
            rows = rows.Where(a =>
                a.OccurredAt < cursor.At || (a.OccurredAt == cursor.At && a.Id.CompareTo(cursor.Id) < 0));
        }

        return rows.OrderByDescending(a => a.OccurredAt).ThenByDescending(a => a.Id);
    }

    /// <summary>How many rows the FILTER holds, over the whole range rather than over the page.</summary>
    public Task<int> TotalAsync(MainframeDbContext db, CancellationToken ct)
        => Filtered(db).CountAsync(ct);

    private static string? Text(HttpRequest request, string name)
    {
        var value = request.Query[name].ToString();
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    private static (DateTimeOffset? Value, bool Invalid) Instant(HttpRequest request, string name)
    {
        var text = Text(request, name);
        if (text is null) return (null, false);
        return DateTimeOffset.TryParse(
            text, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.RoundtripKind, out var parsed)
            ? (parsed, false)
            : (null, true);
    }
}
