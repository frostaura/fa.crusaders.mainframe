using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// What one member's night was asked for: <b>a member, and a range. Nothing else.</b>
///
/// <para>
/// <b>The member is a constructor parameter taken from the PATH, and that is §6.7's whole
/// mechanism.</b> <see cref="DoorLogQuery"/> is the mirror of this type — it has nowhere to put
/// a member, so the club's door log structurally cannot be searched by one. This type has
/// nowhere to put a DOOR, an outcome or a reason, so the trace structurally cannot be asked
/// "which members came through this door". One sentence holds both:
/// </para>
///
/// <para>
/// <i>You cannot discover a person from the door log. You can only ask about a person you
/// already named.</i>
/// </para>
///
/// <para>
/// A query parameter would not hold that line for a release: an optional member filter is
/// exactly what a well-meaning console adds, and an optional member filter on a log IS the
/// thing P3 forbids. A path segment cannot be made optional.
/// </para>
///
/// <para>
/// The range grammar, its refusals and its clamping are <see cref="DoorLogQuery"/>'s, reused
/// rather than re-derived — one range spelling only, <c>range_conflict</c> when two are named,
/// a malformed date refused by name and a limit clamped. That file's reasoning is unchanged
/// here: a mistyped range that silently falls back is how an export lies about what it holds,
/// and this export is about a person.
/// </para>
/// </summary>
public sealed record AdminMemberTraceQuery(
    Guid UserId, DateTimeOffset From, DateTimeOffset To, int Limit, int Ceiling,
    AdminMemberTraceCursor? Cursor, int AuditDays, int DoorDays, DateTimeOffset DoorHorizon)
{
    /// <summary>
    /// <b><see cref="Limit"/> is the PAGE; <see cref="Ceiling"/> is the NIGHT.</b>
    ///
    /// <para>
    /// The distinction is not cosmetic and it cost a red test to find. Each strand is read up to
    /// <see cref="Ceiling"/> rows — <c>member_trace_max_events</c>, the club's own setting — and
    /// the merge of the three is what <c>total</c> counts and what the summary adds up. Reading
    /// each strand to the PAGE size instead would make "six movements" read as "three" the
    /// moment a console asked for two at a time, and the summary beneath it would be wrong in
    /// the same proportion with nothing on the wire saying so.
    /// </para>
    /// </summary>
    public int StrandRows => Ceiling + 1;

    /// <summary>The club's zone, resolved once when the request was parsed.</summary>
    public required TimeZoneInfo Zone { get; init; }

    /// <summary>The name of <see cref="Zone"/> as the wire reports it.</summary>
    public required string Timezone { get; init; }

    /// <summary>
    /// The club's currency symbol, resolved once when the request was parsed — exactly as
    /// <see cref="Zone"/> is, and for the same reason.
    ///
    /// <para>
    /// Every money sentence on this surface is composed on the SERVER (see
    /// <see cref="Services.TraceKinds"/>), so the symbol has to reach the composer, and the
    /// composer is three layers below the request. Carrying it on the resolved query rather
    /// than reading settings again down there is what makes one night's sentences all speak in
    /// one club's sign: a second read is a second chance to read a different tenant's.
    /// </para>
    ///
    /// <para>
    /// <c>required</c>, not defaulted, for the reason <see cref="Email.EmailTemplates.Money"/>
    /// gives at length.
    /// </para>
    /// </summary>
    public required string CurrencySymbol { get; init; }

    /// <summary>
    /// The one club day this range covers, or null when it covers something else.
    ///
    /// <para>
    /// A night trace is usually one night, and the page says which. A range that is NOT exactly
    /// one club day answers null rather than the date of its first instant — "club_day:
    /// 2026-09-22" over a thirty-day range is a caption that is simply false, and a caption is
    /// the part of a page people quote.
    /// </para>
    /// </summary>
    public DateOnly? ClubDay { get; init; }

    /// <summary>
    /// Whether some of this range's door rows may already have been deleted.
    ///
    /// <para>
    /// <b>"May", not "is", and that is the only claim the data supports.</b> Door rows are
    /// deleted at <c>door_log_retention_days</c> while audit and ledger rows live to
    /// <c>retention_years</c>, so a range reaching past the door horizon has a door strand that
    /// cannot be complete — and an empty door strand reads as "she was not here", which is a
    /// different and much worse sentence than "we no longer hold that". D2-B38 is why it cannot
    /// be stated more strongly either: some door-shaped rows are invisible to the retention
    /// worker's own predicate and survive past ninety days, so the honest answer is a maybe.
    /// </para>
    /// </summary>
    public bool DoorRowsMayBeIncomplete => From < DoorHorizon;

    /// <summary>The refusal when the club has switched the trace off. <b>404, never 403.</b></summary>
    public const string Disabled = "member_trace_disabled";

    /// <summary>
    /// The refusal when the id names nobody this club has.
    ///
    /// <para>
    /// The same answer a foreign club's member id gets, and deliberately: the user is resolved
    /// through the tenant-filtered <c>db.Users</c>, so "not ours" and "does not exist" are
    /// indistinguishable from outside. That is the isolation being structural rather than
    /// compared — see <c>MainframeDbContext</c>'s note on the disjunction that was removed.
    /// </para>
    /// </summary>
    public const string MemberNotFound = "member_not_found";

    /// <summary>A malformed cursor is refused rather than answered with page one. See <see cref="DoorLogQuery.CursorInvalid"/>.</summary>
    public const string CursorInvalid = DoorLogQuery.CursorInvalid;

    /// <summary>A limit that is not an integer. A limit out of RANGE is clamped.</summary>
    public const string LimitInvalid = DoorLogQuery.LimitInvalid;

    /// <summary>Days per year used to express <c>retention_years</c> as a horizon in days.</summary>
    private const int DaysPerYear = 365;

    /// <summary>
    /// Reads the query string. Refuses what has a closed shape; clamps the limit and the range.
    ///
    /// <para>
    /// <b>The range is clamped to the LATER of the two horizons.</b> Audit and ledger rows live
    /// to <c>retention_years</c>; door rows are deleted at <c>door_log_retention_days</c>, which
    /// is shorter. Clamping to the shorter one would refuse to answer questions the audit table
    /// can still answer; clamping to the longer one and saying nothing would hand back a night
    /// with an empty door strand. So: clamp to the longer, and carry both horizons on the
    /// response.
    /// </para>
    /// </summary>
    public static (AdminMemberTraceQuery? Query, string? Error) Parse(
        HttpRequest request, TenantSettingsView settings, Guid userId, DateTimeOffset now)
    {
        var (zone, timezone, _) = DoorClock.ZoneOf(settings);

        var doorDays = DoorSettings.LogRetentionDays(settings);
        var auditDays = Math.Max(1, settings.RetentionYears) * DaysPerYear;
        var floor = now.AddDays(-Math.Max(auditDays, doorDays)).ToUniversalTime();

        var (range, rangeError) = Range(request, zone, now);
        if (rangeError is not null) return (null, rangeError);
        if (range is not { } window) return (null, DoorPeriod.RangeConflict);

        // Normalised to UTC for the reason DoorLogQuery gives: Npgsql refuses to write a
        // DateTimeOffset carrying a non-zero offset to a `timestamp with time zone`, and every
        // boundary DoorPeriod builds carries the club's own.
        var from = window.From.ToUniversalTime();
        var to = window.To.ToUniversalTime();
        if (from < floor) from = floor;
        if (to < from) to = from;

        var cursorText = Text(request, "cursor");
        var cursor = AdminMemberTraceCursor.Parse(cursorText);
        if (cursorText is not null && cursor is null) return (null, CursorInvalid);

        var limitText = Text(request, "limit");
        int? limit = null;
        if (limitText is not null)
        {
            if (!int.TryParse(limitText, System.Globalization.NumberStyles.AllowLeadingSign,
                    System.Globalization.CultureInfo.InvariantCulture, out var parsed))
            {
                return (null, LimitInvalid);
            }
            limit = parsed;
        }

        var ceiling = TraceSettings.MaxEvents(settings);

        return (new AdminMemberTraceQuery(
            UserId: userId,
            From: from,
            To: to,
            Limit: Math.Clamp(limit ?? ceiling, 1, ceiling),
            Ceiling: ceiling,
            Cursor: cursor,
            AuditDays: auditDays,
            DoorDays: doorDays,
            DoorHorizon: now.AddDays(-doorDays).ToUniversalTime())
        {
            Zone = zone,
            Timezone = timezone,
            CurrencySymbol = Services.CurrencySymbol.For(settings),
            ClubDay = WholeClubDay(zone, from, to),
        }, null);
    }

    /// <summary>
    /// The club day this range is, or null when it is not exactly one.
    ///
    /// <para>
    /// Computed from the resolved edges rather than from the parameter that produced them, so
    /// <c>?day=</c>, <c>?period=yesterday</c> and a hand-written <c>from</c>/<c>to</c> pair
    /// spanning one club day all answer the same caption — and a range that was CLAMPED into
    /// something other than a whole day stops claiming to be one.
    /// </para>
    /// </summary>
    private static DateOnly? WholeClubDay(TimeZoneInfo zone, DateTimeOffset from, DateTimeOffset to)
    {
        if (!DoorClock.IsStartOfLocalDay(zone, from)) return null;
        var day = DoorClock.LocalDateOf(zone, from);
        return DoorClock.StartOfLocalDay(zone, day.AddDays(1)) == to ? day : null;
    }

    /// <summary>
    /// The window this request asks for — <see cref="DoorPeriod"/>'s grammar verbatim, because a
    /// club that learned it on the door log should not learn a second one here.
    ///
    /// <para>
    /// The default is the door log's: the last rolling twenty-four hours. A console showing "one
    /// member's night" sends <c>?period=today</c> or a <c>?day=</c> and gets a caption to go with
    /// it; the default is what a bare link answers, and a rolling day is the answer that is right
    /// at 00:30 as well as at 20:00. Block body for the lizard reason in
    /// <c>memory/gotchas.md</c>.
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
            return DoorPeriod.Resolve(period, zone, now) is { } resolved
                ? ((resolved.From, resolved.To), null)
                : (null, DoorPeriod.PeriodInvalid);
        }

        if (day is not null)
        {
            return DoorPeriod.Day(day, zone, now) is { } resolved
                ? ((resolved.From, resolved.To), null)
                : (null, DoorPeriod.DayInvalid);
        }

        var (fromValue, fromBad) = DoorLogQuery.Instant(request, "from");
        if (fromBad) return (null, DoorLogQuery.FromInvalid);
        var (toValue, toBad) = DoorLogQuery.Instant(request, "to");
        if (toBad) return (null, DoorLogQuery.ToInvalid);

        return ((fromValue ?? now - DoorLogQuery.DefaultWindow, toValue ?? now), null);
    }

    private static string? Text(HttpRequest request, string key)
    {
        var value = request.Query[key].ToString();
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }
}

