using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

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
        var today = ScheduleClock.Today(zone, DateTimeOffset.UtcNow);

        // Filtered on the status the wire reports rather than the stored one (A4-10): a series
        // ended from a future date runs until then, and one past its last date has ended.
        var all = await db.BookingSchedules.AsNoTracking().OrderBy(s => s.Name).ToListAsync(ct);
        var rows = wanted == "all"
            ? all
            : all.Where(s => HasEnded(s, today) == (wanted == "ended")).ToList();

        var courts = await CourtsByScheduleAsync(db, rows.Select(r => r.Id).ToList(), ct);
        var names = await PersonNames.ForAsync(db, rows.Select(r => (Guid?)r.CreatedByUserId), ct);
        var next = await NextOccurrencesAsync(db, rows, zone, ct);

        return Results.Ok(new
        {
            schedules = rows.Select(s => Project(s, courts, names, zone, next)).ToList(),
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
        var next = await NextOccurrencesAsync(db, [row], zone, ct);

        return Results.Ok(new { schedule = Project(row, courts, names, zone, next), timezone });
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

        var held = await db.Bookings.AsNoTracking()
            .Where(b => b.ScheduleId == id && b.Status != BookingStatus.Cancelled)
            .Select(b => new HeldRow(b.Id, b.CourtId, b.ScheduleOccurrenceDate, b.StartsAt, b.EndsAt))
            .ToListAsync(ct);
        var courtNames = await db.Courts.AsNoTracking().ToDictionaryAsync(c => c.Id, c => c.Name, ct);

        var rule = ScheduleOccurrences.Expand(schedule, exceptions, zone, windowFrom, windowTo).ToList();
        var occurrences = ScheduleDates.Project(rule, held, zone, windowFrom, windowTo, now)
            .Select(d => ProjectDate(d, courtNames))
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

        var preview = await schedules.PreviewAsync(spec!, null, ctx.User.Id() ?? Guid.Empty, null, ct);
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
        var preview = await schedules.PreviewAsync(spec!, null, actorId, null, ct);

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
        await LeaveOutAsync(row, preview.LeftOut, actorId, deps, ct);
        await db.SaveChangesAsync(ct);

        // Materialised synchronously as well as by the worker, so the admin sees the result of
        // their own click rather than a calendar that fills in up to fifteen minutes later.
        var outcome = await schedules.MaterialiseAsync(row, ct);

        var courts = await CourtsByScheduleAsync(db, [row.Id], ct);
        var names = await PersonNames.ForAsync(db, [actorId], ct);
        var (zone, _, _) = DoorClock.ZoneOf(view);
        var next = await NextOccurrencesAsync(db, [row], zone, ct);

        return Results.Created($"/api/v1/admin/schedules/{row.Id}", new
        {
            schedule = Project(row, courts, names, zone, next),
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

        var today = ScheduleClock.Today(zone, DateTimeOffset.UtcNow);
        var asked = req.EffectiveFrom ?? today;
        var effective = asked < today ? today : asked;

        var actorId = ctx.User.Id() ?? Guid.Empty;
        var preview = await schedules.PreviewAsync(spec!, id, actorId, effective, ct);
        if (TooLargeOrConflicting(preview, view) is { } stop) return stop;

        var before = Snapshot(new ScheduleSpec(
            row.Name, row.Label, row.DaysOfWeek, row.StartMinute, row.EndMinute,
            row.StartDate, row.EndDate, row.IntervalWeeks,
            await db.BookingScheduleCourts.AsNoTracking()
                .Where(c => c.ScheduleId == id).Select(c => c.CourtId).ToListAsync(ct)));

        await schedules.CancelFutureAsync(id, ScheduleClock.InstantAt(zone, effective, 0), ct);

        // The rule being replaced keeps every date before `effective` (A4-3, wave B).
        row.EarlierRulesJson = ScheduleRuleHistory.Store(ScheduleRuleHistory.Supersede(row, effective));
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
            After: WithEffectiveFrom(Snapshot(spec), effective)), ct);
        await db.SaveChangesAsync(ct);

        var outcome = await schedules.MaterialiseAsync(row, ct);

        var courts = await CourtsByScheduleAsync(db, [row.Id], ct);
        var names = await PersonNames.ForAsync(db, [actorId], ct);
        var next = await NextOccurrencesAsync(db, [row], zone, ct);

        return Results.Ok(new
        {
            schedule = Project(row, courts, names, zone, next),
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

        var (occurrenceDate, row, guard) = await ResolveOccurrenceAsync(id, date, zone, db, ct);
        if (guard is not null) return guard;

        var (start, end, timesBad) = OverrideTimes(req, row!, view);
        if (timesBad is { } bad) return bad;

        var actorId = ctx.User.Id() ?? Guid.Empty;
        var existing = await db.BookingScheduleExceptions
            .FirstOrDefaultAsync(x => x.ScheduleId == id && x.OccurrenceDate == occurrenceDate, ct);

        var exception = existing ?? new BookingScheduleException
        {
            TenantId = row!.TenantId,
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
            SubjectLabel: row!.Name,
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
        var outcome = await schedules.MaterialiseAsync(row!, ct);

        return Results.Ok(new
        {
            occurrence_date = occurrenceDate,
            status = req.Skip ? "skipped" : "overridden",
            rows_created = outcome.RowsWritten,
        });
    }

    /// <summary>
    /// The date and the schedule an occurrence route names, or the refusal that stops it.
    ///
    /// <para>
    /// Three guards, extracted from the handler because together they put it past the
    /// complexity gate: the date must parse, the schedule must be this club's, and the
    /// occurrence must not have started. The last is the one that matters — a date that was
    /// played, checked into, or that had a member's booking cancelled to make room for it is a
    /// fact, and a schedule edit must not rewrite the evidence.
    /// </para>
    /// </summary>
    private static async Task<(DateOnly Date, BookingSchedule? Schedule, IResult? Refusal)>
        ResolveOccurrenceAsync(
            Guid id, string date, TimeZoneInfo zone, MainframeDbContext db, CancellationToken ct)
    {
        if (!DateOnly.TryParseExact(date, "yyyy-MM-dd", null,
                System.Globalization.DateTimeStyles.None, out var occurrenceDate))
        {
            return (default, null, Results.BadRequest(new { error = DoorPeriod.DayInvalid }));
        }

        var row = await db.BookingSchedules.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (row is null)
        {
            return (occurrenceDate, null, Results.NotFound(new { error = ScheduleRequestParsing.NotFound }));
        }

        if (ScheduleClock.InstantAt(zone, occurrenceDate, ScheduleRuleHistory.For(row, occurrenceDate).StartMinute) <= DateTimeOffset.UtcNow)
        {
            return (occurrenceDate, row, Results.Conflict(new
            {
                error = ScheduleRequestParsing.OccurrenceInPast,
                occurrence_date = occurrenceDate,
            }));
        }

        return (occurrenceDate, row, null);
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

        // Ended now only when it ends from today (A4-10). Ended from a future date, the series
        // keeps running — and materialising — until then, and reads "ended" once that date is
        // behind it (HasEnded); marking it ended at once hid the nights it still holds.
        if (effective <= today) row.Status = ScheduleStatus.Ended;
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
            status = HasEnded(row, today) ? "ended" : "active",
            end_date = row.EndDate,
            occurrences_cancelled = cancelled,
            effective_from = effective,
            effective_from_clamped_to = asked < today ? today : (DateOnly?)null,
        });
    }

    /// <summary>
    /// The dates the admin left out on creation, each recorded as a skipped date exactly as a
    /// later "skip this date" would be — on the series, with a reason, and on the record.
    ///
    /// <para>
    /// This is how a conflict nobody can cancel is resolved: a no-show or a game already played
    /// holds its court and is settled, so the date is given up deliberately rather than the
    /// series being refused for good. Only dates the rule really produces arrive here
    /// (<see cref="SchedulePreview.LeftOut"/>), so nothing is recorded about a date the series
    /// never had.
    /// </para>
    /// </summary>
    private static async Task LeaveOutAsync(
        BookingSchedule row, IReadOnlyList<DateOnly> dates, Guid actorId, ScheduleDeps deps, CancellationToken ct)
    {
        foreach (var date in dates)
        {
            deps.Db.BookingScheduleExceptions.Add(new BookingScheduleException
            {
                TenantId = row.TenantId,
                ScheduleId = row.Id,
                OccurrenceDate = date,
                Kind = ScheduleExceptionKind.Skipped,
                Reason = ScheduleRequestParsing.LeftOutReason,
                CreatedByUserId = actorId,
            });

            await deps.Recorder.StageAsync(new AdminChange(
                Action: AdminChangeActions.ScheduleOccurrenceSkipped,
                ActorUserId: actorId,
                SubjectKind: AdminChangeSubjects.Schedule,
                SubjectId: row.Id,
                SubjectLabel: row.Name,
                Reason: ScheduleRequestParsing.LeftOutReason,
                After: new { occurrence_date = date.ToString("yyyy-MM-dd") }), ct);
        }
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
    private static object Snapshot(ScheduleSpec spec)
    {
        // Block body rather than an expression body, for the lizard reason in
        // memory/gotchas.md: lizard's C# parser cannot follow an expression body whose
        // value carries braces (`=> new { … }`, `=> x switch { … }`). It loses scope and
        // emits a *global* pseudo-function spanning the whole FILE, which then trips the
        // 200-line gate on any file long enough to matter.
        return new
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
    }

    private static object ProjectPreview(SchedulePreview preview, TenantSettingsView view)
    {
        // Block body rather than an expression body, for the lizard reason in
        // memory/gotchas.md: lizard's C# parser cannot follow an expression body whose
        // value carries braces (`=> new { … }`, `=> x switch { … }`). It loses scope and
        // emits a *global* pseudo-function spanning the whole FILE, which then trips the
        // 200-line gate on any file long enough to matter.
        return new
        {
            occurrences = preview.Occurrences,
            first = preview.First,
            last = preview.Last,
            rows_to_create = preview.RowsToCreate,
            max_rows = ScheduleSettings.MaxRowsPerChange(view),
            conflicts = preview.Conflicts.Select(ProjectConflict).ToList(),
            left_out = preview.LeftOut,
        };
    }

    private static object ProjectConflict(ScheduleConflict c)
    {
        // Block body rather than an expression body, for the lizard reason in
        // memory/gotchas.md: lizard's C# parser cannot follow an expression body whose
        // value carries braces (`=> new { … }`, `=> x switch { … }`). It loses scope and
        // emits a *global* pseudo-function spanning the whole FILE, which then trips the
        // 200-line gate on any file long enough to matter.
        return new
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
            amount_minutes = c.AmountMinutes,
            would_refund_minutes = c.WouldRefundMinutes,
            cancellable = c.Cancellable,
        };
    }

    private static object Project(
        BookingSchedule s, IReadOnlyDictionary<Guid, List<(Guid Id, string Name)>> courts,
        IReadOnlyDictionary<Guid, string> names, TimeZoneInfo zone,
        IReadOnlyDictionary<Guid, DateTimeOffset?> next)
    {
        var today = ScheduleClock.Today(zone, DateTimeOffset.UtcNow);
        // Block body for the lizard reason — see Snapshot above.
        return new
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
            status = HasEnded(s, today) ? "ended" : "active",
            courts = courts.GetValueOrDefault(s.Id, []).Select(c => new { id = c.Id, name = c.Name }).ToList(),
            next_occurrence = next.GetValueOrDefault(s.Id),
            rules = Rules(s, today),
            materialised_through = s.MaterialisedThrough,
            created_by_name = PersonNames.Of(s.CreatedByUserId, names),
            created_at = s.CreatedAt,
        };
    }

    /// <summary>
    /// Every rule the series has had, oldest first, each with the dates it governs (review round 5,
    /// A5-4). The top-level days and hours are the LATEST rule; a console that described the series
    /// from them alone said "Saturdays" for a series still on Sundays until a change took over, and
    /// counted the wrong weekdays in its End dialog. <c>until</c> is exclusive and null on the last;
    /// <c>in_force</c> marks the one governing today (the first, before the series starts).
    /// </summary>
    private static List<object> Rules(BookingSchedule s, DateOnly today)
    {
        var periods = new List<(DateOnly From, DateOnly? Until, ScheduleRule Rule)>();
        var from = s.StartDate;
        // A rule replaced before the series' first date governed nothing, so it is not listed.
        foreach (var earlier in ScheduleRuleHistory.Earlier(s).Where(e => e.Until > s.StartDate))
        {
            periods.Add((from, earlier.Until, earlier.Rule));
            from = earlier.Until;
        }
        periods.Add((from, null, ScheduleRuleHistory.Current(s)));

        var governing = periods.FindIndex(p => p.Until is not { } until || today < until);
        return periods.Select((p, i) => (object)new
        {
            from = p.From,
            until = p.Until,
            days = ScheduleRequestParsing.DayKeys(p.Rule.DaysOfWeek),
            start = ScheduleRequestParsing.Clock(p.Rule.StartMinute),
            end = ScheduleRequestParsing.Clock(p.Rule.EndMinute),
            interval_weeks = p.Rule.IntervalWeeks,
            in_force = i == governing,
        }).ToList();
    }

    /// <summary>
    /// Whether a series has ended: ended outright, or past its last date (A4-10). A series
    /// ended from a future date is still running until then.
    /// </summary>
    private static bool HasEnded(BookingSchedule s, DateOnly today)
    {
        if (s.Status == ScheduleStatus.Ended) return true;
        return s.EndDate is { } last && last < today;
    }

    /// <summary>
    /// The next start of each series after now, from what it HOLDS first (A4-3).
    ///
    /// <para>
    /// A "from this date on" change leaves the dates before it held at their old hours, so the
    /// rule alone named the new hours for nights the club is holding at the old ones. The next
    /// held row wins; the rule speaks only for dates after the last one held — a horizon that
    /// stalled on a clash still has a next night — with its skipped dates left out.
    /// </para>
    /// </summary>
    private static async Task<Dictionary<Guid, DateTimeOffset?>> NextOccurrencesAsync(
        MainframeDbContext db, IReadOnlyList<BookingSchedule> schedules, TimeZoneInfo zone, CancellationToken ct)
    {
        var ids = schedules.Select(s => s.Id).ToList();
        var now = DateTimeOffset.UtcNow;
        var held = await db.Bookings.AsNoTracking()
            .Where(b => b.ScheduleId != null && ids.Contains(b.ScheduleId.Value) && b.Status != BookingStatus.Cancelled)
            .GroupBy(b => b.ScheduleId!.Value)
            .Select(g => new
            {
                Id = g.Key,
                Next = g.Where(b => b.StartsAt > now).Min(b => (DateTimeOffset?)b.StartsAt),
                Last = g.Max(b => b.ScheduleOccurrenceDate),
            })
            .ToDictionaryAsync(h => h.Id, ct);
        var exceptions = await db.BookingScheduleExceptions.AsNoTracking()
            .Where(x => ids.Contains(x.ScheduleId)).ToListAsync(ct);

        var answer = new Dictionary<Guid, DateTimeOffset?>();
        foreach (var s in schedules)
        {
            var mine = held.GetValueOrDefault(s.Id);
            var fromRule = RuleNextAfter(s, exceptions, zone, mine?.Last, now);
            var fromRows = mine?.Next is { } n ? TimeZoneInfo.ConvertTime(n, zone) : (DateTimeOffset?)null;
            answer[s.Id] = Earliest(fromRows, fromRule);
        }
        return answer;
    }

    private static DateTimeOffset? RuleNextAfter(
        BookingSchedule s, IReadOnlyCollection<BookingScheduleException> exceptions, TimeZoneInfo zone,
        DateOnly? lastHeld, DateTimeOffset now)
    {
        var today = ScheduleClock.Today(zone, now);
        var from = lastHeld is { } last && last >= today ? last.AddDays(1) : today;

        return ScheduleOccurrences
            .Expand(s, exceptions, zone, from, s.EndDate ?? from.AddYears(1))
            .Where(o => o.Status != ScheduleOccurrenceStatus.Skipped && o.StartsAt > now)
            .Select(o => (DateTimeOffset?)o.StartsAt)
            .FirstOrDefault();
    }

    private static DateTimeOffset? Earliest(DateTimeOffset? a, DateTimeOffset? b)
    {
        if (a is null) return b;
        if (b is null) return a;
        return a <= b ? a : b;
    }

    /// <summary>The change record's "after" for a this-and-future edit, naming the date it runs from (A4-3).</summary>
    private static Dictionary<string, object?> WithEffectiveFrom(object snapshot, DateOnly effective)
    {
        var after = System.Text.Json.JsonSerializer.SerializeToElement(snapshot)
            .EnumerateObject()
            .ToDictionary(p => p.Name, p => (object?)p.Value.Clone());
        after["effective_from"] = effective.ToString("yyyy-MM-dd");
        return after;
    }

    private static object ProjectDate(ScheduleDate d, IReadOnlyDictionary<Guid, string> courtNames)
    {
        // Block body for the lizard reason — see Snapshot above.
        return new
        {
            date = d.Date,
            starts_at = d.StartsAt,
            ends_at = d.EndsAt,
            status = d.Status,
            // The rule's own times for the date, and whether the date is held at them (A4-3).
            rule_starts_at = d.RuleStartsAt,
            rule_ends_at = d.RuleEndsAt,
            on_rule = d.OnRule,
            courts = d.Rows.Select(r => new
            {
                court_id = r.CourtId,
                court_name = courtNames.GetValueOrDefault(r.CourtId),
                booking_id = r.Id,
                starts_at = r.StartsAt,
                ends_at = r.EndsAt,
            }).ToList(),
        };
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
