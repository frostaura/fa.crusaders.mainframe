using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// GOAL item 14's "admin-wide admin record of these admin changes so even they can monitor
/// themselves", as a read.
///
/// <para>
/// <b>Read-only, and there is no sibling that writes or deletes.</b> Rows arrive through
/// <see cref="AdminChangeRecorder"/> from whichever endpoint performed the change; this file
/// has no <c>MapPost</c>, no <c>MapDelete</c> and no <c>MapPatch</c>, and
/// <c>AdminChangeLogPostureTests</c> is what keeps that true.
/// </para>
///
/// <para>
/// <b>The record is not filterable by subject MEMBER except on the member and <c>credit</c> (minutes) areas.</b>
/// There it means "this admin did something to this member", which is a question about an
/// administrator. Everywhere else it would be a second way to ask "where was this person",
/// which is the night trace's question and belongs only to the night trace's route, with the
/// night trace's own audit of who looked. <see cref="AdminChangeQuery.SubjectIdNeedsArea"/>.
/// </para>
/// </summary>
public static class AdminChangeEndpoints
{
    /// <summary>Column headings of the export, in the order the rows are written.</summary>
    private const string Header = "occurred_at,actor,actor_email,area,action,headline,subject_kind,subject,reason,changes";

    /// <summary>How many rows the file actually holds, so the page announces the file and not its page size.</summary>
    public const string RowsHeader = "X-Crusaders-Rows";

    /// <summary>Set on a truncated export, so the console can say the file is not the whole range.</summary>
    public const string TruncatedHeader = "X-Crusaders-Truncated";

    public static IEndpointRouteBuilder MapAdminChangeEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin").RequireAuthorization(p => p.RequireRole("admin"));

        // The export is a sibling path rather than a segment under /changes, matching the
        // doors group's `activity` / `activity.csv` pair: the file and the page answer the same
        // query string, so they read as one surface.
        g.MapGet("/changes.csv", CsvAsync);
        g.MapGet("/changes", HandleAsync);

