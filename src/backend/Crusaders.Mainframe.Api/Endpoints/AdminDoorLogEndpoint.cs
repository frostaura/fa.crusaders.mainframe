using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// W1.3 — the club's door log across every door, and the CSV of whatever is on screen.
///
/// <para>
/// <b>This is the reader <c>door-gate.md</c> §5 assumed existed and nothing provided.</b> The
/// spec argues at length that a door's audit row matters more than a court box's, because
/// there is no ledger entry, no booking and no receipt to reconstruct an open from — and then
/// the product shipped with the only per-BOARD reader and no way to ask "what happened at any
/// door last night", which is the question a desk actually asks.
/// </para>
///
/// <para>
/// <b>Door, time, outcome. There is no member filter and there will not be one</b> — P3, and
/// <see cref="DoorLogQuery"/> has nowhere to put one. The CSV carries the member COLUMN,
/// because an export of the club's own log is the club's record and a row with no identity in
/// it answers nothing; what P3 forbids is the club searching its log BY a person, which is the
/// shape that turns an operations log into an attendance report.
/// </para>
/// </summary>
public static class AdminDoorLogEndpoint
{
    /// <summary>The audit action an export writes.</summary>
    public const string ExportedAction = "doors.log_exported";

    /// <summary>
    /// Most rows one export contains.
    ///
    /// <para>
    /// Ten thousand: comfortably more than a year of a busy club's doors, and small enough that
    /// the file builds in memory in one pass without a request that times out and gets retried
    /// — which on a GET is how one export becomes six. A truncated export says so in a header
    /// rather than silently handing a club a file it believes is complete.
    /// </para>
    /// </summary>
    public const int MaxExportRows = 10_000;

    /// <summary>Set on a truncated export, so the console can say the file is not the whole range.</summary>
    public const string TruncatedHeader = "X-Crusaders-Truncated";

    /// <summary>
    /// How many scan rows the file actually holds.
    ///
    /// <para>
    /// <b>The page could not know and said a number anyway.</b> The export ignores paging —
    /// correctly: a club exporting a filtered range wants the range, not the fifty rows on
    /// screen — but the console had only its own page size to announce, so a 165-row file was
    /// reported as "50 scans downloaded". A browser cannot read a response header it has not
    /// been allowed to, so this and <see cref="TruncatedHeader"/> are both named in the CORS
    /// policy's exposed headers; without that line the header is present on the wire and
    /// invisible to the page, which is the same defect wearing a fix.
    /// </para>
    /// </summary>
    public const string RowsHeader = "X-Crusaders-Rows";

    /// <summary>
    /// The export's columns, in order. Stated as a constant because the CSV is a contract with
    /// a spreadsheet and with the frontend's own copy, and a header row assembled inline is a
    /// contract nothing can assert against.
    /// </summary>
    public const string Header =
        "date,time,timezone,at_utc,door,door_name,outcome,reason,reason_code,offline,member,code_fingerprint";

    /// <summary>
    /// <c>GET /api/v1/admin/doors/activity</c> — one page of the club's door log.
    /// </summary>
    public static async Task<IResult> HandleAsync(
        HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct)
    {
        var settings = await settingsAccessor.GetAsync(ct);
        var (query, error) = DoorLogQuery.Parse(ctx.Request, settings, DateTimeOffset.UtcNow);
        if (error is not null || query is null) return Results.BadRequest(new { error });

        // One row more than asked for, which is how "is there a next page" is answered without
        // a second COUNT over an append-only table.
        var rows = await query.Apply(db).Take(query.Limit + 1)
            .Select(a => new { a.Id, a.Action, a.CreatedAt, a.SubjectUserId, a.DetailsJson })
            .ToListAsync(ct);

        var page = rows.Take(query.Limit).ToList();
        var names = await NamesAsync(db, page.Select(r => r.SubjectUserId), ct);
        var doors = await DoorsAsync(db, page.Select(r => DoorTrail.DeviceIdOf(DoorActivityView.Details(r.DetailsJson))), ct);

        return Results.Ok(new
        {
            items = page
                .Select(r => DoorActivityView.WithDoor(
                    r.Action, r.CreatedAt, r.SubjectUserId, r.DetailsJson, names, DoorOf(r.DetailsJson, doors)))
                .ToList(),
            next_cursor = rows.Count > query.Limit && page.Count > 0
                ? new DoorLogCursor(page[^1].CreatedAt, page[^1].Id).Encode()
                : null,

            // W1.9's number, so the page's retention statement is the club's own and not a
            // constant the console carries.
            retention_days = query.RetentionDays,
        });
    }

