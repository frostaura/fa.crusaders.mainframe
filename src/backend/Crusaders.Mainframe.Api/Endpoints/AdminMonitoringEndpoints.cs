using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The IoT monitoring surface — GOAL item 7's admin half. One list, one export, one summary,
/// two resolves and one stream.
///
/// <para>
/// <b>An empty list is the most dangerous answer this surface can give</b>, and every decision
/// in this file follows from that. The sentence a volunteer admin takes away from an empty
/// monitoring page is "the club's hardware is healthy" — so a code this server has never heard
/// of is REFUSED rather than answered with nothing (<see cref="DeviceErrorQuery.CodeInvalid"/>),
/// a filter that matches nothing is still a whole envelope carrying a zero, and the numbers
/// above the rows are the RANGE's rather than the page's, because those are the numbers
/// somebody quotes.
/// </para>
///
/// <para>
/// <b>It reads and it resolves; it does not act on the estate.</b> There is no "restart this
/// board" button here, for <see cref="AdminControlBoardEndpoints"/>'s reason: the boards are
/// pull-only, the relay client is not in the container, and adding an actuation control to a
/// read model is how a monitoring page becomes a way to darken a court somebody is playing on.
/// </para>
/// </summary>
public static class AdminMonitoringEndpoints
{
    /// <summary>The audit action a resolve writes. Not a door action — see <see cref="DeviceErrorCodes"/>.</summary>
    public const string ResolvedAction = "monitoring.error_resolved";

    /// <summary>The audit action an export writes.</summary>
    public const string ExportedAction = "monitoring.log_exported";

    /// <summary>
    /// Most ids one bulk resolve may name.
    ///
    /// <para>
    /// A hundred, matching <c>admin_bulk_max_items</c>'s default on the booking side, because an
    /// admin ticking checkboxes is doing the same thing on both surfaces and two different
    /// ceilings is one an admin discovers by hitting it. The refusal carries the number, so a
    /// console can say what the limit is rather than guessing.
    /// </para>
    /// </summary>
    public const int MaxBulkIds = 100;

    /// <summary>The refusal when a bulk resolve names more than <see cref="MaxBulkIds"/> ids.</summary>
    public const string TooManyIds = "too_many_ids";

    /// <summary>The refusal when a bulk resolve names none.</summary>
    public const string NoIds = "no_ids";

    /// <summary>
    /// The refusal when one bulk resolve names the same error twice. Refused rather than
    /// silently collapsed, which is §5.5's rule on the booking side and its argument: a list
    /// that names one row twice is a console bug, and answering it twice hides it.
    /// </summary>
    public const string DuplicateId = "duplicate_id";

    /// <summary>The refusal when the id is not a fault this club has.</summary>
    public const string ErrorNotFound = "error_not_found";

    /// <summary>The refusal when the fault is already resolved. A conflict, not a not-found: the row is there and an admin can see who closed it.</summary>
    public const string AlreadyResolved = "already_resolved";

    /// <summary>The per-item status of a resolve inside a bulk call.</summary>
    public const string ResolvedStatus = "resolved";

    /// <inheritdoc cref="ResolvedStatus"/>
    public const string FailedStatus = "failed";

    /// <summary>
    /// The export's columns, in order. A pinned constant because a CSV is a contract with a
    /// spreadsheet and with the console's own copy, and a header row assembled inline is a
    /// contract nothing can assert against — <see cref="AdminDoorLogEndpoint.Header"/>'s rule.
    /// </summary>
    public const string Header =
        "first_seen_date,first_seen_time,timezone,first_seen_utc,last_seen_utc,device_code," +
        "device_name,device_kind,source,code,severity,headline,detail,court,count," +
        "resolved_utc,resolved_by,resolution_note";