        return app;
    }

    /// <summary>
    /// One page of the club's change record.
    ///
    /// <para>
    /// Loading, empty and failed are three different states on the wire: an empty
    /// <c>rows</c> with a populated <c>total</c> of zero and the <c>retention</c> sentence is
    /// "nothing happened in this range", which is an answer; a refusal is "that is not a
    /// question I can bound", which is a different one.
    /// </para>
    /// </summary>
    public static async Task<IResult> HandleAsync(
        HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settings, CancellationToken ct)
        => await PageAsync(ctx, db, settings, schedule: null, ct);

    /// <summary>The same rows narrowed to one schedule — <c>GET /api/v1/admin/schedules/{id}/changes</c>.</summary>
    public static async Task<IResult> ForScheduleAsync(
        Guid id, HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settings, CancellationToken ct)
        => await PageAsync(ctx, db, settings, schedule: id, ct);

    private static async Task<IResult> PageAsync(
        HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settings, Guid? schedule, CancellationToken ct)
    {
        var view = await settings.GetAsync(ct);
        var (query, error) = AdminChangeQuery.Parse(ctx.Request, view, DateTimeOffset.UtcNow, schedule);
        if (error is not null) return Results.BadRequest(new { error });

        var rows = await query!.Apply(db).Take(query.Limit + 1).ToListAsync(ct);
        var hasMore = rows.Count > query.Limit;
        if (hasMore) rows.RemoveAt(rows.Count - 1);

        var total = await query.TotalAsync(db, ct);

        return Results.Ok(new
        {
            rows = rows.Select(Project).ToList(),
            total,
            cursor = hasMore && rows.Count > 0
                ? new AdminChangeCursor(rows[^1].OccurredAt, rows[^1].Id).Encode()
                : null,
            range = new { from = query.From, to = query.To },
            timezone = query.Timezone,
            retention = AdminChangeQuery.RetentionSentence,
        });
    }

    /// <summary>
    /// One row as the console reads it — the headline and the diff already composed.
    ///
    /// <para>
    /// The actor's name comes off the ROW, not from a join: it was copied at write time
    /// precisely so this record still reads correctly after the person has been renamed,
    /// anonymised or removed. Resolving it here would undo that.
    /// </para>
    /// </summary>
    private static object Project(AdminChangeLog row)
    {
        // Block body rather than an expression body, for the lizard reason in
        // memory/gotchas.md: lizard's C# parser cannot follow an expression body whose
        // value carries braces (`=> new { … }`, `=> x switch { … }`). It loses scope and
        // emits a *global* pseudo-function spanning the whole FILE, which then trips the
        // 200-line gate on any file long enough to matter.
        return new
        {
            id = row.Id,
            occurred_at = row.OccurredAt,
            actor = new { user_id = row.ActorUserId, name = row.ActorName, email = row.ActorEmail },
            area = row.Area,
            action = row.Action,
            headline = AdminChangeActions.Headline(row.Action, row.SubjectLabel),
            subject = row.SubjectKind is null && row.SubjectId is null && row.SubjectLabel is null
                ? null
                : new { kind = row.SubjectKind, id = row.SubjectId, label = row.SubjectLabel },
            reason = row.Reason,
            changes = AdminChangeDiff.Of(row.BeforeJson, row.AfterJson)
                .Select(f => new { field = f.Field, label = f.Label, before = f.Before, after = f.After })
                .ToList(),
        };
    }

    /// <summary>
    /// The same range as a file.
    ///
    /// <para>
    /// <b>The export writes its own row into the record it exports.</b> An export is a thing
    /// that happened to a club's own records, and this is the one table where that fact cannot
    /// later be removed. It carries no subject — an export is about a range, not a person, and
    /// naming one would be where this surface started keeping a per-member record of an admin's
    /// reading habits.
    /// </para>
    /// </summary>
    public static async Task<IResult> CsvAsync(
        HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settings,
        AdminChangeRecorder recorder, CancellationToken ct)
    {
        var view = await settings.GetAsync(ct);
        var (query, error) = AdminChangeQuery.Parse(ctx.Request, view, DateTimeOffset.UtcNow);
        if (error is not null) return Results.BadRequest(new { error });

        var rows = await query!.Filtered(db)
            .OrderByDescending(a => a.OccurredAt).ThenByDescending(a => a.Id)
            .Take(AdminChangeQuery.MaxExportRows + 1)
            .ToListAsync(ct);

        var truncated = rows.Count > AdminChangeQuery.MaxExportRows;
        if (truncated) rows.RemoveAt(rows.Count - 1);

        var csv = new StringBuilder(Header).Append("\r\n");
        foreach (var row in rows)
        {
            var changes = AdminChangeDiff.Of(row.BeforeJson, row.AfterJson);
            csv.Append(CsvCell.Line(
                TimeZoneInfo.ConvertTime(row.OccurredAt, query.Zone).ToString("yyyy-MM-dd HH:mm:ss"),
                row.ActorName,
                row.ActorEmail,
                row.Area,
                row.Action,
                AdminChangeActions.Headline(row.Action, row.SubjectLabel),
                row.SubjectKind,
                row.SubjectLabel,
                row.Reason,
                string.Join("; ", changes.Select(c => $"{c.Label}: {c.Before ?? "—"} → {c.After ?? "—"}"))));
        }

        // Into the undeletable record, not audit_log: audit_log has a delete path, and a club
        // that can remove the evidence of its own exports has not recorded them.
        await recorder.RecordAsync(new AdminChange(
            Action: AdminChangeActions.ChangesExported,
            ActorUserId: ctx.User.Id() ?? Guid.Empty,
            SubjectKind: AdminChangeSubjects.Setting,
            SubjectLabel: "Change record",
            After: new
            {
                from = query.From,
                to = query.To,
                area = query.Area,
                action = query.Action,
                rows = rows.Count,
                truncated,
            }), ct);

        if (truncated) ctx.Response.Headers[TruncatedHeader] = "true";
        ctx.Response.Headers[RowsHeader] = rows.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);

        // A UTF-8 BOM, because Excel reads a BOM-less UTF-8 file in the machine's legacy code
        // page and a club whose admin is named "José" gets mojibake in its own audit trail.
        var bytes = Encoding.UTF8.GetPreamble()
            .Concat(Encoding.UTF8.GetBytes(csv.ToString())).ToArray();

        ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{FileName(query)}\"";
        return Results.File(bytes, "text/csv; charset=utf-8");
    }

    /// <summary>
    /// What the file is called: the exact range it holds, in the club's own zone.
    ///
    /// <para>
    /// The door log's lesson (A4) — a file is forwarded, printed and filed under its name, so
    /// the name has to be the range rather than a shape the range usually has.
    /// </para>
    /// </summary>
    private static string FileName(AdminChangeQuery query)
    {
        var from = TimeZoneInfo.ConvertTime(query.From, query.Zone);
        var to = TimeZoneInfo.ConvertTime(query.To, query.Zone);
        var whole = DoorClock.IsStartOfLocalDay(query.Zone, from) && DoorClock.IsStartOfLocalDay(query.Zone, to);
        return whole
            ? $"admin-changes-{from:yyyy-MM-dd}-{to.AddDays(-1):yyyy-MM-dd}.csv"
            : $"admin-changes-{from:yyyy-MM-dd-HHmm}-{to:yyyy-MM-dd-HHmm}.csv";
    }
}
