using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// D9 — "admins get full per-member door history" — and <b>the deliberate reversal of P3's
/// second half</b>.
///
/// <para>
/// P3 said the admin door log filters by door, time and outcome only and that no per-member
/// admin history exists anywhere in the product. Dean reversed that on 2026-09-23: a club that
/// cannot answer "when did this person come and go" for a disputed no-show, a safeguarding
/// question or a lost-property call has to reconstruct it by hand from the club log, which is
/// the same surveillance with worse accuracy and no record of who looked. The reversal is
/// recorded in <c>memory/decisions-doors-member.md</c> with its rationale.
/// </para>
///
/// <para>
/// <b>What the reversal did NOT change, and why it is safe to leave standing.</b> The CLUB log
/// (<c>/api/v1/admin/doors/activity</c>) still has no member filter, and
/// <c>AdminDoorLogHttpTests.No_parameter_named_after_a_member_changes_anything</c> still holds:
/// you cannot DISCOVER a person from the operations log. What exists now is a read of one person
/// an admin already named, with the member as a PATH SEGMENT — the trace's structural
/// mechanism (<see cref="AdminMemberTraceEndpoints"/>): a path segment cannot be made optional,
/// so this route can never widen into "everybody's doors, filtered by whoever you like".
/// </para>
///
/// <para>
/// <b>Every read is audited</b> — the page AND the export — as <c>member.door_history_viewed</c>
/// in BOTH <c>audit_log</c> and the undeletable <c>admin_change_log</c>, in one save, naming the
/// admin as actor, the member as subject, and the range and filters asked for. Written on the way
/// OUT, so the row can say how many rows were actually looked at; a refused read writes neither.
/// See <see cref="RecordAsync"/> for why both tables.
/// </para>
///
/// <para>
/// <b>The range defaults to the whole of the club's door retention</b>, not the club log's
/// rolling day: "full per-member door history" is the decision's own wording, and a default of
/// one day would have an admin conclude that a member who came in on Monday never has. An
/// explicit range, period or day is honoured and clamped exactly as the club log clamps it,
/// because the retention statement is the same sentence on both pages.
/// </para>
/// </summary>
public static class AdminMemberDoorEndpoints
{
    /// <summary>The audit action every read of this surface writes.</summary>
    public const string ViewedAction = AdminChangeActions.MemberDoorHistoryViewed;

    /// <summary>The refusal for a user id this club does not hold.</summary>
    public const string MemberNotFound = AdminMemberDetailEndpoints.MemberNotFound;

    /// <summary>
    /// Most rows one export contains — the club log's ceiling, because a member's retention
    /// window is a subset of the club's and a second, different number would be a second answer
    /// to one question.
    /// </summary>
    public const int MaxExportRows = AdminDoorLogEndpoint.MaxExportRows;

    /// <summary>
    /// The export's columns, in order. The club log's columns minus <c>member</c> (it is the
    /// file's own subject, in its name) and plus <c>method</c> — how they identified — which is
    /// the question a person's history is usually asked to answer.
    /// </summary>
    public const string Header =
        "date,time,timezone,at_utc,door,door_name,outcome,reason,reason_code,offline,method," +
        "code_fingerprint,time_uncertain,delivered_at_utc";

    public static IEndpointRouteBuilder MapAdminMemberDoorEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/members/{userId:guid}")
            .RequireAuthorization(p => p.RequireRole("admin"));

        // A sibling path for the file, matching the doors group's `activity` / `activity.csv`
        // and the trace's `trace` / `trace.csv`: one query string, two renderings.
        g.MapGet("/doors.csv", CsvAsync);
        g.MapGet("/doors", HandleAsync);