    public static IEndpointRouteBuilder MapAdminMonitoringEndpoints(this IEndpointRouteBuilder app)
    {
        // Full paths on the root builder rather than a group with a "/" child, for
        // AdminControlBoardEndpoints' reason: a group's root child maps the TRAILING-SLASH form
        // only. The two ticket/stream routes below then read beside the others rather than in a
        // second registration block.
        var admin = app.MapGroup("/api/v1/admin/monitoring")
            .RequireAuthorization(p => p.RequireRole("admin"));

        // Declared before "/errors" so the literal wins, and in the order a console uses them.
        admin.MapGet("/errors.csv", CsvAsync);
        admin.MapGet("/errors", ListAsync);
        admin.MapGet("/summary", SummaryAsync);
        admin.MapPost("/errors/{id:guid}/resolve", ResolveAsync);
        admin.MapPost("/errors/resolve-bulk", ResolveBulkAsync);

        app.MapPost("/api/v1/admin/monitoring/stream-ticket", MintTicket)
            .RequireAuthorization(p => p.RequireRole("admin"));

        // The stream is NOT on the admin group: its credential is the purpose-scoped ticket in
        // the query string, which EventSource cannot send as a header — so the role policy
        // cannot be what admits it. The purpose is the authorisation, Program.cs accepts that
        // purpose on this path and no other, and the handler still checks the role.
        app.MapGet("/api/v1/admin/monitoring/stream", StreamAsync).RequireAuthorization();

        return app;
    }

    // ---- the list --------------------------------------------------------------------

    /// <summary>
    /// <c>GET /api/v1/admin/monitoring/errors</c> — one page of what is wrong with the club's
    /// estate.
    /// </summary>
    private static async Task<IResult> ListAsync(
        HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct)
    {
        var settings = await settingsAccessor.GetAsync(ct);
        var (query, error) = DeviceErrorQuery.Parse(ctx.Request, settings, DateTimeOffset.UtcNow);
        if (error is not null || query is null) return Results.BadRequest(new { error });

        // One row more than asked for, which is how "is there a next page" is answered without
        // a second count over the keyset.
        var rows = await query.Apply(db).Take(query.Limit + 1).ToListAsync(ct);
        var page = rows.Take(query.Limit).ToList();
        var lookups = await MonitoringLookups.ForAsync(db, page, ct);

        // Counted over the FILTERED RANGE and never over the page (A6 / E-M2): a heading saying
        // "2 open faults" above a page of two drawn from a range holding five is the number an
        // admin quotes in a committee meeting. The counts are a breakdown of the same set, so
        // the chips and the heading above them cannot disagree.
        var filtered = query.Filtered(db);
        var counts = await CountsAsync(filtered, ct);

        return Results.Ok(new
        {
            rows = page.Select(r => MonitoringErrorRow.Of(r, lookups)).ToList(),
            total = await filtered.CountAsync(ct),
            cursor = rows.Count > query.Limit && page.Count > 0
                ? new DoorLogCursor(page[^1].LastSeenAt, page[^1].Id).Encode()
                : null,

            // The club's own numbers, so the page states the retention it actually has and
            // renders instants in the club's zone rather than the reader's.
            retention_days = query.RetentionDays,
            timezone = query.Timezone,
            range = new { from = query.From, to = query.To },
            counts = Counts(counts),
        });
    }

    /// <summary>
    /// How many rows of each severity a set holds, grouped in the database rather than counted
    /// four times. Block body for the lizard reason in <c>memory/gotchas.md</c> — the <c>{</c>
    /// of the projection's initialiser ends the function as far as its C# parser is concerned.
    /// </summary>
    private static async Task<Dictionary<DeviceErrorSeverity, int>> CountsAsync(
        IQueryable<DeviceError> rows, CancellationToken ct)
    {
        return await rows.GroupBy(e => e.Severity).Select(g => new { Severity = g.Key, Count = g.Count() })
            .ToDictionaryAsync(g => g.Severity, g => g.Count, ct);
    }