    /// <summary>
    /// <c>GET /api/v1/admin/doors/activity.csv</c> — the same filters, as a file.
    ///
    /// <para>
    /// <b>Every cell is defused before it is written.</b> A door's name, a member's name and a
    /// gate key are all club-entered strings that land unescaped in a spreadsheet, and a cell
    /// beginning <c>=</c>, <c>+</c>, <c>-</c> or <c>@</c> is a formula there — including
    /// <c>=HYPERLINK</c> and, in some configurations, worse. The value is kept intact and
    /// prefixed with an apostrophe, so the log is still readable and cannot execute. The
    /// alternative, stripping the character, would quietly corrupt a door genuinely named
    /// <c>-Side</c>.
    /// </para>
    /// </summary>
    public static async Task<IResult> CsvAsync(
        HttpContext ctx, MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settingsAccessor,
        CancellationToken ct)
    {
        var settings = await settingsAccessor.GetAsync(ct);
        var (query, error) = DoorLogQuery.Parse(ctx.Request, settings, DateTimeOffset.UtcNow);
        if (error is not null || query is null) return Results.BadRequest(new { error });

        var rows = await query.Apply(db).Take(MaxExportRows + 1)
            .Select(a => new { a.Action, a.CreatedAt, a.SubjectUserId, a.DetailsJson })
            .ToListAsync(ct);

        var truncated = rows.Count > MaxExportRows;
        var exported = rows.Take(MaxExportRows).ToList();
        var names = await NamesAsync(db, exported.Select(r => r.SubjectUserId), ct);
        var doors = await DoorsAsync(
            db, exported.Select(r => DoorTrail.DeviceIdOf(DoorActivityView.Details(r.DetailsJson))), ct);

        // The club's own zone, so the two readable columns are the times an admin saw on the
        // screen they exported from. A zone this platform does not know falls back to UTC and
        // SAYS so in the `timezone` column, rather than printing local-looking times that are
        // not — the same rule DoorDay applies to the day boundary.
        var day = DoorDay.StartOfToday(settings, DateTimeOffset.UtcNow);
        var zone = TimeZoneInfo.TryFindSystemTimeZoneById(day.Timezone, out var found) ? found : TimeZoneInfo.Utc;

        var csv = new StringBuilder(Header).Append("\r\n");
        foreach (var row in exported)
        {
            var details = DoorActivityView.Details(row.DetailsJson);
            var door = DoorTrail.DeviceIdOf(details) is { } id && doors.TryGetValue(id, out var d) ? d : null;
            csv.Append(Line(row.Action, row.CreatedAt, row.SubjectUserId, details, door, names, zone, day.Timezone));
        }

        // The export is a thing that happened to a club's own records, so the trail says who
        // did it, what they asked for and how much came back. No subject: an export is about
        // a range of rows, not about a person, and naming one would be the first place this
        // surface started keeping a per-member record of an admin's reading habits.
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = tenant.TenantId,
            ActorUserId = ctx.User.Id() ?? Guid.Empty,
            SubjectUserId = null,
            Action = ExportedAction,
            DetailsJson = JsonSerializer.Serialize(new
            {
                door = query.Door,
                from = query.From,
                to = query.To,
                outcome = query.Outcome,
                reason = query.Reason,
                rows = exported.Count,
                truncated,
            }),
        });
        await db.SaveChangesAsync(ct);

        if (truncated) ctx.Response.Headers[TruncatedHeader] = "true";

        // The real count, so the page announces the file rather than its own page size (B3).
        ctx.Response.Headers[RowsHeader] = exported.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);

        // A UTF-8 BOM, because Excel reads a BOM-less UTF-8 file in the machine's legacy code
        // page and a club whose door is named "Café" gets mojibake on a wall-printed report.
        // Every other reader tolerates it; Excel is the one that does not tolerate its absence.
        var bytes = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(csv.ToString())).ToArray();

        // Quoted, as WIRE-W1 §4 says and as RFC 6266 wants (S2). Unquoted it survives only
        // because this filename happens to contain no space or comma today.
        var filename = $"door-log-{query.From:yyyy-MM-dd}-{query.To:yyyy-MM-dd}.csv";
        ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{filename}\"";
        return Results.File(bytes, "text/csv; charset=utf-8");
    }

    /// <summary>
    /// One row of the file, spreadsheet-first.
    ///
    /// <para>
    /// <b>Every column here was a complaint (B4).</b> The instant was a round-trip ISO string
    /// with seven fractional digits, which Excel will not parse at all and which read two
    /// hours off every screen the admin had just been looking at, with nothing on the row
    /// saying which zone it was in. It is now four columns: <c>date</c> and <c>time</c> in the
    /// club's zone and in the formats a spreadsheet recognises without being told,
    /// <c>timezone</c> so the file is still unambiguous when it is mailed on, and
    /// <c>at_utc</c> to the second for anybody reconciling against another system.
    /// </para>
    ///
    /// <para>
    /// The instant is the SCAN's, not the row's — see <see cref="DoorActivityView.ScannedAt"/>.
    /// An offline scan happened when somebody stood at the door and was recorded when the
    /// board next called in, and an export stamped with the second answers the wrong question.
    /// </para>
    ///
    /// <para>
    /// Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static string Line(
        string action, DateTimeOffset at, Guid? subjectUserId, JsonElement? details, DoorRef? door,
        IReadOnlyDictionary<Guid, string> names, TimeZoneInfo zone, string timezone)
    {
        var member = subjectUserId is { } id && id != Guid.Empty
            ? names.TryGetValue(id, out var name) ? name : ""
            : "";

        var scanned = DoorActivityView.ScannedAt(details, at);
        var local = TimeZoneInfo.ConvertTime(scanned, zone);
        var invariant = System.Globalization.CultureInfo.InvariantCulture;

        var cells = new[]
        {
            local.ToString("yyyy-MM-dd", invariant),
            local.ToString("HH:mm:ss", invariant),
            timezone,
            scanned.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", invariant),
            door?.GateKey ?? "",
            door?.Name ?? "",
            DoorWords.OutcomeOf(action) ?? "",
            DoorWords.ReasonOf(DoorActivityView.Reason(details)),

            // The machine value beside the words: a club filtering a spreadsheet wants the
            // stable one, and a club reading it wants the sentence.
            DoorActivityView.Reason(details) ?? "",
            DoorActivityView.Offline(details) ? "yes" : "no",
            member,
            DoorActivityView.Fingerprint(details) ?? "",
        };
        return string.Join(",", cells.Select(Cell)) + "\r\n";
    }

    /// <summary>
    /// One cell: defused against a spreadsheet's formula parser, then quoted against the CSV
    /// grammar. Both, in that order — a value quoted first would still begin with <c>=</c>
    /// once the quotes were stripped by the reader.
    /// </summary>
    private static string Cell(string value)
    {
        var safe = value.Length > 0 && value[0] is '=' or '+' or '-' or '@' ? "'" + value : value;
        return safe.Contains(',') || safe.Contains('"') || safe.Contains('\n') || safe.Contains('\r')
            ? "\"" + safe.Replace("\"", "\"\"") + "\""
            : safe;
    }

    /// <summary>
    /// The membership names for one page, in one read. The NAME only — the booking-grid rule
    /// applies here as everywhere: no email, no membership number, nothing else a club holds.
    /// </summary>
    private static async Task<Dictionary<Guid, string>> NamesAsync(
        MainframeDbContext db, IEnumerable<Guid?> subjects, CancellationToken ct)
    {
        var ids = subjects.Where(s => s is not null).Select(s => s!.Value).Distinct().ToList();
        if (ids.Count == 0) return [];

        return await db.Memberships.AsNoTracking()
            .Where(m => ids.Contains(m.UserId))
            .Select(m => new { m.UserId, m.FullName })
            .ToDictionaryAsync(m => m.UserId, m => m.FullName, ct);
    }

    /// <summary>
    /// The doors one page's rows name, in one read, tenant-filtered like everything else — a
    /// device id inside a jsonb document proves nothing about whose board it is.
    /// </summary>
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

    /// <summary>The door a row belongs to, or null when the board has been deleted since.</summary>
    private static object? DoorOf(string? detailsJson, IReadOnlyDictionary<Guid, DoorRef> doors)
    {
        if (DoorTrail.DeviceIdOf(DoorActivityView.Details(detailsJson)) is not { } id) return null;
        if (!doors.TryGetValue(id, out var door)) return null;
        return new { id = door.Id, name = door.Name, gate_key = door.GateKey };
    }
}

/// <summary>
/// The three things a log row says about its door. Top-level and bodyless for the lizard reason
/// recorded in <c>memory/gotchas.md</c>.
/// </summary>
public sealed record DoorRef(Guid Id, string Name, string? GateKey);
