using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>One date of a schedule, skipped or re-timed.</summary>
public sealed record ScheduleOccurrenceRequest(
    bool Skip = false, string? Start = null, string? End = null, string? Reason = null);

/// <summary>Ending a series. <c>effectiveFrom</c> is clamped to never be earlier than the club's today.</summary>
public sealed record ScheduleEndRequest(DateOnly? EffectiveFrom = null, string? Reason = null);

/// <summary>A this-and-future edit.</summary>
public sealed record ScheduleUpdateRequest(
    string? Name, string? Label, IReadOnlyList<string>? Days, string? Start, string? End,
    DateOnly? StartDate, DateOnly? EndDate, short IntervalWeeks = 1,
    IReadOnlyList<Guid>? Courts = null, DateOnly? EffectiveFrom = null, string? Reason = null)
{
    public ScheduleRequest AsRequest()
        => new(Name, Label, Days, Start, End, StartDate, EndDate, IntervalWeeks, Courts);
}


/// <summary>
/// Everything a schedule handler resolves from the container, bound as one parameter.
///
/// <para>
/// <b>Not tidiness — the complexity gate caps a signature at six arguments</b>
/// (<c>lizard -a 6</c> in the Makefile), and a schedule write genuinely needs the context, the
/// settings, the service, the recorder and the tenant alongside its request body and its
/// cancellation token. <c>[AsParameters]</c> is the framework's own answer to that, and it
/// keeps the alternative — resolving services out of <c>HttpContext.RequestServices</c> by
/// hand — out of the handlers, where it would hide the dependencies from the DI graph.
/// </para>
/// </summary>
public sealed record ScheduleDeps(
    MainframeDbContext Db,
    TenantSettingsAccessor Settings,
    BookingScheduleService Schedules,
    AdminChangeRecorder Recorder,
    ITenantContext Tenant);

/// <summary>
/// GOAL item 14's wire — "schedule bookings over a calendar… for example league matches or
/// practice. Repeating schedule support. Verification of no overlap… Past remains unchanged".
///
/// <para>
/// <b>There is no delete, and that is the design rather than an omission.</b> A schedule that
/// ran is history; ending it is the operation, and the past occurrences it produced are facts a
/// club may be asked about. Every mutation here writes one row into the change record nobody
/// can delete from.
/// </para>
/// </summary>
public static class AdminScheduleEndpoints
{
    public static IEndpointRouteBuilder MapAdminScheduleEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/schedules").RequireAuthorization(p => p.RequireRole("admin"));

        g.MapGet("/", ListAsync);
        g.MapGet("/{id:guid}", GetAsync);
        g.MapGet("/{id:guid}/occurrences", OccurrencesAsync);
        g.MapGet("/{id:guid}/changes", AdminChangeEndpoints.ForScheduleAsync);
        g.MapPost("/preview", PreviewAsync);
        g.MapPost("/", CreateAsync);
        g.MapPatch("/{id:guid}", UpdateAsync);
        g.MapPatch("/{id:guid}/occurrences/{date}", OccurrenceAsync);
        g.MapPost("/{id:guid}/end", EndAsync);