        return app;
    }

    /// <summary>The services every read resolves, bound as one parameter for the complexity gate.</summary>
    public sealed record DoorHistoryDeps(
        MainframeDbContext Db, TenantSettingsAccessor Settings, ITenantContext Tenant, AdminChangeRecorder Recorder);

    /// <summary><c>GET /api/v1/admin/members/{userId}/doors</c> — one page of one person's doors.</summary>
    public static async Task<IResult> HandleAsync(
        Guid userId, HttpContext ctx, [AsParameters] DoorHistoryDeps deps, CancellationToken ct)
    {
        var (refusal, member, query) = await ResolveAsync(userId, ctx, deps, ct);
        if (refusal is not null) return refusal;

        var db = deps.Db;
        var rows = await Rows(query!.Apply(db), userId).Take(query.Limit + 1)
            .Select(a => new DoorHistoryRow(a.Id, a.Action, a.CreatedAt, a.ScanAt, a.DetailsJson))
            .ToListAsync(ct);

        var page = rows.Take(query.Limit).ToList();
        var total = await Rows(query.Filtered(db), userId).CountAsync(ct);
        var doors = await DoorsAsync(db, page.Select(r => r.DeviceId), ct);

        await RecordAsync(deps, ctx, member!, new Viewed(query, page.Count, total, Exported: false), ct);

        return Results.Ok(new
        {
            member = new { user_id = member!.UserId, name = member.Name },
            items = page.Select(r => Item(r, doors)).ToList(),
            next_cursor = rows.Count > query.Limit && page.Count > 0
                ? new DoorLogCursor(page[^1].ScanAt, page[^1].Id).Encode()
                : null,
            total,
            range = new { from = query.From, to = query.To },
            timezone = query.Timezone,
            retention_days = query.RetentionDays,
        });
    }

    /// <summary>
    /// <c>GET /api/v1/admin/members/{userId}/doors.csv</c> — the same filters, as a file, with
    /// the same defuse-then-quote rule every export here obeys (<see cref="CsvCell"/>).
    /// </summary>
    public static async Task<IResult> CsvAsync(
        Guid userId, HttpContext ctx, [AsParameters] DoorHistoryDeps deps, CancellationToken ct)
    {
        var (refusal, member, query) = await ResolveAsync(userId, ctx, deps, ct);
        if (refusal is not null) return refusal;

        var db = deps.Db;
        var rows = await Rows(query!.Apply(db), userId).Take(MaxExportRows + 1)
            .Select(a => new DoorHistoryRow(a.Id, a.Action, a.CreatedAt, a.ScanAt, a.DetailsJson))
            .ToListAsync(ct);

        var truncated = rows.Count > MaxExportRows;
        var exported = rows.Take(MaxExportRows).ToList();
        var doors = await DoorsAsync(db, exported.Select(r => r.DeviceId), ct);

        var csv = new StringBuilder(Header).Append("\r\n");
        foreach (var row in exported) csv.Append(Line(row, doors, query));

        await RecordAsync(deps, ctx, member!, new Viewed(query, exported.Count, exported.Count, Exported: true), ct);

        if (truncated) ctx.Response.Headers[AdminDoorLogEndpoint.TruncatedHeader] = "true";
        ctx.Response.Headers[AdminDoorLogEndpoint.RowsHeader] =
            exported.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);

        // A UTF-8 BOM for Excel, as every export in this API writes one.
        var bytes = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(csv.ToString())).ToArray();
        ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{FileName(member!, query)}\"";
        return Results.File(bytes, "text/csv; charset=utf-8");
    }

    /// <summary>The member this club knows by that id, for the page heading and the audit row.</summary>
    public sealed record DoorMember(Guid UserId, string Name, string MembershipNumber);

    /// <summary>What one read looked at, for the audit row.</summary>
    private sealed record Viewed(DoorLogQuery Query, int Rows, int Total, bool Exported);

    /// <summary>
    /// The query this request names, and the member it is about — or the refusal.
    ///
    /// <para>
    /// The query is parsed FIRST, so a malformed range is a 400 whoever it is about; then the
    /// member, through the tenant-filtered <c>Users</c> set, so another club's member is a
    /// 404 indistinguishable from an invented id; then the door, as the club log checks it.
    /// </para>
    /// </summary>
    private static async Task<(IResult? Refusal, DoorMember? Member, DoorLogQuery? Query)> ResolveAsync(
        Guid userId, HttpContext ctx, DoorHistoryDeps deps, CancellationToken ct)
    {
        var settings = await deps.Settings.GetAsync(ct);
        var now = DateTimeOffset.UtcNow;
        var (parsed, error) = DoorLogQuery.Parse(ctx.Request, settings, now);
        if (error is not null || parsed is null) return (Results.BadRequest(new { error }), null, null);

        var query = NamesARange(ctx.Request)
            ? parsed
            : parsed with { From = now.AddDays(-parsed.RetentionDays).ToUniversalTime(), To = now.ToUniversalTime() };

        var member = await MemberAsync(deps.Db, userId, ct);
        if (member is null) return (Results.NotFound(new { error = MemberNotFound }), null, null);

        if (!await query.DoorIsKnownAsync(deps.Db, ct))
        {
            return (Results.BadRequest(new { error = DoorLogQuery.DoorNotFound }), null, null);
        }

        return (null, member, query);
    }

    /// <summary>Whether the caller named a window at all — any of the three ways the club log accepts.</summary>
    private static bool NamesARange(HttpRequest request)
    {
        foreach (var key in new[] { "from", "to", "period", "day" })
        {
            if (!string.IsNullOrWhiteSpace(request.Query[key].ToString())) return true;
        }
        return false;
    }

    /// <summary>
    /// The member, through the tenant-filtered sets and nothing this method compares. A user row
    /// decides existence — an account with no membership row is still a person of this club.
    /// </summary>
    private static async Task<DoorMember?> MemberAsync(MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        if (!await db.Users.AsNoTracking().AnyAsync(u => u.Id == userId, ct)) return null;

        var membership = await db.Memberships.AsNoTracking()
            .Where(m => m.UserId == userId)
            .Select(m => new { m.FullName, m.MembershipNumber })
            .FirstOrDefaultAsync(ct);

        return new DoorMember(
            userId,
            membership?.FullName ?? AdminChangeRecorder.UnknownActorName,
            membership?.MembershipNumber ?? "");
    }

    /// <summary>
    /// The club log's rows, narrowed to this person.
    ///
    /// <para>
    /// <b>The one predicate that is the whole of D9</b>, and it lives here rather than on
    /// <see cref="DoorLogQuery"/>: that type's point is that it has nowhere to put a member, and
    /// the club log stays structurally unable to be searched by one. Composed AFTER the club
    /// log's own filters so every rule about which rows are door scans — court boxes excluded,
    /// removed doors kept, the retention clamp — is the club log's, not a second copy.
    /// </para>
    /// </summary>
    private static IQueryable<AuditLog> Rows(IQueryable<AuditLog> clubRows, Guid userId)
    {
        return clubRows.Where(a => a.SubjectUserId == userId);
    }

    /// <summary>
    /// <b>The access record.</b>
    ///
    /// <para>
    /// Into <c>audit_log</c>, as <c>member.door_history_viewed</c>, with the admin as actor and
    /// the member as subject — the <c>{actor, subject}</c> pair the repository's "admins act on
    /// behalf of users" invariant asks every admin action to be. <c>RetentionWorker</c>'s door
    /// purge deletes only <c>gate.*</c> and the two offline device actions
    /// (<see cref="DoorTrail.IsPurgeableRow"/>), so this row is NOT swept with the rows it
    /// describes; the ordinary two-year anonymisation nulls its subject like every other row.
    /// </para>
    ///
    /// <para>
    /// <b>And into the trigger-protected <c>admin_change_log</c></b>, as
    /// <see cref="AdminChangeActions.MemberDoorHistoryViewed"/> — the trace's reason: D9 reversed
    /// a privacy rule, and <c>audit_log</c> has a delete path. The two rows are staged on the one
    /// context and flushed by ONE <c>SaveChangesAsync</c>, so a read can never leave one record
    /// without the other.
    /// </para>
    /// </summary>
    private static async Task RecordAsync(
        DoorHistoryDeps deps, HttpContext ctx, DoorMember member, Viewed viewed, CancellationToken ct)
    {
        var query = viewed.Query;
        // B19: one pair of rows per view — an identical re-fetch inside the window is the same look.
        if (!viewed.Exported && !ctx.RequestServices.GetRequiredService<ViewAuditOnce>()
                .ShouldRecord(ctx, AdminChangeActions.MemberDoorHistoryViewed, member.UserId))
        {
            return;
        }
        deps.Db.AuditLogs.Add(new AuditLog
        {
            TenantId = deps.Tenant.TenantId,
            ActorUserId = ctx.User.Id() ?? Guid.Empty,
            SubjectUserId = member.UserId,
            Action = ViewedAction,
            DetailsJson = JsonSerializer.Serialize(new
            {
                range = new { from = query.From, to = query.To },
                door = query.Door,
                outcome = query.Outcome,
                reason = query.Reason,
                page = query.Cursor is not null,
                rows = viewed.Rows,
                total = viewed.Total,
                exported = viewed.Exported,
            }),
        });

        await deps.Recorder.StageAsync(new AdminChange(
            Action: AdminChangeActions.MemberDoorHistoryViewed,
            ActorUserId: ctx.User.Id() ?? Guid.Empty,
            SubjectKind: AdminChangeSubjects.User,
            SubjectId: member.UserId,
            SubjectLabel: member.Name,
            After: new
            {
                range = new { from = query.From, to = query.To },
                door = query.Door,
                outcome = query.Outcome,
                reason = query.Reason,
                rows = viewed.Rows,
                total = viewed.Total,
                exported = viewed.Exported,
            }), ct);

        await deps.Db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// One row as the member's door page reads it. The club log's keys where the meaning is the
    /// same, so one row component can render both; no <c>member</c> (it is the page's subject)
    /// and two additions: the outcome in the machine's word and the identification method.
    /// Block body for the lizard reason in <c>memory/gotchas-gates.md</c>.
    /// </summary>
    private static object Item(DoorHistoryRow row, IReadOnlyDictionary<Guid, DoorRef> doors)
    {
        var details = DoorActivityView.Details(row.DetailsJson);
        var reason = DoorActivityView.Reason(row.Action, details);
        return new
        {
            at = DoorActivityView.ScannedAt(details, row.CreatedAt),
            delivered_at = DoorActivityView.DeliveredAt(details, row.CreatedAt),
            time_uncertain = DoorActivityView.TimeUncertain(details, row.CreatedAt),
            action = row.Action,
            outcome = DoorTrail.OutcomeOf(row.Action),
            reason,
            reason_text = DoorWords.ReasonOf(row.Action, reason),
            offline = DoorActivityView.Offline(details),
            method = details is { } root ? DoorActivityView.Text(root, "method") : null,
            fingerprint = DoorActivityView.Fingerprint(details),
            door = DoorRowDoor.Of(details, doors),
        };
    }

    /// <summary>One line of the export, in the club's zone. Block body for the lizard reason.</summary>
    private static string Line(DoorHistoryRow row, IReadOnlyDictionary<Guid, DoorRef> doors, DoorLogQuery query)
    {
        var details = DoorActivityView.Details(row.DetailsJson);
        var scanned = DoorActivityView.ScannedAt(details, row.CreatedAt);
        var delivered = DoorActivityView.DeliveredAt(details, row.CreatedAt);
        var local = TimeZoneInfo.ConvertTime(scanned, query.Zone);
        var door = DoorRowDoor.Columns(details, doors);
        var reason = DoorActivityView.Reason(row.Action, details);
        var invariant = System.Globalization.CultureInfo.InvariantCulture;

        return CsvCell.Line(
            local.ToString("yyyy-MM-dd", invariant),
            local.ToString("HH:mm:ss", invariant),
            query.Timezone,
            scanned.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", invariant),
            door.Key,
            door.Name,
            DoorWords.OutcomeOf(row.Action),
            DoorWords.ReasonOf(row.Action, reason),
            reason,
            DoorActivityView.Offline(details) ? "yes" : "no",
            details is { } root ? DoorActivityView.Text(root, "method") : null,
            DoorActivityView.Fingerprint(details),
            DoorActivityView.TimeUncertain(details, row.CreatedAt) ? "yes" : "",
            delivered is { } arrived ? arrived.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", invariant) : "");
    }

    /// <summary>
    /// The file's name: the MEMBERSHIP NUMBER and the exact range, in the club's zone — the
    /// trace export's rule, because a filename is the part of a file that travels furthest.
    /// </summary>
    private static string FileName(DoorMember member, DoorLogQuery query)
    {
        var who = string.Concat((member.MembershipNumber.Length > 0 ? member.MembershipNumber : "member")
            .Where(c => char.IsAsciiLetterOrDigit(c) || c == '-'));
        var invariant = System.Globalization.CultureInfo.InvariantCulture;
        var from = TimeZoneInfo.ConvertTime(query.From, query.Zone).ToString("yyyy-MM-dd'T'HHmm", invariant);
        var to = TimeZoneInfo.ConvertTime(query.To, query.Zone).ToString("yyyy-MM-dd'T'HHmm", invariant);
        return $"member-doors-{who}-{from}-to-{to}.csv";
    }

    /// <summary>The live boards one page's rows name, in one tenant-filtered read.</summary>
    private static async Task<Dictionary<Guid, DoorRef>> DoorsAsync(
        MainframeDbContext db, IEnumerable<Guid?> deviceIds, CancellationToken ct)
    {
        var ids = deviceIds.Where(d => d is not null).Select(d => d!.Value).Distinct().ToList();
        if (ids.Count == 0) return [];

        return await db.Devices.AsNoTracking()
            .Where(d => ids.Contains(d.Id))
            .Select(d => new DoorRef(d.Id, d.Name, d.GateKey))
            .ToDictionaryAsync(d => d.Id, d => d, ct);
    }
}

/// <summary>One door row as read for a member's history — the five columns every rendering needs.</summary>
public sealed record DoorHistoryRow(Guid Id, string Action, DateTimeOffset CreatedAt, DateTimeOffset ScanAt, string? DetailsJson)
{
    /// <summary>The board this row names, from its stored details.</summary>
    public Guid? DeviceId
    {
        get { return DoorTrail.DeviceIdOf(DoorActivityView.Details(DetailsJson)); }
    }
}