    /// <summary>
    /// The four severities, always all four and always present.
    ///
    /// <para>
    /// An absent key is not a zero on a wire: a page reading <c>counts.critical</c> and finding
    /// nothing there cannot tell "none" from "this server did not say", and on this surface
    /// those are the two sentences that must never be confused.
    /// </para>
    /// </summary>
    private static object Counts(IReadOnlyDictionary<DeviceErrorSeverity, int> counts)
    {
        return new
        {
            critical = counts.GetValueOrDefault(DeviceErrorSeverity.Critical),
            error = counts.GetValueOrDefault(DeviceErrorSeverity.Error),
            warning = counts.GetValueOrDefault(DeviceErrorSeverity.Warning),
            info = counts.GetValueOrDefault(DeviceErrorSeverity.Info),
        };
    }

    // ---- the export ------------------------------------------------------------------

    /// <summary>
    /// <c>GET /api/v1/admin/monitoring/errors.csv</c> — the same filters, as a file.
    ///
    /// <para>
    /// <b>Every cell is defused before it is written</b>, through the door export's own helper
    /// rather than a second copy of the rule: a board's name and a fault's detail are strings a
    /// club and a firmware author chose, and a cell beginning <c>=</c>, <c>+</c>, <c>-</c> or
    /// <c>@</c> is a formula in a spreadsheet. The value is kept intact and prefixed, so the log
    /// is still readable and cannot execute.
    /// </para>
    /// </summary>
    private static async Task<IResult> CsvAsync(
        HttpContext ctx, [AsParameters] MonitoringExportServices services, CancellationToken ct)
    {
        var (db, tenant, settingsAccessor) = services;
        var settings = await settingsAccessor.GetAsync(ct);
        var (query, error) = DeviceErrorQuery.Parse(ctx.Request, settings, DateTimeOffset.UtcNow);

        // Refused BEFORE a file is built and before the export audit row is written: a zero-row
        // CSV under the ordinary filename is the worst of the three answers, because it is
        // forwarded and filed as evidence that nothing is wrong.
        if (error is not null || query is null) return Results.BadRequest(new { error });

        var rows = await query.Apply(db).Take(AdminDoorLogEndpoint.MaxExportRows + 1).ToListAsync(ct);
        var truncated = rows.Count > AdminDoorLogEndpoint.MaxExportRows;
        var exported = rows.Take(AdminDoorLogEndpoint.MaxExportRows).ToList();
        var lookups = await MonitoringLookups.ForAsync(db, exported, ct);

        var clock = new CsvClock(query.Zone, query.Timezone);
        var csv = new StringBuilder(Header).Append("\r\n");
        foreach (var row in exported) csv.Append(Line(row, lookups, clock));

        // The export is a thing that happened to a club's own records, so the trail says who
        // did it, what they asked for and how much came back.
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = tenant.TenantId,
            ActorUserId = ctx.User.Id() ?? Guid.Empty,
            SubjectUserId = null,
            Action = ExportedAction,
            DetailsJson = JsonSerializer.Serialize(new
            {
                device = query.Device,
                severity = query.Severity?.ToString(),
                code = query.Code,
                state = query.State.ToString(),
                from = query.From,
                to = query.To,
                rows = exported.Count,
                truncated,
            }),
        });
        await db.SaveChangesAsync(ct);

        if (truncated) ctx.Response.Headers[AdminDoorLogEndpoint.TruncatedHeader] = "true";

        // The real count, so the page announces the FILE rather than its own page size (B3).
        // Both headers are already named in the CORS policy's exposed list, or a browser would
        // never see them.
        ctx.Response.Headers[AdminDoorLogEndpoint.RowsHeader] =
            exported.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);

        // A UTF-8 BOM, because Excel reads a BOM-less UTF-8 file in the machine's legacy code
        // page and a club whose board is named "Café" gets mojibake on a printed report.
        var bytes = Encoding.UTF8.GetPreamble()
            .Concat(Encoding.UTF8.GetBytes(csv.ToString())).ToArray();

        ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{FileName(query)}\"";
        return Results.File(bytes, "text/csv; charset=utf-8");
    }

    /// <summary>
    /// What the file is called: the exact range it holds, in the club's own zone — A4's rule,
    /// because a file is forwarded, printed and filed under its name. Block body for the lizard
    /// reason in <c>memory/gotchas.md</c>.
    /// </summary>
    public static string FileName(DeviceErrorQuery query)
    {
        var wholeDays = DoorClock.IsStartOfLocalDay(query.Zone, query.From)
                        && DoorClock.IsStartOfLocalDay(query.Zone, query.To);
        var format = wholeDays ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HHmm";
        var invariant = System.Globalization.CultureInfo.InvariantCulture;

        var from = TimeZoneInfo.ConvertTime(query.From, query.Zone).ToString(format, invariant);
        var to = TimeZoneInfo.ConvertTime(query.To, query.Zone).ToString(format, invariant);
        return $"device-errors-{from}-to-{to}.csv";
    }

    /// <summary>
    /// One row of the file, spreadsheet-first: the club's own date and time, the zone they are
    /// in, and the UTC instants beside them for anybody reconciling against another system.
    /// Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </summary>
    private static string Line(DeviceError row, MonitoringLookups lookups, CsvClock clock)
    {
        var device = lookups.DeviceOf(row);
        var local = TimeZoneInfo.ConvertTime(row.FirstSeenAt, clock.Zone);
        var invariant = System.Globalization.CultureInfo.InvariantCulture;

        var cells = new[]
        {
            local.ToString("yyyy-MM-dd", invariant),
            local.ToString("HH:mm:ss", invariant),
            clock.Timezone,
            Utc(row.FirstSeenAt),
            Utc(row.LastSeenAt),

            device?.DeviceCode ?? row.ClaimedDeviceCode ?? "",
            device?.Name ?? "",
            device is null ? "" : DeviceKinds.Wire(device.Kind),
            DeviceErrorService.SourceWire(row.Source),
            row.Code,
            DeviceErrorService.SeverityWire(row.Severity),

            // The sentence beside the machine value: a club filtering a spreadsheet wants the
            // stable one and a club reading it wants the words.
            DeviceErrorCodes.HeadlineOf(row.Code),
            row.Detail ?? "",
            row.Court?.ToString(invariant) ?? "",
            row.Count.ToString(invariant),

            row.ResolvedAt is { } at ? Utc(at) : "",
            lookups.ResolverOf(row) ?? "",
            row.ResolutionNote ?? "",
        };
        return string.Join(",", cells.Select(AdminDoorLogEndpoint.Cell)) + "\r\n";
    }

    private static string Utc(DateTimeOffset at)
        => at.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture);

    // ---- the summary -----------------------------------------------------------------

    /// <summary>
    /// <c>GET /api/v1/admin/monitoring/summary</c> — the estate in one read. See
    /// <see cref="MonitoringSummaryView"/> for why its counts are not the list's.
    /// </summary>
    private static async Task<IResult> SummaryAsync(
        MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct)
    {
        var settings = await settingsAccessor.GetAsync(ct);
        return Results.Ok(await MonitoringSummaryView.BuildAsync(db, settings, DateTimeOffset.UtcNow, ct));
    }

    // ---- resolving -------------------------------------------------------------------

    /// <summary>
    /// <c>POST /api/v1/admin/monitoring/errors/{id}/resolve</c> — an admin says this one is
    /// dealt with.
    ///
    /// <para>
    /// <b>Three answers, and the two refusals are deliberately different.</b> A fault this club
    /// does not have is <c>404 error_not_found</c> — including another club's, which the global
    /// query filter makes structural rather than a comparison here. A fault somebody else
    /// already closed is <c>409 already_resolved</c>, because the row is there, an admin can see
    /// who closed it, and answering "not found" for a row on their screen is how two admins in
    /// one club start distrusting the page.
    /// </para>
    /// </summary>
    private static async Task<IResult> ResolveAsync(
        HttpContext ctx, Guid id, ResolveRequest? body, [AsParameters] MonitoringResolveServices services,
        CancellationToken ct)
    {
        var (db, tenant, bus) = services;
        var row = await db.DeviceErrors.FirstOrDefaultAsync(e => e.Id == id, ct);
        if (row is null) return Results.NotFound(new { error = ErrorNotFound });
        if (row.ResolvedAt is not null) return Results.Conflict(new { error = AlreadyResolved });

        var actor = ctx.User.Id() ?? Guid.Empty;
        Close(db, tenant.TenantId, row, actor, body?.Note, DateTimeOffset.UtcNow);
        await db.SaveChangesAsync(ct);

        // Published AFTER the save, never after the mutation: a monitoring page that strikes a
        // row through and then has it come back on the next poll is a page an admin stops
        // trusting — which is D2-B07's argument, on the surface that shows it soonest.
        var lookups = await MonitoringLookups.ForAsync(db, [row], ct);
        PublishResolved(bus, tenant.TenantId, row, lookups.ResolverOf(row));

        return Results.Ok(MonitoringErrorRow.Of(row, lookups));
    }

    /// <summary>
    /// <c>POST /api/v1/admin/monitoring/errors/resolve-bulk</c> — an admin ticked a list.
    ///
    /// <para>
    /// <b>Per-item, never all-or-nothing</b>, and <c>200</c> with a result array rather than a
    /// status code — D2 §5.1's rule, for its reasons: an id that is already resolved is normal
    /// traffic rather than an error, the honest answer to a list of checkboxes is a list of
    /// outcomes, and a console rendering this as a spinner ending in a toast cannot say "eleven
    /// resolved, one somebody else had already closed".
    /// </para>
    /// </summary>
    private static async Task<IResult> ResolveBulkAsync(
        HttpContext ctx, ResolveBulkRequest? body, [AsParameters] MonitoringResolveServices services,
        CancellationToken ct)
    {
        var ids = body?.Ids ?? [];
        if (ids.Count == 0) return Results.BadRequest(new { error = NoIds });
        if (ids.Count > MaxBulkIds) return Results.BadRequest(new { error = TooManyIds, max_ids = MaxBulkIds });

        var duplicate = ids.GroupBy(i => i).FirstOrDefault(g => g.Count() > 1);
        if (duplicate is not null) return Results.BadRequest(new { error = DuplicateId, id = duplicate.Key });

        var (db, tenant, bus) = services;
        var actor = ctx.User.Id() ?? Guid.Empty;
        var now = DateTimeOffset.UtcNow;

        // One read for the whole batch — tenant-filtered, so a foreign id simply is not here and
        // answers error_not_found without this method ever comparing a tenant.
        var found = await db.DeviceErrors.Where(e => ids.Contains(e.Id)).ToDictionaryAsync(e => e.Id, e => e, ct);

        var results = new List<object>();
        var resolved = new List<DeviceError>();
        foreach (var id in ids)
        {
            results.Add(await ResolveOneAsync(db, tenant, found, resolved, new BulkItem(id, actor, body?.Note, now), ct));
        }

        // Published after every save, and one frame per row: a page counting open faults has to
        // decrement once per fault, and a single "some of them changed" frame would leave it
        // re-fetching to find out which.
        var names = await MonitoringLookups.ForAsync(db, resolved, ct);
        foreach (var row in resolved) PublishResolved(bus, tenant.TenantId, row, names.ResolverOf(row));

        var succeeded = resolved.Count;
        return Results.Ok(new
        {
            requested = ids.Count,
            succeeded,
            failed = ids.Count - succeeded,
            results,
        });
    }

    /// <summary>
    /// One item of a bulk resolve, saved on its own so that a failure is this row's rather than
    /// the batch's. Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </summary>
    private static async Task<object> ResolveOneAsync(
        MainframeDbContext db, ITenantContext tenant, IReadOnlyDictionary<Guid, DeviceError> found,
        List<DeviceError> resolved, BulkItem item, CancellationToken ct)
    {
        if (!found.TryGetValue(item.Id, out var row))
        {
            return new { id = item.Id, status = FailedStatus, error = ErrorNotFound };
        }

        if (row.ResolvedAt is not null)
        {
            return new { id = item.Id, status = AlreadyResolved, error = (string?)null };
        }

        try
        {
            Close(db, tenant.TenantId, row, item.Actor, item.Note, item.At);
            await db.SaveChangesAsync(ct);
            resolved.Add(row);
            return new { id = item.Id, status = ResolvedStatus, error = (string?)null };
        }
        catch (DbUpdateException)
        {
            // This row's problem, reported as this row's result. Anything else would make one
            // unlucky id cost an admin the other ninety-nine.
            return new { id = item.Id, status = FailedStatus, error = "resolve_failed" };
        }
    }

    /// <summary>
    /// Marks one row resolved and writes the audit row that says who did it.
    ///
    /// <para>
    /// The note is TRUNCATED to the column's bound rather than refused, and the STORED note is
    /// what the response carries back — so a console shows the admin exactly what was kept,
    /// rather than the longer thing they typed and a row that disagrees with it.
    /// </para>
    /// </summary>
    private static void Close(
        MainframeDbContext db, Guid tenantId, DeviceError row, Guid actor, string? note, DateTimeOffset at)
    {
        row.ResolvedAt = at;
        row.ResolvedByUserId = actor == Guid.Empty ? null : actor;
        row.ResolutionNote = Trim(note);

        db.AuditLogs.Add(new AuditLog
        {
            TenantId = tenantId,
            ActorUserId = actor,
            SubjectUserId = null,
            Action = ResolvedAction,
            DetailsJson = JsonSerializer.Serialize(new
            {
                error_id = row.Id,
                device_id = row.DeviceId,
                code = row.Code,
                severity = DeviceErrorService.SeverityWire(row.Severity),
                count = row.Count,
                note = row.ResolutionNote,
            }),
        });
    }

    private static string? Trim(string? note)
    {
        if (string.IsNullOrWhiteSpace(note)) return null;
        var trimmed = note.Trim();
        return trimmed.Length > DeviceError.MaxDetailLength
            ? trimmed[..DeviceError.MaxDetailLength]
            : trimmed;
    }

    private static void PublishResolved(IRealtimeBus bus, Guid tenantId, DeviceError row, string? name)
    {
        var payload = JsonSerializer.Serialize(new
        {
            id = row.Id,
            device_id = row.DeviceId,
            resolved_by_name = name,
            at = row.ResolvedAt,
        });
        bus.Publish(RealtimeTopic.Monitoring(tenantId), new RealtimeMessage("error_resolved", payload));
    }

    // ---- the stream ------------------------------------------------------------------

    /// <summary>
    /// Mints the one-minute, purpose-scoped credential the stream is opened with. Minted by a
    /// POST so it never reaches an access log — see <see cref="TokenPurposes.WalletStream"/>.
    ///
    /// <para>
    /// <b>The ticket carries the admin role, and it has to.</b> The role policy cannot be what
    /// admits a stream request — the credential is in the query string, because
    /// <c>EventSource</c> cannot set a header — so the role is checked inside
    /// <see cref="StreamAsync"/>, against this token. A roleless ticket makes that check fail
    /// for the admin who just minted it, which is a route that is 403 to its entire audience
    /// with nothing logged anywhere. The route itself is already admin-only, so the claim
    /// records what this caller was found to be rather than granting them anything.
    /// </para>
    /// </summary>
    private static IResult MintTicket(HttpContext ctx, IJwtIssuer jwt, ITenantContext tenant)
    {
        var userId = ctx.User.Id();
        if (userId is null) return Results.Unauthorized();

        var ticket = jwt.IssueOneTime(
            userId.Value, tenant.TenantId, tenant.TenantSlug,
            new TicketScope(TokenPurposes.MonitoringStream, TokenPurposes.WalletStreamTicketTtl), ["admin"], SessionEpochs.EpochOf(ctx.User));

        return Results.Ok(new
        {
            ticket,
            expires_in_seconds = (int)TokenPurposes.WalletStreamTicketTtl.TotalSeconds,
        });
    }

    /// <summary>
    /// <c>GET /api/v1/admin/monitoring/stream?ticket=</c> — the live fault feed.
    ///
    /// <para>
    /// <b>The opening frame is <c>counts</c> and not a full list</b>, and the difference is the
    /// point: a monitoring page's headline number must be right the instant the stream opens,
    /// and the rows behind it are already on the page from the paired <c>GET</c>. Sending the
    /// whole list again would make every reconnect — which <c>EventSource</c> performs on its
    /// own, repeatedly, through a flaky tunnel — re-send a club's entire fault log.
    /// </para>
    ///
    /// <para>
    /// <c>error_opened</c> frames come from <see cref="DeviceErrorService"/> as faults arrive;
    /// <c>error_resolved</c> is published here.
    /// </para>
    /// </summary>
    private static async Task StreamAsync(
        HttpContext ctx, [AsParameters] MonitoringStreamServices services, CancellationToken ct)
    {
        // The ticket proves its purpose and the purpose is accepted on this path only — but the
        // ROLE still has to hold. A member who somehow obtained a monitoring ticket must not be
        // able to watch the club's estate with it.
        if (!ctx.User.IsInRole("admin")) { ctx.Response.StatusCode = 403; return; }

        var (db, bus, tenant, settingsAccessor) = services;
        var settings = await settingsAccessor.GetAsync(ct);
        var topic = RealtimeTopic.Monitoring(tenant.TenantId);

        // The role is re-asked before every frame, not only here: a demoted admin's open stream
        // must stop, not run until the connection drops. See SseStream.RunAsync's guard.
        await SseStream.RunAsync(
            ctx, bus, topic, AdminStreamGuard.For(ctx, RealtimeSettings.KeepAlive(settings)),
            async () => await SseStream.WriteEventAsync(ctx, await OpeningCountsAsync(db, ct), ct),
            ct);
    }

    /// <summary>The club's open faults by severity, as the stream's opening frame.</summary>
    private static async Task<RealtimeMessage> OpeningCountsAsync(MainframeDbContext db, CancellationToken ct)
    {
        var counts = await CountsAsync(db.DeviceErrors.AsNoTracking().Where(e => e.ResolvedAt == null), ct);
        return new RealtimeMessage("counts", JsonSerializer.Serialize(Counts(counts)));
    }
}

