using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>Which half of the error log a request is asking about.</summary>
public enum DeviceErrorState
{
    /// <summary>Still open — nobody has resolved it. The default, because it is the question the page exists to answer.</summary>
    Open = 0,

    /// <summary>Resolved, by an admin or by the retention sweep's ageing-out.</summary>
    Resolved = 1,

    /// <summary>Both.</summary>
    All = 2,
}

/// <summary>
/// What the club's monitoring page was asked for — board, severity, code, state and a window —
/// and the refusals that stop it answering a question it was not asked.
///
/// <para>
/// <b>This is <see cref="DoorLogQuery"/>'s grammar, reused rather than re-invented.</b> The range
/// may be named three ways and only one at a time (<c>?period=</c> | <c>?day=</c> |
/// <c>?from=&amp;to=</c>), the limit is clamped rather than refused, the cursor is
/// <see cref="DoorLogCursor"/>'s keyset, and every closed vocabulary is refused by name. A second
/// grammar on a second admin list is two grammars a console has to get right, and the one that
/// drifts is always the newer.
/// </para>
///
/// <para>
/// <b>The one deliberate difference is the DEFAULT WINDOW, and it is a correctness difference.</b>
/// The door log defaults to a rolling day because a door's question is "what happened last
/// night". An error log's default question is "what is wrong with the club's estate right now",
/// and a fault first seen on Tuesday is still wrong on Friday — so the default range is the
/// club's whole retention rather than twenty-four hours. Under a day's default, four broken
/// boards whose last report was on Tuesday would read as <c>open: 0</c>, which is the one answer
/// this page must never give while a court is dark.
/// </para>
/// </summary>
public sealed record DeviceErrorQuery(
    Guid? Device, DeviceErrorSeverity? Severity, string? Code, DeviceErrorState State,
    DateTimeOffset From, DateTimeOffset To, int Limit, DoorLogCursor? Cursor, int RetentionDays)
{
    /// <summary>The club's zone, resolved once at parse time, so the range, the wire's <c>timezone</c> and the export's filename are written in one.</summary>
    public required TimeZoneInfo Zone { get; init; }

    /// <summary>The name of <see cref="Zone"/> as the wire reports it — UTC's when the stored id is not one.</summary>
    public required string Timezone { get; init; }

    /// <summary>Rows per page when the caller does not ask. A console page.</summary>
    public const int DefaultLimit = 50;

    /// <summary>Most rows one page will return, clamped rather than refused.</summary>
    public const int MaxLimit = 200;

    /// <summary>The refusal when <c>?severity=</c> is not one of the four.</summary>
    public const string SeverityInvalid = "severity_invalid";

    /// <summary>
    /// The refusal when <c>?code=</c> is not one this server can write.
    ///
    /// <para>
    /// <b>Refused, not silently ignored.</b> <c>?code=bogus</c> answering <c>200</c> with an empty
    /// list reads to an admin as "nothing is wrong" rather than "that is not a code" — which is
    /// <see cref="DoorLogQuery.ReasonInvalid"/>'s own argument, and it is sharper here: the
    /// sentence an admin takes away from an empty monitoring page is that the club's hardware is
    /// healthy.
    /// </para>
    /// </summary>
    public const string CodeInvalid = "code_invalid";

    /// <summary>The refusal when <c>?state=</c> is not <c>open</c>, <c>resolved</c> or <c>all</c>.</summary>
    public const string StateInvalid = "state_invalid";

    /// <summary>The refusal when <c>?device=</c> is present and is not a UUID. See <see cref="DoorLogQuery.DoorInvalid"/>.</summary>
    public const string DeviceInvalid = "device_invalid";

    /// <summary>
    /// The refusal when <c>?limit=</c> is present and is not an integer.
    ///
    /// <para>
    /// A value out of RANGE is clamped, because a console asking for too many rows is
    /// unambiguous; a value that is not a number cannot be clamped to anything. Not named in the
    /// design's refusal list, and present because the grammar this one reuses has it — a limit
    /// that falls back to fifty on a typo is a page an admin believes is filtered.
    /// </para>
    /// </summary>
    public const string LimitInvalid = "limit_invalid";

    /// <summary>The wire spelling of each state, and the closed set <c>?state=</c> accepts.</summary>
    public const string OpenState = "open";

    /// <inheritdoc cref="OpenState"/>
    public const string ResolvedState = "resolved";

    /// <inheritdoc cref="OpenState"/>
    public const string AllState = "all";

    /// <summary>
    /// Reads the query string, clamps what can be clamped, and refuses every closed vocabulary by
    /// name.
    ///
    /// <para>
    /// The range is clamped to the club's own retention rather than merely defaulted to it, for
    /// <see cref="DoorLogQuery.Parse"/>'s reason: the page states a retention number, and a list
    /// answering a <c>from</c> of a year ago would be showing a club data its own page says it no
    /// longer keeps.
    /// </para>
    /// </summary>
    public static (DeviceErrorQuery? Query, string? Error) Parse(
        HttpRequest request, TenantSettingsView settings, DateTimeOffset now)
    {
        var retentionDays = MonitoringSettings.RetentionDays(settings);
        var floor = now.AddDays(-retentionDays).ToUniversalTime();
        var (zone, timezone, _) = DoorClock.ZoneOf(settings);

        var (severity, severityBad) = SeverityOf(request);
        if (severityBad) return (null, SeverityInvalid);

        var code = Text(request, "code");
        if (code is not null && !DeviceErrorCodes.IsKnown(code.ToLowerInvariant())) return (null, CodeInvalid);

        var (state, stateBad) = StateOf(request);
        if (stateBad) return (null, StateInvalid);

        var deviceText = Text(request, "device");
        if (deviceText is not null && !Guid.TryParse(deviceText, out _)) return (null, DeviceInvalid);
        var device = deviceText is null ? (Guid?)null : Guid.Parse(deviceText);

        var (range, rangeError) = Range(request, zone, now, floor);
        if (rangeError is not null) return (null, rangeError);
        if (range is not { } window) return (null, DoorPeriod.RangeConflict);

        var from = window.From < floor ? floor : window.From;
        var to = window.To < from ? from : window.To;

        var cursorText = Text(request, "cursor");
        var cursor = DoorLogCursor.Parse(cursorText);
        if (cursorText is not null && cursor is null) return (null, DoorLogQuery.CursorInvalid);

        var (limit, limitBad) = Number(request, "limit");
        if (limitBad) return (null, LimitInvalid);

        return (new DeviceErrorQuery(
            Device: device,
            Severity: severity,
            Code: code?.ToLowerInvariant(),
            State: state,
            From: from,
            To: to,
            Limit: Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit),
            Cursor: cursor,
            RetentionDays: retentionDays)
        {
            Zone = zone,
            Timezone = timezone,
        }, null);
    }

    /// <summary>
    /// The window this request asks for, defaulting to the club's whole retention. Block body for
    /// the lizard reason in <c>memory/gotchas.md</c>.
    /// </summary>
    private static ((DateTimeOffset From, DateTimeOffset To)? Window, string? Error) Range(
        HttpRequest request, TimeZoneInfo zone, DateTimeOffset now, DateTimeOffset floor)
    {
        var period = Text(request, "period");
        var day = Text(request, "day");
        var explicitEdge = Text(request, "from") is not null || Text(request, "to") is not null;

        var named = (period is not null ? 1 : 0) + (day is not null ? 1 : 0) + (explicitEdge ? 1 : 0);
        if (named > 1) return (null, DoorPeriod.RangeConflict);

        if (period is not null)
        {
            var resolved = DoorPeriod.Resolve(period, zone, now);
            return resolved is { } window
                ? ((window.From.ToUniversalTime(), window.To.ToUniversalTime()), null)
                : (null, DoorPeriod.PeriodInvalid);
        }

        if (day is not null)
        {
            var resolved = DoorPeriod.Day(day, zone, now);
            return resolved is { } window
                ? ((window.From.ToUniversalTime(), window.To.ToUniversalTime()), null)
                : (null, DoorPeriod.DayInvalid);
        }

        // .ToUniversalTime() at the query boundary and never at the wire boundary: Npgsql refuses
        // a DateTimeOffset with a non-zero offset on a timestamptz, and `?from=…+02:00` is exactly
        // what a console in a club's own zone sends. See memory/gotchas-postgres-offsets.md.
        var (fromValue, fromBad) = DoorLogQuery.Instant(request, "from");
        if (fromBad) return (null, DoorLogQuery.FromInvalid);
        var (toValue, toBad) = DoorLogQuery.Instant(request, "to");
        if (toBad) return (null, DoorLogQuery.ToInvalid);

        return (((fromValue ?? floor).ToUniversalTime(), (toValue ?? now).ToUniversalTime()), null);
    }

    /// <summary>The severity this request names, and whether it named one this server does not have.</summary>
    private static (DeviceErrorSeverity? Value, bool Invalid) SeverityOf(HttpRequest request)
    {
        if (Text(request, "severity") is not { } text) return (null, false);
        return text.ToLowerInvariant() switch
        {
            "info" => (DeviceErrorSeverity.Info, false),
            "warning" => (DeviceErrorSeverity.Warning, false),
            "error" => (DeviceErrorSeverity.Error, false),
            "critical" => (DeviceErrorSeverity.Critical, false),
            _ => (null, true),
        };
    }

    /// <summary>
    /// The state this request asks for, defaulting to <see cref="DeviceErrorState.Open"/> — the
    /// club's actual question.
    /// </summary>
    private static (DeviceErrorState Value, bool Invalid) StateOf(HttpRequest request)
    {
        if (Text(request, "state") is not { } text) return (DeviceErrorState.Open, false);
        return text.ToLowerInvariant() switch
        {
            OpenState => (DeviceErrorState.Open, false),
            ResolvedState => (DeviceErrorState.Resolved, false),
            AllState => (DeviceErrorState.All, false),
            _ => (DeviceErrorState.Open, true),
        };
    }

    /// <summary>
    /// The rows this query names, newest first, tenant-filtered by the context's global query
    /// filter and by nothing this method compares.
    /// </summary>
    public IQueryable<DeviceError> Apply(MainframeDbContext db)
    {
        var rows = Filtered(db);

        if (Cursor is { } cursor)
        {
            rows = rows.Where(e => e.LastSeenAt < cursor.At
                                   || (e.LastSeenAt == cursor.At && e.Id.CompareTo(cursor.Id) < 0));
        }

        // Ordered by the instant the row PRINTS — its last sighting — with the id as the
        // tie-break that makes the order total. A keyset over one column while the list is
        // ordered by another skips and repeats rows at every page boundary.
        return rows.OrderByDescending(e => e.LastSeenAt).ThenByDescending(e => e.Id);
    }

    /// <summary>
    /// The same rows WITHOUT the cursor and without an order — the set <c>total</c> and
    /// <c>counts</c> are computed over.
    ///
    /// <para>
    /// <b>Counted over the filtered RANGE and never over the page</b>, which is A6/E-M2 applied
    /// here: a heading saying "50 open faults" above a page of fifty drawn from a range holding
    /// seventy is a number an admin quotes. A cursor is where this page starts, not what the club
    /// asked for.
    /// </para>
    /// </summary>
    public IQueryable<DeviceError> Filtered(MainframeDbContext db)
    {
        // HALF-OPEN, as the door log is: the lower edge is in and the upper edge is out, which is
        // the only reading under which two adjacent club days each contain a midnight sighting
        // exactly once.
        var rows = db.DeviceErrors.AsNoTracking()
            .Where(e => e.LastSeenAt >= From && e.LastSeenAt < To);

        if (Device is { } device) rows = rows.Where(e => e.DeviceId == device);
        if (Severity is { } severity) rows = rows.Where(e => e.Severity == severity);
        if (Code is { } code) rows = rows.Where(e => e.Code == code);

        rows = State switch
        {
            DeviceErrorState.Open => rows.Where(e => e.ResolvedAt == null),
            DeviceErrorState.Resolved => rows.Where(e => e.ResolvedAt != null),
            _ => rows,
        };

        return rows;
    }

    private static string? Text(HttpRequest request, string key)
    {
        var value = request.Query[key].ToString();
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    /// <summary>
    /// The integer this parameter names, and whether it was present and is not one. See
    /// <see cref="DoorLogQuery.LimitInvalid"/> for why out-of-range is clamped and not-a-number is
    /// refused. Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </summary>
    private static (int? Value, bool Invalid) Number(HttpRequest request, string key)
    {
        if (Text(request, key) is not { } text) return (null, false);
        return int.TryParse(text, System.Globalization.NumberStyles.AllowLeadingSign,
            System.Globalization.CultureInfo.InvariantCulture, out var value)
            ? (value, false)
            : (null, true);
    }
}