        return app;
    }

    // ------------------------------------------------------------------ reads

    private static async Task<IResult> ListAsync(
        string? status, [AsParameters] ScheduleDeps deps, CancellationToken ct)
    {
        var (db, settings) = (deps.Db, deps.Settings);
        var view = await settings.GetAsync(ct);
        var (zone, timezone, _) = DoorClock.ZoneOf(view);

        var wanted = status?.Trim().ToLowerInvariant() ?? "active";
        var query = db.BookingSchedules.AsNoTracking();
        query = wanted switch
        {
            "ended" => query.Where(s => s.Status == ScheduleStatus.Ended),
            "all" => query,
            _ => query.Where(s => s.Status == ScheduleStatus.Active),
        };

        var rows = await query.OrderBy(s => s.Name).ToListAsync(ct);
        var courts = await CourtsByScheduleAsync(db, rows.Select(r => r.Id).ToList(), ct);
        var names = await PersonNames.ForAsync(db, rows.Select(r => (Guid?)r.CreatedByUserId), ct);

        return Results.Ok(new
        {
            schedules = rows.Select(s => Project(s, courts, names, zone)).ToList(),
            timezone,
        });
    }

    private static async Task<IResult> GetAsync(
        Guid id, [AsParameters] ScheduleDeps deps, CancellationToken ct)
    {
        var (db, settings) = (deps.Db, deps.Settings);
        var view = await settings.GetAsync(ct);
        var (zone, timezone, _) = DoorClock.ZoneOf(view);

        var row = await db.BookingSchedules.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, ct);
        if (row is null) return Results.NotFound(new { error = ScheduleRequestParsing.NotFound });

        var courts = await CourtsByScheduleAsync(db, [id], ct);
        var names = await PersonNames.ForAsync(db, [row.CreatedByUserId], ct);

        return Results.Ok(new { schedule = Project(row, courts, names, zone), timezone });
    }

    /// <summary>
    /// The dates one schedule falls on, each with what it is and which rows hold it.
    ///
    /// <para>
    /// A date whose start has passed reads <c>past</c> and is immutable — the occurrence route
    /// refuses to touch it. That is the same fact the materialiser enforces with
    /// <c>StartsAt &gt; now</c>, said on the wire so a calendar can draw it as unchangeable
    /// rather than offering a control that will be refused.
    /// </para>
    /// </summary>
    private static async Task<IResult> OccurrencesAsync(
        Guid id, DateOnly? from, DateOnly? to, [AsParameters] ScheduleDeps deps, CancellationToken ct)
    {
        var (db, settings) = (deps.Db, deps.Settings);
        var view = await settings.GetAsync(ct);
        var (zone, timezone, _) = DoorClock.ZoneOf(view);
        var now = DateTimeOffset.UtcNow;

        var schedule = await db.BookingSchedules.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, ct);
        if (schedule is null) return Results.NotFound(new { error = ScheduleRequestParsing.NotFound });

        var today = ScheduleClock.Today(zone, now);
        var windowFrom = from ?? schedule.StartDate;
        var windowTo = to ?? today.AddDays(ScheduleSettings.EffectiveHorizonDays(view));

        var exceptions = await db.BookingScheduleExceptions.AsNoTracking()
            .Where(x => x.ScheduleId == id).ToListAsync(ct);

        var rows = await db.Bookings.AsNoTracking()
            .Where(b => b.ScheduleId == id && b.Status != BookingStatus.Cancelled)
            .Select(b => new { b.Id, b.CourtId, b.ScheduleOccurrenceDate })
            .ToListAsync(ct);
        var courtNames = await db.Courts.AsNoTracking().ToDictionaryAsync(c => c.Id, c => c.Name, ct);

        var occurrences = ScheduleOccurrences
            .Expand(schedule, exceptions, zone, windowFrom, windowTo)
            .Select(o => new
            {
                date = o.Date,
                starts_at = o.StartsAt,
                ends_at = o.EndsAt,
                status = o.StartsAt <= now ? "past" : o.Status switch
                {
                    ScheduleOccurrenceStatus.Skipped => "skipped",
                    ScheduleOccurrenceStatus.Overridden => "overridden",
                    _ => "scheduled",
                },
                courts = rows.Where(r => r.ScheduleOccurrenceDate == o.Date).Select(r => new
                {
                    court_id = r.CourtId,
                    court_name = courtNames.GetValueOrDefault(r.CourtId),
                    booking_id = r.Id,
                }).ToList(),
            })
            .ToList();

        return Results.Ok(new { occurrences, timezone });
    }

    // ------------------------------------------------------------------ writes

    private static async Task<IResult> PreviewAsync(
        ScheduleRequest req, HttpContext ctx, [AsParameters] ScheduleDeps deps, CancellationToken ct)
    {
        var (db, settings, schedules) = (deps.Db, deps.Settings, deps.Schedules);
        var view = await settings.GetAsync(ct);
        var (spec, refusal) = ScheduleRequestParsing.Parse(req, view);
        if (refusal is not null) return refusal;

        if (await ScheduleRequestParsing.RefuseAgainstTheClubAsync(spec!, null, db, ct) is { } bad) return bad;

        var preview = await schedules.PreviewAsync(spec!, null, ctx.User.Id() ?? Guid.Empty, ct);
        return Results.Ok(ProjectPreview(preview, view));
    }

    private static async Task<IResult> CreateAsync(
        ScheduleRequest req, HttpContext ctx, [AsParameters] ScheduleDeps deps, CancellationToken ct)
    {
        var (db, settings, schedules, recorder) = (deps.Db, deps.Settings, deps.Schedules, deps.Recorder);
        var view = await settings.GetAsync(ct);
        var (spec, refusal) = ScheduleRequestParsing.Parse(req, view);
        if (refusal is not null) return refusal;
        if (await ScheduleRequestParsing.RefuseAgainstTheClubAsync(spec!, null, db, ct) is { } bad) return bad;

        var actorId = ctx.User.Id() ?? Guid.Empty;
        var preview = await schedules.PreviewAsync(spec!, null, actorId, ct);

        if (TooLargeOrConflicting(preview, view) is { } stop) return stop;

        var row = BookingScheduleService.ToRow(spec!, actorId);
        row.TenantId = deps.Tenant.TenantId;
        db.BookingSchedules.Add(row);
        foreach (var courtId in spec!.CourtIds)
        {
            db.BookingScheduleCourts.Add(new BookingScheduleCourt
            {
                TenantId = row.TenantId,
                ScheduleId = row.Id,
                CourtId = courtId,
            });
        }

        await recorder.StageAsync(new AdminChange(
            Action: AdminChangeActions.ScheduleCreated,
            ActorUserId: actorId,
            SubjectKind: AdminChangeSubjects.Schedule,
            SubjectId: row.Id,
            SubjectLabel: row.Name,
            After: Snapshot(spec)), ct);
        await db.SaveChangesAsync(ct);

        // Materialised synchronously as well as by the worker, so the admin sees the result of
        // their own click rather than a calendar that fills in up to fifteen minutes later.
        var outcome = await schedules.MaterialiseAsync(row, ct);

        var courts = await CourtsByScheduleAsync(db, [row.Id], ct);
        var names = await PersonNames.ForAsync(db, [actorId], ct);
        var (zone, _, _) = DoorClock.ZoneOf(view);

        return Results.Created($"/api/v1/admin/schedules/{row.Id}", new
        {
            schedule = Project(row, courts, names, zone),
            rows_created = outcome.RowsWritten,
        });
    }

    /// <summary>
    /// This-and-future. The rule changes, every UNSTARTED occurrence is lifted, and the series
    /// is written again from <c>effective_from</c>.
    ///
    /// <para>
    /// <b><c>effective_from</c> in the past is CLAMPED, not refused.</b> An admin typing last
    /// Tuesday means "from now on", and the response says <c>effective_from_clamped_to</c> so
    /// the screen can say so rather than silently doing something else.
    /// </para>
    /// </summary>
    private static async Task<IResult> UpdateAsync(
        Guid id, ScheduleUpdateRequest req, HttpContext ctx, [AsParameters] ScheduleDeps deps,
        CancellationToken ct)
    {
        var (db, settings, schedules, recorder) = (deps.Db, deps.Settings, deps.Schedules, deps.Recorder);
        var view = await settings.GetAsync(ct);
        var (zone, _, _) = DoorClock.ZoneOf(view);

        var row = await db.BookingSchedules.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (row is null) return Results.NotFound(new { error = ScheduleRequestParsing.NotFound });

        var (spec, refusal) = ScheduleRequestParsing.Parse(req.AsRequest(), view);
        if (refusal is not null) return refusal;
        if (await ScheduleRequestParsing.RefuseAgainstTheClubAsync(spec!, id, db, ct) is { } bad) return bad;

        var actorId = ctx.User.Id() ?? Guid.Empty;
        var preview = await schedules.PreviewAsync(spec!, id, actorId, ct);
        if (TooLargeOrConflicting(preview, view) is { } stop) return stop;

        var today = ScheduleClock.Today(zone, DateTimeOffset.UtcNow);
        var asked = req.EffectiveFrom ?? today;
        var effective = asked < today ? today : asked;

        var before = Snapshot(new ScheduleSpec(
            row.Name, row.Label, row.DaysOfWeek, row.StartMinute, row.EndMinute,
            row.StartDate, row.EndDate, row.IntervalWeeks,
            await db.BookingScheduleCourts.AsNoTracking()
                .Where(c => c.ScheduleId == id).Select(c => c.CourtId).ToListAsync(ct)));

        await schedules.CancelFutureAsync(id, ScheduleClock.InstantAt(zone, effective, 0), ct);

        Apply(row, spec!);
        await ReplaceCourtsAsync(db, row, spec!.CourtIds, ct);

        await recorder.StageAsync(new AdminChange(
            Action: AdminChangeActions.ScheduleUpdatedFuture,
            ActorUserId: actorId,
            SubjectKind: AdminChangeSubjects.Schedule,
            SubjectId: row.Id,
            SubjectLabel: row.Name,
            Reason: req.Reason?.Trim(),
            Before: before,
            After: Snapshot(spec)), ct);
        await db.SaveChangesAsync(ct);

        var outcome = await schedules.MaterialiseAsync(row, ct);

        var courts = await CourtsByScheduleAsync(db, [row.Id], ct);
        var names = await PersonNames.ForAsync(db, [actorId], ct);

        return Results.Ok(new
        {
            schedule = Project(row, courts, names, zone),
            rows_created = outcome.RowsWritten,
            effective_from = effective,
            effective_from_clamped_to = asked < today ? today : (DateOnly?)null,
        });
    }

    /// <summary>
    /// Only this occurrence — skipped, or re-timed.
    ///
    /// <para>
    /// A past date is <c>409 occurrence_in_past</c>. A date that was played, checked into, or
    /// that had a member's booking cancelled to make room for it is a fact, and a schedule edit
    /// must not rewrite the evidence.
    /// </para>
    /// </summary>
    private static async Task<IResult> OccurrenceAsync(
        Guid id, string date, ScheduleOccurrenceRequest req, HttpContext ctx,
        [AsParameters] ScheduleDeps deps, CancellationToken ct)
    {
        var (db, settings, schedules, recorder) = (deps.Db, deps.Settings, deps.Schedules, deps.Recorder);
        var view = await settings.GetAsync(ct);
        var (zone, _, _) = DoorClock.ZoneOf(view);

        if (!DateOnly.TryParseExact(date, "yyyy-MM-dd", null,
                System.Globalization.DateTimeStyles.None, out var occurrenceDate))
        {
            return Results.BadRequest(new { error = DoorPeriod.DayInvalid });
        }

        var row = await db.BookingSchedules.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (row is null) return Results.NotFound(new { error = ScheduleRequestParsing.NotFound });

        if (ScheduleClock.InstantAt(zone, occurrenceDate, row.StartMinute) <= DateTimeOffset.UtcNow)
        {
            return Results.Conflict(new
            {
                error = ScheduleRequestParsing.OccurrenceInPast,
                occurrence_date = occurrenceDate,
            });
        }

        var (start, end, timesBad) = OverrideTimes(req, row, view);
        if (timesBad is { } bad) return bad;

        var actorId = ctx.User.Id() ?? Guid.Empty;
        var existing = await db.BookingScheduleExceptions
            .FirstOrDefaultAsync(x => x.ScheduleId == id && x.OccurrenceDate == occurrenceDate, ct);

        var exception = existing ?? new BookingScheduleException
        {
            TenantId = row.TenantId,
            ScheduleId = id,
            OccurrenceDate = occurrenceDate,
            CreatedByUserId = actorId,
        };

        exception.Kind = req.Skip ? ScheduleExceptionKind.Skipped : ScheduleExceptionKind.Overridden;
        exception.StartMinute = req.Skip ? null : start;
        exception.EndMinute = req.Skip ? null : end;
        exception.Reason = req.Reason?.Trim();
        if (existing is null) db.BookingScheduleExceptions.Add(exception);

        await recorder.StageAsync(new AdminChange(
            Action: req.Skip
                ? AdminChangeActions.ScheduleOccurrenceSkipped
                : AdminChangeActions.ScheduleOccurrenceOverridden,
            ActorUserId: actorId,
            SubjectKind: AdminChangeSubjects.Schedule,
            SubjectId: id,
            SubjectLabel: row.Name,
            Reason: exception.Reason,
            After: req.Skip
                ? new { occurrence_date = occurrenceDate.ToString("yyyy-MM-dd") }
                : (object)new
                {
                    occurrence_date = occurrenceDate.ToString("yyyy-MM-dd"),
                    start_minute = start,
                    end_minute = end,
                }), ct);
        await db.SaveChangesAsync(ct);

        // The date's own rows go, then the series is written again — which re-creates this
        // date at the overridden times, or not at all if it was skipped.
        await schedules.CancelOccurrenceAsync(id, occurrenceDate, ct);
        var outcome = await schedules.MaterialiseAsync(row, ct);

        return Results.Ok(new
        {
            occurrence_date = occurrenceDate,
            status = req.Skip ? "skipped" : "overridden",
            rows_created = outcome.RowsWritten,
        });
    }

    private static async Task<IResult> EndAsync(
        Guid id, ScheduleEndRequest? req, HttpContext ctx, [AsParameters] ScheduleDeps deps,
        CancellationToken ct)
    {
        var (db, settings, schedules, recorder) = (deps.Db, deps.Settings, deps.Schedules, deps.Recorder);
        var view = await settings.GetAsync(ct);
        var (zone, _, _) = DoorClock.ZoneOf(view);

        var row = await db.BookingSchedules.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (row is null) return Results.NotFound(new { error = ScheduleRequestParsing.NotFound });

        var reason = req?.Reason?.Trim();
        if (string.IsNullOrEmpty(reason)) return Results.BadRequest(new { error = "reason_required" });

        var today = ScheduleClock.Today(zone, DateTimeOffset.UtcNow);
        var asked = req?.EffectiveFrom ?? today;
        var effective = asked < today ? today : asked;

        var cancelled = await schedules.CancelFutureAsync(id, ScheduleClock.InstantAt(zone, effective, 0), ct);

        row.Status = ScheduleStatus.Ended;
        // EndDate is the last date the series may produce, and `effective` is the first it may
        // not — so the stored end is the day before. A series ended "from today" still owns the
        // nights it already ran, which is what keeps the past readable.
        row.EndDate = effective.AddDays(-1);
        row.UpdatedAt = DateTimeOffset.UtcNow;

        await recorder.StageAsync(new AdminChange(
            Action: AdminChangeActions.ScheduleEnded,
            ActorUserId: ctx.User.Id() ?? Guid.Empty,
            SubjectKind: AdminChangeSubjects.Schedule,
            SubjectId: id,
            SubjectLabel: row.Name,
            Reason: reason,
            After: new { end_date = row.EndDate?.ToString("yyyy-MM-dd"), occurrences_cancelled = cancelled }), ct);
        await db.SaveChangesAsync(ct);

        return Results.Ok(new
        {
            status = "ended",
            end_date = row.EndDate,
            occurrences_cancelled = cancelled,
            effective_from = effective,
            effective_from_clamped_to = asked < today ? today : (DateOnly?)null,
        });
    }

    // ------------------------------------------------------------------ shared

    /// <summary>
    /// The two refusals a dry run can produce. <c>409</c> writes NOTHING.
    ///
    /// <para>
    /// The admin's path forward is to take the <c>booking_id</c>s out of the conflict list and
    /// POST them to <c>/api/v1/admin/bookings/bulk-cancel</c>, which refunds each one and emails
    /// each member, then retry. The conflict list is shaped to be pasted straight in — that is
    /// the only reason items 5 and 14 were designed together.
    /// </para>
    /// </summary>
    private static IResult? TooLargeOrConflicting(SchedulePreview preview, TenantSettingsView view)
    {
        var cap = ScheduleSettings.MaxRowsPerChange(view);
        if (preview.RowsToCreate > cap)
        {
            return Results.BadRequest(new
            {
                error = ScheduleRequestParsing.TooLarge,
                rows = preview.RowsToCreate,
                max_rows = cap,
            });
        }

        if (preview.Conflicts.Count > 0)
        {
            return Results.Conflict(new
            {
                error = ScheduleRequestParsing.Conflicts,
                occurrences = preview.Occurrences,
                conflicts = preview.Conflicts.Select(ProjectConflict).ToList(),
            });
        }

        return null;
    }

    private static (int? Start, int? End, IResult? Refusal) OverrideTimes(
        ScheduleOccurrenceRequest req, BookingSchedule row, TenantSettingsView view)
    {
        if (req.Skip) return (null, null, null);

        var start = ScheduleRequestParsing.Minutes(req.Start) ?? row.StartMinute;
        var end = ScheduleRequestParsing.Minutes(req.End) ?? row.EndMinute;

        if (start >= end || end > BookingSchedule.MinutesPerDay)
        {
            return (null, null, Results.BadRequest(new { error = ScheduleRequestParsing.TimeRangeInvalid }));
        }

        var slice = Math.Max(view.SliceMinutes, 1);
        if (start % slice != 0 || (end - start) % slice != 0)
        {
            return (null, null, Results.BadRequest(new
            {
                error = ScheduleRequestParsing.NotSliceAligned,
                slice_minutes = slice,
            }));
        }

        return (start, end, null);
    }

    private static void Apply(BookingSchedule row, ScheduleSpec spec)
    {
        row.Name = spec.Name;
        row.Label = spec.Label;
        row.DaysOfWeek = spec.DaysOfWeek;
        row.StartMinute = spec.StartMinute;
        row.EndMinute = spec.EndMinute;
        row.StartDate = spec.StartDate;
        row.EndDate = spec.EndDate;
        row.IntervalWeeks = spec.IntervalWeeks;
        row.UpdatedAt = DateTimeOffset.UtcNow;
        row.MaterialisedThrough = null;
    }

    private static async Task ReplaceCourtsAsync(
        MainframeDbContext db, BookingSchedule row, IReadOnlyList<Guid> courtIds, CancellationToken ct)
    {
        var existing = await db.BookingScheduleCourts.Where(c => c.ScheduleId == row.Id).ToListAsync(ct);
        db.BookingScheduleCourts.RemoveRange(existing.Where(c => !courtIds.Contains(c.CourtId)));

        foreach (var courtId in courtIds.Where(id => existing.All(c => c.CourtId != id)))
        {
            db.BookingScheduleCourts.Add(new BookingScheduleCourt
            {
                TenantId = row.TenantId,
                ScheduleId = row.Id,
                CourtId = courtId,
            });
        }
    }

    /// <summary>The changed-keys snapshot the change record diffs. snake_case, to match the renderer.</summary>
    private static object Snapshot(ScheduleSpec spec) => new
    {
        name = spec.Name,
        label = spec.Label,
        days_of_week = spec.DaysOfWeek,
        start_minute = spec.StartMinute,
        end_minute = spec.EndMinute,
        start_date = spec.StartDate.ToString("yyyy-MM-dd"),
        end_date = spec.EndDate?.ToString("yyyy-MM-dd"),
        interval_weeks = spec.IntervalWeeks,
        courts = spec.CourtIds.Count,
    };

    private static object ProjectPreview(SchedulePreview preview, TenantSettingsView view) => new
    {
        occurrences = preview.Occurrences,
        first = preview.First,
        last = preview.Last,
        rows_to_create = preview.RowsToCreate,
        max_rows = ScheduleSettings.MaxRowsPerChange(view),
        conflicts = preview.Conflicts.Select(ProjectConflict).ToList(),
    };

    private static object ProjectConflict(ScheduleConflict c) => new
    {
        occurrence_date = c.OccurrenceDate,
        court_id = c.CourtId,
        court_name = c.CourtName,
        starts_at = c.StartsAt,
        ends_at = c.EndsAt,
        booking_id = c.BookingId,
        status = c.Status,
        kind = c.Kind,
        label = c.Label,
        member_name = c.MemberName,
        amount_credits = c.AmountCredits,
        would_refund_credits = c.WouldRefundCredits,
    };

    private static object Project(
        BookingSchedule s, IReadOnlyDictionary<Guid, List<(Guid Id, string Name)>> courts,
        IReadOnlyDictionary<Guid, string> names, TimeZoneInfo zone) => new
        {
            id = s.Id,
            name = s.Name,
            label = s.Label,
            days = ScheduleRequestParsing.DayKeys(s.DaysOfWeek),
            start = ScheduleRequestParsing.Clock(s.StartMinute),
            end = ScheduleRequestParsing.Clock(s.EndMinute),
            start_date = s.StartDate,
            end_date = s.EndDate,
            interval_weeks = s.IntervalWeeks,
            status = s.Status == ScheduleStatus.Ended ? "ended" : "active",
            courts = courts.GetValueOrDefault(s.Id, []).Select(c => new { id = c.Id, name = c.Name }).ToList(),
            next_occurrence = NextOccurrence(s, zone),
            materialised_through = s.MaterialisedThrough,
            created_by_name = PersonNames.Of(s.CreatedByUserId, names),
            created_at = s.CreatedAt,
        };

    /// <summary>
    /// The next date this rule produces after now, or null when the series has run out.
    ///
    /// <para>
    /// Computed from the RULE rather than read from the materialised rows: a horizon that has
    /// stalled on a conflict still has a next occurrence, and a schedule whose rows are all
    /// behind it should say "none" rather than repeat its last night.
    /// </para>
    /// </summary>
    private static DateTimeOffset? NextOccurrence(BookingSchedule s, TimeZoneInfo zone)
    {
        var now = DateTimeOffset.UtcNow;
        var today = ScheduleClock.Today(zone, now);

        return ScheduleOccurrences
            .Expand(s, [], zone, today, s.EndDate ?? today.AddYears(1))
            .Where(o => o.StartsAt > now)
            .Select(o => (DateTimeOffset?)o.StartsAt)
            .FirstOrDefault();
    }

    private static async Task<Dictionary<Guid, List<(Guid Id, string Name)>>> CourtsByScheduleAsync(
        MainframeDbContext db, IReadOnlyList<Guid> scheduleIds, CancellationToken ct)
    {
        if (scheduleIds.Count == 0) return [];

        var links = await db.BookingScheduleCourts.AsNoTracking()
            .Where(c => scheduleIds.Contains(c.ScheduleId)).ToListAsync(ct);
        var names = await db.Courts.AsNoTracking().ToDictionaryAsync(c => c.Id, c => c.Name, ct);

        return links
            .GroupBy(c => c.ScheduleId)
            .ToDictionary(
                g => g.Key,
                g => g.Select(c => (c.CourtId, names.GetValueOrDefault(c.CourtId, "Court"))).ToList());
    }
}