/// <summary>What one resolve was given. The note is optional: a fault an admin simply attended to needs no sentence.</summary>
public sealed record ResolveRequest(string? Note);

/// <summary>What one bulk resolve was given.</summary>
public sealed record ResolveBulkRequest(List<Guid>? Ids, string? Note)
{
    /// <summary>The ids, never null — an absent list and an empty one are the same refusal.</summary>
    public List<Guid> Ids { get; init; } = Ids ?? [];
}

/// <summary>
/// One item of a bulk resolve, bundled — the same reason as <c>ControlBoardStreamServices</c>:
/// the complexity gate bounds a parameter list at six, on a count that says nothing about how
/// hard the method is to reason about.
/// </summary>
public sealed record BulkItem(Guid Id, Guid Actor, string? Note, DateTimeOffset At);

/// <summary>What the export handler needs, bundled. See <c>ControlBoardStreamServices</c>.</summary>
public sealed record MonitoringExportServices(
    MainframeDbContext Db, ITenantContext Tenant, TenantSettingsAccessor Settings);

/// <summary>What the two resolve handlers need, bundled. See <c>ControlBoardStreamServices</c>.</summary>
public sealed record MonitoringResolveServices(
    MainframeDbContext Db, ITenantContext Tenant, IRealtimeBus Bus);

/// <summary>
/// What the stream handler needs, bundled.
///
/// <para>
/// No <c>IServiceScopeFactory</c> here, unlike the control board's: this stream has no resync
/// loop, so nothing outlives the request's own scope. The opening read happens before the first
/// await on the channel, while the request's <c>DbContext</c> is still alive.
/// </para>
/// </summary>
public sealed record MonitoringStreamServices(
    MainframeDbContext Db, IRealtimeBus Bus, ITenantContext Tenant, TenantSettingsAccessor Settings);
