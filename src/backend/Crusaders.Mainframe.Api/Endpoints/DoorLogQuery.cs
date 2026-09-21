using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// What the club's door log was asked for — door, time, outcome, reason — and nothing else.
///
/// <para>
/// <b>The fields this type does NOT have are its point.</b> P3: the admin door log filters by
/// DOOR, TIME and OUTCOME only, and there is no per-member filter and no per-member admin
/// history anywhere in this product. A member's own door history belongs to the member
/// (<c>GET /api/v1/me/door/history</c>) and to nobody else. Making that structural — a request
/// type with no place to put a member — is worth more than a convention, because a convention
/// is what a well-meaning console adds a parameter past.
/// </para>
///
/// <para>
/// Unknown query parameters are ignored rather than refused, which is ordinary HTTP, and
/// <c>AdminDoorLogHttpTests.No_parameter_named_after_a_member_changes_anything</c> drives five
/// plausible spellings through the route and asserts the bytes are identical. A refusal would
/// be worse: it would confirm which names the server recognises.
/// </para>
/// </summary>
public sealed record DoorLogQuery(
    Guid? Door, DateTimeOffset From, DateTimeOffset To, string? Outcome, string? Reason, int Limit,
    DoorLogCursor? Cursor, int RetentionDays)
{
    /// <summary>
    /// The club's zone, resolved once when the request was parsed, so the range, the wire's
    /// <c>timezone</c> and the export's filename are all written in the same one.
    /// </summary>
    public required TimeZoneInfo Zone { get; init; }

    /// <summary>The name of <see cref="Zone"/> as the wire reports it — UTC's when the stored id is not one.</summary>
    public required string Timezone { get; init; }

    /// <summary>Rows per page when the caller does not ask. A console page.</summary>
    public const int DefaultLimit = 50;

    /// <summary>Most rows one page will return, clamped rather than refused.</summary>
    public const int MaxLimit = 200;

    /// <summary>How far back the log looks when the caller names no <c>from</c>. A day.</summary>
    public static readonly TimeSpan DefaultWindow = TimeSpan.FromHours(24);

    /// <summary>The refusal when <c>?outcome=</c> is not one of the three.</summary>
    public const string OutcomeInvalid = "outcome_invalid";

    /// <summary>
    /// The refusal when <c>?door=</c> or <c>?removed_door=</c> is present and is not a UUID.
    ///
    /// <para>
    /// <b>It was silently ignored, which is the <c>from_invalid</c> defect at a different
    /// parameter (E-M3).</b> <c>?door=notauuid</c> answered <c>200</c> with the WHOLE club's log
    /// while the console showed it under one door's name. A well-formed id that names no board
    /// is different and still answers 200 with no rows: that is a real question with a real
    /// answer, and it is the shape a link to a removed door takes.
    /// </para>
    /// </summary>
    public const string DoorInvalid = "door_invalid";

    /// <summary>
    /// The refusal when <c>?door=</c> is a well-formed uuid that names neither a board this club
    /// has nor one it has removed.
    ///
    /// <para>
    /// <b>A stale door link lied, and quietly (A-C2 / R3-13).</b> A bookmark or a back button
    /// carrying the id of a board that has since been deleted — or a pasted id from another
    /// club, which this tenant can never see — answered <c>200</c> with an empty list. The
    /// console then reset its Door select to "All doors" and printed "No scans at any door in
    /// the last 24 hours" over a filter that was in fact narrowed to one, and the export handed
    /// the admin a zero-row file under the ordinary filename. Every one of those sentences is
    /// false and all three are the same missing answer: this server cannot answer for that
    /// door.
    /// </para>
    ///
    /// <para>
    /// A REMOVED door is not this error. Its rows survive it and the log offers it in
    /// <c>removed_doors</c>, so filtering by one is a real question with a real answer — which
    /// is exactly the distinction a bare "no rows" could not make.
    /// </para>
    /// </summary>
    public const string DoorNotFound = "door_not_found";

    /// <summary>
    /// The refusal when <c>?limit=</c> is present and is not an integer. See <see cref="Number"/>
    /// for why a value out of RANGE is clamped instead.
    /// </summary>
    public const string LimitInvalid = "limit_invalid";

    /// <summary>
    /// The refusal when <c>?reason=</c> is not one this server can write.
    ///
    /// <para>
    /// Also silently ignored (E-M3): <c>?reason=bogus</c> answered <c>200</c> with an empty list,
    /// which an admin reads as "nothing happened" rather than "that is not a reason". The set is
    /// <see cref="DoorTrail.Reasons"/> — both vocabularies, because a gate decision writes
    /// <c>reason</c> and an uploaded event writes <c>outcome</c>.
    /// </para>
    /// </summary>
    public const string ReasonInvalid = "reason_invalid";

    /// <summary>
    /// The refusal when <c>?from=</c> is present and is not an instant.
    ///
    /// <para>
    /// <b>It used to be ignored, and the export is why that mattered.</b> A mistyped range
    /// silently fell back to the default window — or, for the CSV, to the whole retention
    /// period — and answered 200 with rows the admin believed were filtered. Somebody
    /// exporting "last Tuesday" got the club's entire log and filed it as last Tuesday's. A
    /// LIMIT is clamped because a console asking for too much is unambiguous; a date that is
    /// not a date is not a request the server can bound, and guessing what it meant is how an
    /// export lies.
    /// </para>
    /// </summary>
    public const string FromInvalid = "from_invalid";

    /// <summary>The same for <c>?to=</c>. See <see cref="FromInvalid"/>.</summary>
    public const string ToInvalid = "to_invalid";

    /// <summary>
    /// The refusal when <c>?cursor=</c> is present and is not one of ours.
    ///
    /// <para>
    /// A malformed cursor used to answer the FIRST page, on the reasoning that it is a value
    /// a console echoes rather than one a person types. That is true and it is still the
    /// wrong answer: a console that truncated it gets page one back labelled as page nine and
    /// an admin walks a list that silently restarted. Refusing says so.
    /// </para>
    /// </summary>
    public const string CursorInvalid = "cursor_invalid";

    /// <summary>
    /// Reads the query string, clamps everything, and refuses only the one parameter that has a
    /// closed set.
    ///
    /// <para>
    /// <b>The range is clamped to the club's own retention, not merely defaulted to it.</b>
    /// W1.9 puts a retention statement on the page, and the rows themselves survive between
    /// nightly sweeps, so a log that answered a <c>from</c> of a year ago would be showing a
    /// club data its own page says it no longer keeps. The clamp is what makes the sentence
    /// true; <c>retention_days</c> on the response is what lets the page state the number.
    /// </para>
    ///
    /// <para>
    /// The limit and the range are clamped rather than refused, on the same argument the
    /// per-board feed's limit already carries: a console asking for too much is a mistake to
    /// bound, and an error screen is not what the admin wanted. The outcome is different — it
    /// is a closed vocabulary, and silently ignoring an unrecognised one would show an admin a
    /// full log while they believed they were looking at refusals.
    /// </para>
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The range may be named three ways and only one of them at a time.</b> A request
    /// carrying both <c>?period=yesterday</c> and a <c>?from=</c> is not a request this server
    /// can bound — one of the two was meant, guessing is how an export lies about what it holds,
    /// and the second console that grows a date picker beside a period button is the one that
    /// sends it. <see cref="DoorPeriod.RangeConflict"/>, by name, rather than a precedence rule
    /// nobody can see.
    /// </para>
    /// </remarks>
    public static (DoorLogQuery? Query, string? Error) Parse(
        HttpRequest request, TenantSettingsView settings, DateTimeOffset now)
    {
        var retentionDays = DoorSettings.LogRetentionDays(settings);
        var floor = now.AddDays(-retentionDays);
        var (zone, timezone, _) = DoorClock.ZoneOf(settings);

        var outcome = Text(request, "outcome");
        if (outcome is not null && Array.IndexOf(DoorTrail.Outcomes, outcome) < 0) return (null, OutcomeInvalid);

        var reason = Text(request, "reason");
        if (reason is not null && Array.IndexOf(DoorTrail.Reasons, reason) < 0) return (null, ReasonInvalid);

        var (door, doorBad) = DoorId(request);
        if (doorBad) return (null, DoorInvalid);

        var (range, rangeError) = Range(request, zone, now);
        if (rangeError is not null) return (null, rangeError);
        if (range is not { } window) return (null, DoorPeriod.RangeConflict);

        // Normalised to UTC because Npgsql refuses to write a DateTimeOffset with a non-zero
        // offset to a `timestamp with time zone` — and `?from=2026-09-19T00:00:00+02:00` is
        // exactly what a console in a club's own zone sends, as is every boundary DoorPeriod
        // builds. Same instant; it is the representation the parameter has to be in, not the
        // value. The RANGE on the wire keeps the club's offset, which is what lets the page say
        // "since 00:00 club time".
        var from = window.From;
        var to = window.To;
        if (from < floor) from = floor.ToUniversalTime();
        if (to < from) to = from;

        var cursorText = Text(request, "cursor");
        var cursor = DoorLogCursor.Parse(cursorText);
        if (cursorText is not null && cursor is null) return (null, CursorInvalid);

        var (limit, limitBad) = Number(request, "limit");
        if (limitBad) return (null, LimitInvalid);

        return (new DoorLogQuery(
            Door: door,
            From: from,
            To: to,
            Outcome: outcome,
            Reason: reason,
            Limit: Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit),
            Cursor: cursor,
            RetentionDays: retentionDays)
        {
            Zone = zone,
            Timezone = timezone,
        }, null);
    }

    /// <summary>
    /// The door this request names, under either spelling, and whether it was present and
    /// unreadable.
    ///
    /// <para>
    /// <c>removed_door</c> carries the key <c>GET /admin/doors/activity</c>'s
    /// <c>removed_doors</c> list hands out — the device id the rows themselves stored — so the
    /// console can offer a removed board in the same filter as a live one without having to know
    /// that the two are the same kind of value. They ARE the same filter slot, so a request that
    /// names two different doors is contradictory and is refused rather than silently resolved
    /// by a precedence rule. Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static (Guid? Door, bool Invalid) DoorId(HttpRequest request)
    {
        var live = Text(request, "door");
        var removed = Text(request, RemovedDoorParameter);
        if (live is null && removed is null) return (null, false);

        Guid? first = null;
        foreach (var text in new[] { live, removed })
        {
            if (text is null) continue;
            if (!Guid.TryParse(text, out var parsed)) return (null, true);
            if (first is { } already && already != parsed) return (null, true);
            first = parsed;
        }
        return (first, false);
    }

    /// <summary>The query parameter a removed door is filtered by. See <see cref="DoorId"/>.</summary>
    public const string RemovedDoorParameter = "removed_door";

    /// <summary>
    /// The window this request asks for: a named period, a club-local day, an explicit
    /// <c>from</c>/<c>to</c> pair, or the default rolling day — and never more than one of them.
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

        var (fromValue, fromBad) = Instant(request, "from");
        if (fromBad) return (null, FromInvalid);
        var (toValue, toBad) = Instant(request, "to");
        if (toBad) return (null, ToInvalid);

        return (((fromValue ?? now - DefaultWindow).ToUniversalTime(), (toValue ?? now).ToUniversalTime()), null);
    }

    /// <summary>
    /// The rows this query names, newest first, tenant-filtered by the context's global query
    /// filter and by nothing this method compares.
    ///
    /// <para>
    /// The door filter is a jsonb containment on <c>device_id</c> rather than a join: there is
    /// no foreign key, because <c>audit_log</c> is one append-only table for the whole product.
    /// <c>@></c> rather than a LIKE over the text, so a guid that happened to appear in some
    /// other field cannot match.
    /// </para>
    /// </summary>
    /// <summary>
    /// Whether the door this query names is one this club can answer for — a board it still has,
    /// or one it has removed whose rows survive. True when the query names no door at all.
    ///
    /// <para>
    /// Both reads are tenant-filtered by the context's global query filter, which is what makes
    /// another club's door id indistinguishable from an invented one: the isolation is
    /// structural rather than a claim compared. See <see cref="DoorNotFound"/> for what the
    /// alternative — an empty list under a normal heading — told an admin.
    /// </para>
    ///
    /// <para>
    /// The removed half asks the audit trail rather than the <c>device.deleted</c> row alone,
    /// because a board may have been removed before that row carried an id and because the
    /// question the admin asked is "are there rows for this door", which is the same question.
    /// </para>
    /// </summary>
    public async Task<bool> DoorIsKnownAsync(MainframeDbContext db, CancellationToken ct)
    {
        if (Door is not { } door) return true;
        if (await db.Devices.AsNoTracking().AnyAsync(d => d.Id == door, ct)) return true;

        var containment = System.Text.Json.JsonSerializer.Serialize(new { device_id = door });
        return await db.AuditLogs.AsNoTracking()
            .AnyAsync(a => a.DetailsJson != null && EF.Functions.JsonContains(a.DetailsJson, containment), ct);
    }

    public IQueryable<AuditLog> Apply(MainframeDbContext db)
    {
        var rows = Filtered(db);

        if (Cursor is { } cursor)
        {
            rows = rows.Where(a => a.ScanAt < cursor.At || (a.ScanAt == cursor.At && a.Id.CompareTo(cursor.Id) < 0));
        }

        // ORDERED BY THE INSTANT THE ROW PRINTS, which is what "newest first" claims and was not
        // (R3-17, WIRE-R3 §2). See AuditLog.ScanAt: an offline batch delivered at 21:10 carrying
        // 18:40 scans used to sit at the top of this list showing 18:40. The cursor moves with
        // it — a keyset over one column while the list is ordered by another skips and repeats
        // rows at every page boundary.
        return rows.OrderByDescending(a => a.ScanAt).ThenByDescending(a => a.Id);
    }

    /// <summary>
    /// The same rows WITHOUT the cursor and without an order — the set <c>total</c> counts.
    ///
    /// <para>
    /// <b>The heading said a number it could not know (A6 / E-M2).</b> "50 scans, newest first"
    /// is what the page printed over a page of fifty rows drawn from a range holding seventy,
    /// and an admin reads that as the range's total; the export then handed them a file with
    /// seventy rows in it. The count has to be of the FILTERED RANGE and not of the page, which
    /// means not of the cursor — a cursor is where this page starts, not what the club asked
    /// for. It is a <c>COUNT</c> on the same index-scan plan the page already runs
    /// (<c>IX_audit_log_TenantId_CreatedAt</c>, measured sub-millisecond at 400 000 rows), which
    /// is why it can be answered on every request rather than on the first.
    /// </para>
    /// </summary>
    public IQueryable<AuditLog> Filtered(MainframeDbContext db)
    {
        // HALF-OPEN: the lower edge is in and the upper edge is out.
        //
        // It was closed at both ends, and a named day is what exposed that. "Yesterday" ends at
        // the same instant "today" begins, so a scan at exactly a club's midnight was counted in
        // BOTH days — two answers to "how many came through last night" that differ by one, from
        // the same rows, depending on which day you asked about. Half-open is the only reading
        // under which two adjacent days each contain that instant exactly once, and it is
        // already what DoorDay's own counts do (`s.At >= day.DayStartedAt`). On a caller-supplied
        // `to` it moves the edge by one tick, which is the price of the days being right.
        // THE RANGE STAYS ON CreatedAt WHILE THE SORT MOVES TO ScanAt, and the asymmetry is
        // deliberate rather than an oversight.
        //
        // The range answers "what does this club know about, in this window" — which is when it
        // HEARD, and is the same instant retention and the per-door day counts on /admin/doors
        // are computed from, so the list and the numbers beside it stay countable from each
        // other. Ranging on the scan's instant instead would silently hide the one row an admin
        // most needs after an outage: a batch delivered this morning carrying scans from two
        // days ago would fall outside "last 24 hours" — and outside every window they would ever
        // ask for afterwards, because it is already older than all of them.
        //
        // What the sort moves for is the opposite failure: a row that IS in the window printed
        // in a position its own timestamp contradicts. See AuditLog.ScanAt.
        var rows = db.AuditLogs.AsNoTracking()
            .Where(DoorTrail.IsScanRow)
            .Where(a => a.CreatedAt >= From && a.CreatedAt < To);

        // AND NOT AT A COURT BOX (D2-B27).
        //
        // `unknown_scan` is declared on the upload path with no dispatch case and no kind
        // guard, unlike `gate_open`, which is gated — and a court box genuinely emits one
        // (Session.h). Its action is classified as a door REFUSAL by DoorTrail, so a member
        // mis-scanning at a court box appeared here as somebody turned away at a door, was
        // counted in the club's per-day door totals, and was exported into the club's door log
        // under a door's name. The predicate belongs beside the other door predicates and not
        // at each of the four readers, for the reason DoorTrail.IsScanRow already gives.
        //
        // Read synchronously and on every call, which is cheap and deliberate: a club has a
        // handful of boards, the read is a primary-key scan of a tiny table, and the
        // alternative — caching it on this record — would put mutable state on a type whose
        // whole value is that it is a description of a request. See DoorTrail.NotADoorIds for
        // why the rule is "not a door" rather than "is a gate": a REMOVED door's rows survive
        // it, and filtering to boards that still exist would delete exactly the rows the
        // removed_door filter exists to serve.
        rows = DoorTrail.WithoutNonDoorBoards(rows, DoorTrail.NotADoorIds(db));

        if (Door is { } door)
        {
            var containment = System.Text.Json.JsonSerializer.Serialize(new { device_id = door });
            rows = rows.Where(a => a.DetailsJson != null && EF.Functions.JsonContains(a.DetailsJson, containment));
        }

        rows = Outcome switch
        {
            DoorTrail.Released => rows.Where(DoorTrail.IsReleaseRow),
            DoorTrail.Refused => rows.Where(DoorTrail.IsRefusalRow),
            DoorTrail.Offline => rows.Where(DoorTrail.IsOfflineRow),
            _ => rows,
        };

        if (Reason is { } reason) rows = rows.Where(ReasonMatch(reason));

        return rows;
    }

    /// <summary>
    /// Rows whose reason is this one, in either of the two vocabularies the trail is written in.
    ///
    /// <para>
    /// A gate decision writes <c>reason</c>; an uploaded event writes <c>outcome</c>. They are
    /// deliberately not unified in the projection — see <see cref="DoorActivityView.Reason"/> —
    /// so the filter has to ask about both, and the alternative of filtering on the action's
    /// suffix would miss every offline row.
    /// </para>
    /// </summary>
    private static System.Linq.Expressions.Expression<Func<AuditLog, bool>> ReasonMatch(string reason)
    {
        var asReason = System.Text.Json.JsonSerializer.Serialize(new { reason });
        var asOutcome = System.Text.Json.JsonSerializer.Serialize(new { outcome = reason });

        // The third vocabulary: the row whose reason is its ACTION (E4 / A-M1 / R3-16). An
        // offline refusal writes `outcome: null` — the upload path has no outcome for a scan the
        // board decided alone — so neither containment above can ever match it, and
        // `?reason=not_recognised` returned ten online refusals while the same window held nine
        // offline ones the page itself labelled "Not recognised". The filter, the label, the
        // count and the export now read one rule, stated in DoorActivityView.Reason and mirrored
        // here because a jsonb containment cannot call it.
        if (reason == GateAccess.NotRecognised)
        {
            return a => a.Action == DoorTrail.OfflineUnknownScanAction
                        || (a.DetailsJson != null
                            && (EF.Functions.JsonContains(a.DetailsJson, asReason)
                                || EF.Functions.JsonContains(a.DetailsJson, asOutcome)));
        }

        return a => a.DetailsJson != null
                    && (EF.Functions.JsonContains(a.DetailsJson, asReason)
                        || EF.Functions.JsonContains(a.DetailsJson, asOutcome));
    }

    private static string? Text(HttpRequest request, string key)
    {
        var value = request.Query[key].ToString();
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    /// <summary>
    /// The integer this parameter names, and whether it was present and is not one.
    ///
    /// <para>
    /// <b>The three answers are different and only two of them used to exist (E7 / R3-32).</b>
    /// <c>?limit=abc</c> and <c>?limit=1e9</c> both failed <c>int.TryParse</c> and fell through
    /// to the DEFAULT of fifty — so a console asking for a thousand rows and a console with a
    /// typo got the same fifty, and nothing on the wire said which had happened. A number
    /// OUTSIDE the range is still clamped, because a request for too many rows is unambiguous
    /// and an error screen is not what the admin wanted; a value that is not a number at all
    /// cannot be clamped to anything, so it is refused by name. Block body for the lizard
    /// reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static (int? Value, bool Invalid) Number(HttpRequest request, string key)
    {
        if (Text(request, key) is not { } text) return (null, false);
        return int.TryParse(text, System.Globalization.NumberStyles.AllowLeadingSign,
            System.Globalization.CultureInfo.InvariantCulture, out var value)
            ? (value, false)
            : (null, true);
    }

    /// <summary>
    /// The instant this parameter names, and whether it was present and unreadable — which is
    /// a different answer from absent and is the whole of E3. Block body for the lizard reason
    /// in <c>memory/gotchas.md</c>.
    /// </summary>
    public static (DateTimeOffset? Value, bool Invalid) Instant(HttpRequest request, string key)
    {
        if (Text(request, key) is not { } text) return (null, false);
        return DateTimeOffset.TryParse(
            text, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.RoundtripKind, out var value)
            ? (value, false)
            : (null, true);
    }
}

