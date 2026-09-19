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
    /// <summary>Rows per page when the caller does not ask. A console page.</summary>
    public const int DefaultLimit = 50;

    /// <summary>Most rows one page will return, clamped rather than refused.</summary>
    public const int MaxLimit = 200;

    /// <summary>How far back the log looks when the caller names no <c>from</c>. A day.</summary>
    public static readonly TimeSpan DefaultWindow = TimeSpan.FromHours(24);

    /// <summary>The refusal when <c>?outcome=</c> is not one of the three.</summary>
    public const string OutcomeInvalid = "outcome_invalid";

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
    public static (DoorLogQuery? Query, string? Error) Parse(
        HttpRequest request, TenantSettingsView settings, DateTimeOffset now)
    {
        var retentionDays = DoorSettings.LogRetentionDays(settings);
        var floor = now.AddDays(-retentionDays);

        var outcome = Text(request, "outcome");
        if (outcome is not null && Array.IndexOf(DoorTrail.Outcomes, outcome) < 0) return (null, OutcomeInvalid);

        // Normalised to UTC because Npgsql refuses to write a DateTimeOffset with a non-zero
        // offset to a `timestamp with time zone` — and `?from=2026-09-19T00:00:00+02:00` is
        // exactly what a console in a club's own zone sends. Same instant; it is the
        // representation the parameter has to be in, not the value.
        var from = (Instant(request, "from") ?? now - DefaultWindow).ToUniversalTime();
        var to = (Instant(request, "to") ?? now).ToUniversalTime();
        if (from < floor) from = floor.ToUniversalTime();
        if (to < from) to = from;

        var cursor = DoorLogCursor.Parse(Text(request, "cursor"));

        return (new DoorLogQuery(
            Door: Guid.TryParse(Text(request, "door"), out var door) ? door : null,
            From: from,
            To: to,
            Outcome: outcome,
            Reason: Text(request, "reason"),
            Limit: Math.Clamp(Number(request, "limit") ?? DefaultLimit, 1, MaxLimit),
            Cursor: cursor,
            RetentionDays: retentionDays), null);
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
    public IQueryable<AuditLog> Apply(MainframeDbContext db)
    {
        var rows = db.AuditLogs.AsNoTracking()
            .Where(DoorTrail.IsScanRow)
            .Where(a => a.CreatedAt >= From && a.CreatedAt <= To);

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

        if (Cursor is { } cursor)
        {
            rows = rows.Where(a => a.CreatedAt < cursor.At || (a.CreatedAt == cursor.At && a.Id.CompareTo(cursor.Id) < 0));
        }

        return rows.OrderByDescending(a => a.CreatedAt).ThenByDescending(a => a.Id);
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
        return a => a.DetailsJson != null
                    && (EF.Functions.JsonContains(a.DetailsJson, asReason)
                        || EF.Functions.JsonContains(a.DetailsJson, asOutcome));
    }

    private static string? Text(HttpRequest request, string key)
    {
        var value = request.Query[key].ToString();
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    private static int? Number(HttpRequest request, string key)
        => int.TryParse(Text(request, key), out var value) ? value : null;

    private static DateTimeOffset? Instant(HttpRequest request, string key)
        => DateTimeOffset.TryParse(
            Text(request, key), System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.RoundtripKind, out var value)
            ? value
            : null;
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
    /// A malformed cursor answers the FIRST page rather than a 400. It is a value the console
    /// echoes back rather than one a person typed, so the recoverable reading is the useful
    /// one — and the failure it protects against, a truncated or re-encoded string, would
    /// otherwise strand a console mid-list with no way back.
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