/// <summary>
/// Where a page of one member's night stopped: the instant the row PRINTS at, and its id.
///
/// <para>
/// Keyed on the displayed instant rather than the row's creation, because that is what the list
/// is sorted by — an offline door scan prints at the scan and is created at the upload, and a
/// cursor over one column while the list is ordered by another skips and repeats rows at every
/// page boundary. <see cref="DoorLogCursor"/> documents that failure at length.
/// </para>
///
/// <para>
/// <b>Ascending, unlike every other cursor in this product.</b> A night reads forwards — she
/// arrived, the lights came on, she paid, she left — so the list is oldest first and the cursor
/// means "everything strictly after this row".
/// </para>
/// </summary>
public sealed record AdminMemberTraceCursor(DateTimeOffset At, Guid Id)
{
    /// <summary>This position, as the caller will send it back.</summary>
    public string Encode()
        => Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes($"{At.UtcTicks}:{Id:N}"));

    /// <summary>A cursor from the wire, or null when there is none or it is not one of ours.</summary>
    public static AdminMemberTraceCursor? Parse(string? encoded)
    {
        if (string.IsNullOrWhiteSpace(encoded)) return null;
        try
        {
            var parts = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(encoded)).Split(':');
            if (parts.Length != 2) return null;
            if (!long.TryParse(parts[0], out var ticks) || !Guid.TryParseExact(parts[1], "N", out var id)) return null;
            return new AdminMemberTraceCursor(new DateTimeOffset(ticks, TimeSpan.Zero), id);
        }
        catch (FormatException)
        {
            return null;
        }
    }

    /// <summary>Whether one row falls strictly after this position in the list's own total order.</summary>
    public bool Precedes(DateTimeOffset at, Guid id)
        => at > At || (at == At && id.CompareTo(Id) > 0);
}