/// <summary>
/// Where the last page stopped: the instant and the row id, which together are the log's total
/// order.
///
/// <para>
/// <b>An offset would be wrong here and not merely slow.</b> The trail is append-only and a
/// door is writing to it while an admin pages, so <c>skip(50)</c> would show a row twice or
/// skip one every time a scan landed between two requests. A keyset cursor reads "everything
/// strictly older than this row", which is stable under writes — and the tie-break on
/// <c>Id</c> is what makes it total, because two scans at two doors in the same millisecond is
/// an ordinary Saturday morning.
/// </para>
///
/// <para>
/// Opaque on the wire, because it is an implementation detail a console must not construct;
/// base64 rather than encrypted, because it encodes nothing a caller could not already see in
/// the page it came from.
/// </para>
/// </summary>
public sealed record DoorLogCursor(DateTimeOffset At, Guid Id)
{
    /// <summary>This position, as the caller will send it back.</summary>
    public string Encode()
        => Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes($"{At.UtcTicks}:{Id:N}"));

    /// <summary>
    /// A cursor from the wire, or null when there is none or it is not one.
    ///
    /// <para>
    /// Null for a malformed one, which its callers answer 400 <c>cursor_invalid</c> to. It was
    /// the first page for as long as this type has existed, on the reasoning that a cursor is
    /// echoed rather than typed and the recoverable reading is the useful one — and E3 is what
    /// that costs: a truncated cursor answers page one, the console labels it page nine, and
    /// an admin walks a list that silently restarted without a single thing on screen saying
    /// so. Recoverable is not the same as correct.
    /// </para>
    /// </summary>
    public static DoorLogCursor? Parse(string? encoded)
    {
        if (string.IsNullOrWhiteSpace(encoded)) return null;
        try
        {
            var parts = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(encoded)).Split(':');
            if (parts.Length != 2) return null;
            if (!long.TryParse(parts[0], out var ticks) || !Guid.TryParseExact(parts[1], "N", out var id)) return null;
            return new DoorLogCursor(new DateTimeOffset(ticks, TimeSpan.Zero), id);
        }
        catch (FormatException)
        {
            return null;
        }
    }
}
