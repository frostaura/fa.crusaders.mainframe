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
/// <b>Door, time, outcome. There is no member filter on THIS log and there will not be one</b>
/// — P3, and <see cref="DoorLogQuery"/> has nowhere to put one. One named person's rows are a
/// different, audited route since D9 (<see cref="AdminMemberDoorEndpoints"/>); this log still
/// cannot be searched by a person. The CSV carries the member COLUMN,
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
    /// <remarks>
    /// <para>
    /// <c>delivered_at_utc</c> is LAST and is blank on every online row (E-L1). The file had the
    /// scan's instant and not the delivery's, so an export could not answer "when did the club
    /// actually hear about this" — the question an outage is reconciled with — and a reader
    /// comparing the file against "last heard from" had nothing to compare. Appended rather than
    /// inserted beside <c>at_utc</c>, because a club's saved spreadsheet formulae address
    /// columns by position.
    /// </para>
    /// <para>
    /// <c>time_uncertain</c> goes IMMEDIATELY BEFORE it, which WIRE-R3 §2 pins and which is the
    /// one place a column may be inserted rather than appended: the two are read together —
    /// the flag is about the relationship between the scan's time and the delivery's — and a
    /// club that has to scroll past six columns to find out that the time beside it is
    /// approximate will not. It moves <c>delivered_at_utc</c> by one position, which is why the
    /// header is a pinned constant and <c>AdminDoorLogHttpTests</c> asserts the whole line.
    /// </para>
    /// </remarks>
    public const string Header =
        "date,time,timezone,at_utc,door,door_name,outcome,reason,reason_code,offline,member," +
        "code_fingerprint,time_uncertain,delivered_at_utc";

    /// <summary>
    /// <c>GET /api/v1/admin/doors/activity</c> — one page of the club's door log.
    /// </summary>
    public static async Task<IResult> HandleAsync(
        HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct)
    {
        var settings = await settingsAccessor.GetAsync(ct);
        var (query, error) = DoorLogQuery.Parse(ctx.Request, settings, DateTimeOffset.UtcNow);
        if (error is not null || query is null) return Results.BadRequest(new { error });

        // A door this club has never had, or one another club has. See DoorLogQuery.DoorNotFound
        // for what answering an empty list under the normal heading told an admin (A-C2).
        if (!await query.DoorIsKnownAsync(db, ct))
        {
            return Results.BadRequest(new { error = DoorLogQuery.DoorNotFound });
        }

        // One row more than asked for, which is how "is there a next page" is answered without
        // a second COUNT over an append-only table.
        var rows = await query.Apply(db).Take(query.Limit + 1)
            .Select(a => new { a.Id, a.Action, a.CreatedAt, a.ScanAt, a.SubjectUserId, a.DetailsJson })
            .ToListAsync(ct);

        var page = rows.Take(query.Limit).ToList();
        var names = await NamesAsync(db, page.Select(r => r.SubjectUserId), ct);
        var doors = await DoorsAsync(db, page.Select(r => DoorTrail.DeviceIdOf(DoorActivityView.Details(r.DetailsJson))), ct);

        return Results.Ok(new
        {
            items = page
                .Select(r => DoorActivityView.WithDoor(
                    r.Action, r.CreatedAt, r.SubjectUserId, r.DetailsJson, names,
                    DoorRowDoor.Of(DoorActivityView.Details(r.DetailsJson), doors)))
                .ToList(),
            next_cursor = rows.Count > query.Limit && page.Count > 0
                ? new DoorLogCursor(page[^1].ScanAt, page[^1].Id).Encode()
                : null,

            // How many rows the RANGE holds, not how many this page carries (A6 / E-M2). See
            // DoorLogQuery.Filtered for why it is counted without the cursor.
            total = await query.Filtered(db).CountAsync(ct),

            // The range this server actually resolved, and the zone it was resolved IN — so the
            // page states the window in words above the rows rather than inferring one from the
            // period name it sent (A4, O1).
            //
            // BOTH EDGES ARE UTC INSTANTS, and `timezone` is what a console renders them with.
            // DoorLogQuery normalises every resolved edge with `.ToUniversalTime()` because
            // Npgsql refuses a non-zero offset on a `timestamptz`, and the same value is what
            // the query ran against — so the range on the wire is the range that was read,
            // rather than a second rendering of it that could disagree. The club's own offset is
            // never lost: it is `timezone`, and the export's filename is written through it.
            range = new { from = query.From, to = query.To },
            timezone = query.Timezone,

            // Every removed door that still has rows the log can answer for, so the door filter
            // can offer them (A2). A deleted board's rows were reachable and unnameable: not in
            // the filter, unlabelled in the export, and — until DoorRowDoor — a white page.
            removed_doors = await RemovedDoorsAsync(db, query, ct),

            // W1.9's number, so the page's retention statement is the club's own and not a
            // constant the console carries.
            retention_days = query.RetentionDays,
        });
    }

    /// <summary>
    /// The doors that have been DELETED and still have scan rows inside the club's retention.
    ///
    /// <para>
    /// <b>Found through <c>device.deleted</c> rather than by scanning the log for orphans.</b>
    /// The delete writes one audit row naming the board, that row lives under
    /// <c>retention_years</c> rather than the door retention (see
    /// <see cref="DoorTrail.IsPurgeableRow"/>, which names the two <c>device.*</c> actions
    /// exactly), and a board's scans are always OLDER than its delete — so every removed door
    /// that could still have rows in range has a delete row in range too. That makes the
    /// candidate set small and indexed, where a <c>DISTINCT</c> over a club's ninety days of
    /// jsonb would be neither.
    /// </para>
    ///
    /// <para>
    /// An id that is back in the devices table is not removed: a board that re-registers gets a
    /// NEW row and a new id, so this can only happen if somebody recreated the row by hand, and
    /// a live board is not a removed door whatever its history says.
    /// </para>
    ///
    /// <para>
    /// The name and key come off the newest surviving ROW, which is the only place they can
    /// come from once the device row is gone — and is exactly what
    /// <see cref="DoorRowDoor.StoredName"/> reads for the rows themselves, so the filter's label
    /// and the rows' labels cannot disagree.
    /// </para>
    /// </summary>
    private static async Task<List<object>> RemovedDoorsAsync(
        MainframeDbContext db, DoorLogQuery query, CancellationToken ct)
    {
        var floor = DateTimeOffset.UtcNow.AddDays(-query.RetentionDays).ToUniversalTime();

        var deleted = await db.AuditLogs.AsNoTracking()
            .Where(a => a.Action == DoorAuditActions.Deleted && a.CreatedAt >= floor)
            .OrderByDescending(a => a.CreatedAt)
            .Take(MaxRemovedDoors)
            .Select(a => a.DetailsJson)
            .ToListAsync(ct);

        var candidates = deleted
            .Select(d => DoorTrail.DeviceIdOf(DoorActivityView.Details(d)))
            .Where(d => d is not null).Select(d => d!.Value).Distinct().ToList();
        if (candidates.Count == 0) return [];

        var stillLive = await db.Devices.AsNoTracking()
            .Where(d => candidates.Contains(d.Id)).Select(d => d.Id).ToListAsync(ct);

        var removed = new List<object>();
        foreach (var id in candidates.Where(c => !stillLive.Contains(c)))
        {
            var containment = JsonSerializer.Serialize(new { device_id = id });
            var newest = await db.AuditLogs.AsNoTracking()
                .Where(DoorTrail.IsScanRow)
                .Where(a => a.CreatedAt >= floor)
                .Where(a => a.DetailsJson != null && EF.Functions.JsonContains(a.DetailsJson, containment))
                .OrderByDescending(a => a.CreatedAt)
                .Select(a => a.DetailsJson)
                .FirstOrDefaultAsync(ct);
            if (newest is null) continue;

            var details = DoorActivityView.Details(newest);
            removed.Add(new
            {
                key = id.ToString(),
                name = DoorRowDoor.StoredName(details),
                gate_key = DoorRowDoor.StoredKey(details),
            });
        }
        return removed;
    }

    /// <summary>
    /// Most removed doors one response will name. A club that has deleted more than this many
    /// boards inside its retention has a bigger problem than a filter list, and an unbounded
    /// loop of containment reads on a page load is not the place to find out.
    /// </summary>
    public const int MaxRemovedDoors = 50;

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

        // Refused BEFORE a file is built, and before the export audit row is written: a zero-row
        // CSV under the ordinary filename is the worst of the three answers, because it is
        // forwarded and filed as evidence that nothing happened. See DoorLogQuery.DoorNotFound.
        if (!await query.DoorIsKnownAsync(db, ct))
        {
            return Results.BadRequest(new { error = DoorLogQuery.DoorNotFound });
        }

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
        // not — the same rule DoorDay applies to the day boundary. Resolved once, at parse
        // time, so the range, the columns and the filename are all in one zone.
        var clock = new CsvClock(query.Zone, query.Timezone);

        var csv = new StringBuilder(Header).Append("\r\n");
        foreach (var row in exported)
        {
            var details = DoorActivityView.Details(row.DetailsJson);
            csv.Append(Line(
                row.Action, row.CreatedAt, MemberName(row.SubjectUserId, names), details,
                DoorRowDoor.Columns(details, doors), clock));
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
        ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{FileName(query)}\"";
        return Results.File(bytes, "text/csv; charset=utf-8");
    }

    /// <summary>
    /// What the file is called: the exact range it holds, in the club's own zone.
    ///
    /// <para>
    /// <b>A4 — the chair was nearly given half of yesterday.</b> The name was
    /// <c>door-log-&lt;date&gt;-&lt;date&gt;.csv</c> whatever the range was, so the rolling
    /// twenty-four-hour default produced a file called "the 20th to the 21st" holding from
    /// 09:50 on one to 09:50 on the other. A file is forwarded, printed and filed under its
    /// name, and the name was the only thing about it that was not true.
    /// </para>
    ///
    /// <para>
    /// <b>Two dates when both ends are club-local midnights, and date-and-time otherwise.</b>
    /// The common case — a period, a day, a week — stays readable, and the case that was lying
    /// says so in the name: <c>door-log-2026-09-20T0950-to-2026-09-21T0950.csv</c>. The file's
    /// FIRST LINE is still the header row and not a comment: a club opens this in a spreadsheet
    /// and a machine-clean file is worth more than a banner (A4's own ruling).
    /// </para>
    ///
    /// <para>
    /// Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    public static string FileName(DoorLogQuery query)
    {
        var wholeDays = DoorClock.IsStartOfLocalDay(query.Zone, query.From)
                        && DoorClock.IsStartOfLocalDay(query.Zone, query.To);
        var format = wholeDays ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HHmm";
        var invariant = System.Globalization.CultureInfo.InvariantCulture;

        var from = TimeZoneInfo.ConvertTime(query.From, query.Zone).ToString(format, invariant);
        var to = TimeZoneInfo.ConvertTime(query.To, query.Zone).ToString(format, invariant);
        return $"door-log-{from}-to-{to}.csv";
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
        string action, DateTimeOffset at, string member, JsonElement? details,
        (string Key, string Name) door, CsvClock clock)
    {
        var scanned = DoorActivityView.ScannedAt(details, at);
        var delivered = DoorActivityView.DeliveredAt(details, at);
        var local = TimeZoneInfo.ConvertTime(scanned, clock.Zone);
        var invariant = System.Globalization.CultureInfo.InvariantCulture;

        var cells = new[]
        {
            local.ToString("yyyy-MM-dd", invariant),
            local.ToString("HH:mm:ss", invariant),
            clock.Timezone,
            scanned.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", invariant),

            // From the live board where there is one and from what the row itself stored where
            // there is not, so a removed door's rows are still named in the file (E-M1).
            door.Key,
            door.Name,
            DoorWords.OutcomeOf(action) ?? "",
            DoorWords.ReasonOf(action, DoorActivityView.Reason(action, details)),

            // The machine value beside the words: a club filtering a spreadsheet wants the
            // stable one, and a club reading it wants the sentence.
            DoorActivityView.Reason(action, details) ?? "",
            DoorActivityView.Offline(details) ? "yes" : "no",
            member,
            DoorActivityView.Fingerprint(details) ?? "",

            // "yes" or blank, BEFORE delivered_at_utc as WIRE-R3 §2 pins it. A spreadsheet is
            // the copy most likely to be printed and quoted, and it is the one surface with no
            // room for the sentence the console puts beside an approximate time — so the flag
            // has to be its own column rather than a footnote nobody exports. Blank rather than
            // "no" for the same reason the delivery column is blank on an online row: the
            // absence is the ordinary case and a column of "no" reads as an assertion.
            DoorActivityView.TimeUncertain(details, at) ? "yes" : "",

            // Blank on an online row rather than a copy of at_utc, for the same reason
            // `delivered_at` is null there: a delivery time for a decision the server made as
            // it happened would be a delay the file invented.
            delivered is { } arrived ? arrived.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", invariant) : "",
        };
        return string.Join(",", cells.Select(Cell)) + "\r\n";
    }

    /// <summary>
    /// One cell: defused against a spreadsheet's formula parser, then quoted against the CSV
    /// grammar. Both, in that order — a value quoted first would still begin with <c>=</c>
    /// once the quotes were stripped by the reader.
    ///
    /// <para>
    /// The rule itself moved to <see cref="CsvCell"/> when the third export was written. It
    /// stays reachable under this name because this file's own tests and its column builders
    /// read as one piece; what must not happen is a second export re-deriving the rule and
    /// getting the ORDER wrong, which is invisible until somebody's spreadsheet runs a formula
    /// out of a member's name field.
    /// </para>
    /// </summary>
    /// <remarks>
    /// Public because the monitoring export needs exactly this rule and a second copy of it is
    /// a second place for it to be got wrong. It is the club's own strings that are dangerous
    /// here — a board's name, a fault's detail — and the two exports must defuse them
    /// identically or one of them is a file that executes.
    /// </remarks>
    public static string Cell(string value) => CsvCell.Of(value);

    /// <summary>
    /// The name this row's subject is known by, or empty. Block body for the lizard reason in
    /// <c>memory/gotchas.md</c>.
    /// </summary>
    private static string MemberName(Guid? subjectUserId, IReadOnlyDictionary<Guid, string> names)
    {
        if (subjectUserId is not { } id || id == Guid.Empty) return "";
        return names.TryGetValue(id, out var name) ? name : "";
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

}

/// <summary>
/// The three things a log row says about its door. Top-level and bodyless for the lizard reason
/// recorded in <c>memory/gotchas.md</c>.
/// </summary>
public sealed record DoorRef(Guid Id, string Name, string? GateKey);

/// <summary>
/// The zone the export's two readable columns are written in, and its name for the file to
/// carry. One value rather than two arguments, because they are one fact and a row builder with
/// eight parameters is past what the complexity gate allows — see <c>memory/gotchas.md</c>.
/// </summary>
public sealed record CsvClock(TimeZoneInfo Zone, string Timezone);
