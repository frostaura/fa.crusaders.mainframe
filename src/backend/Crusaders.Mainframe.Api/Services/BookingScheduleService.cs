using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// GOAL item 14 — repeating court bookings, verified against everything that already holds a
/// court, and never silently overwriting any of it.
///
/// <para>
/// <b>Occurrences are MATERIALISED as real <c>AdminBlock</c> booking rows.</b> The decisive
/// reason is one line of SQL: <c>ck_bookings_no_overlapping_slot</c> is the only thing in this
/// system that actually reserves a court, and it is a constraint on the <c>bookings</c> table.
/// A virtual occurrence reserves nothing — a member would book straight through league night —
/// and four readers would each have to learn about schedules separately to stop them:
/// <c>BookingService.CreateAsync</c>, the grid's <c>ScheduleService</c>,
/// <c>DeviceRosterBuilder</c> (what the court box will admit) and the door's
/// <c>booking_window</c> policy. Four readers, four new concepts, four places to get it wrong.
/// Materialised blocks are understood by all four today with no change at all.
/// </para>
///
/// <para>
/// <b>There is no force flag, and there will not be one.</b> A member who paid must be refunded
/// deliberately, through a cancellation — which is exactly the rule
/// <c>AdminBlockService.CreateAsync</c> already enforces for a single block, restated at the
/// scale of a season. The conflict list is shaped to be pasted straight into
/// <c>POST /api/v1/admin/bookings/bulk-cancel</c>, which is the only reason these two items
/// were designed together.
/// </para>
///
/// <para>
/// <b>Past occurrences are immutable mechanically, not by convention.</b> Every write and every
/// cancel-and-rewrite here is scoped <c>StartsAt &gt; now</c>. A past occurrence that was
/// played, checked into, or that had a member's booking cancelled to make room for it is a
/// fact, and a schedule edit must not rewrite the evidence.
/// </para>
/// </summary>
public sealed class BookingScheduleService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly TenantSettingsAccessor _settings;
    private readonly BookingService _bookings;
    private readonly ILogger<BookingScheduleService> _logger;

    public BookingScheduleService(
        MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settings,
        BookingService bookings, ILogger<BookingScheduleService> logger)
    { _db = db; _tenant = tenant; _settings = settings; _bookings = bookings; _logger = logger; }

    /// <summary>What a rule would produce over the horizon, and everything already in its way.</summary>
    public async Task<SchedulePreview> PreviewAsync(
        ScheduleSpec spec, Guid? excludeScheduleId, Guid actorId, CancellationToken ct)
    {
        var view = await _settings.GetAsync(ct);
        var (zone, _, _) = DoorClock.ZoneOf(view);
        var today = ScheduleClock.Today(zone, DateTimeOffset.UtcNow);
        var horizon = today.AddDays(ScheduleSettings.EffectiveHorizonDays(view));

        var rule = ToRow(spec, actorId);
        rule.Id = excludeScheduleId ?? Guid.NewGuid();

        var exceptions = excludeScheduleId is { } id
            ? await _db.BookingScheduleExceptions.AsNoTracking().Where(x => x.ScheduleId == id).ToListAsync(ct)
            : [];

        var occurrences = ScheduleOccurrences
            .Expand(rule, exceptions, zone, spec.StartDate, horizon)
            .Where(o => o.Status != ScheduleOccurrenceStatus.Skipped)
            .ToList();

        var conflicts = await ConflictsAsync(occurrences, spec.CourtIds, excludeScheduleId, actorId, ct);

        return new SchedulePreview(
            Occurrences: occurrences.Count,
            First: occurrences.Count == 0 ? null : occurrences[0].Date,
            Last: occurrences.Count == 0 ? null : occurrences[^1].Date,
            RowsToCreate: occurrences.Count * spec.CourtIds.Count,
            Conflicts: conflicts);
    }

    /// <summary>
    /// Everything that already holds court-time one of these occurrences wants.
    ///
    /// <para>
    /// <paramref name="excludeScheduleId"/> is what lets an EDIT of a schedule not report the
    /// schedule's own existing rows as conflicts with itself — which is otherwise every row it
    /// has, and would make a schedule uneditable the moment it had been materialised once.
    /// </para>
    /// </summary>
    private async Task<List<ScheduleConflict>> ConflictsAsync(
        IReadOnlyList<ScheduleOccurrence> occurrences, IReadOnlyList<Guid> courtIds,
        Guid? excludeScheduleId, Guid actorId, CancellationToken ct)
    {
        if (occurrences.Count == 0 || courtIds.Count == 0) return [];

        var windowStart = occurrences[0].StartsAt.ToUniversalTime();
        var windowEnd = occurrences[^1].EndsAt.ToUniversalTime();

        var candidates = await _db.Bookings.AsNoTracking()
            .Where(b => courtIds.Contains(b.CourtId)
                        && b.Status != BookingStatus.Cancelled
                        && b.StartsAt < windowEnd && b.EndsAt > windowStart)
            .Where(b => excludeScheduleId == null || b.ScheduleId != excludeScheduleId)
            .ToListAsync(ct);
        if (candidates.Count == 0) return [];

        var courts = await _db.Courts.AsNoTracking().ToDictionaryAsync(c => c.Id, c => c.Name, ct);
        var names = await PersonNames.ForAsync(_db, candidates.Select(b => b.UserId), ct);
        var labels = await ScheduleLabelsAsync(candidates, ct);

        var conflicts = new List<ScheduleConflict>();
        foreach (var occurrence in occurrences)
        {
            var from = occurrence.StartsAt.ToUniversalTime();
            var to = occurrence.EndsAt.ToUniversalTime();

            foreach (var court in courtIds)
            {
                foreach (var clash in candidates.Where(b =>
                             b.CourtId == court && b.StartsAt < to && b.EndsAt > from))
                {
                    conflicts.Add(await DescribeAsync(
                        occurrence.Date, clash, new ConflictNames(courts, names, labels), actorId, ct));
                }
            }
        }

        return conflicts;
    }

    /// <summary>
    /// One conflict, with the figure the cancellation will actually pay.
    ///
    /// <para>
    /// <c>would_refund_credits</c> comes from <see cref="BookingService.QuoteCancellationAsync"/>
    /// and not from arithmetic here — the same quote-then-settle discipline the member's own
    /// cancellation modal uses. An admin deciding whether to clear a league night has to read
    /// the number the club will really pay out, not an estimate that ignores the penalty window.
    /// </para>
    /// </summary>
    private async Task<ScheduleConflict> DescribeAsync(
        DateOnly date, Booking clash, ConflictNames lookups, Guid actorId, CancellationToken ct)
    {
        var (courts, names, labels) = (lookups.Courts, lookups.Members, lookups.Schedules);

        var isBlock = clash.Status == BookingStatus.AdminBlock;
        var quote = isBlock ? null : await _bookings.QuoteCancellationAsync(clash.Id, actorId, actorIsAdmin: true, ct);

        return new ScheduleConflict(
            OccurrenceDate: date,
            CourtId: clash.CourtId,
            CourtName: courts.GetValueOrDefault(clash.CourtId),
            StartsAt: clash.StartsAt,
            EndsAt: clash.EndsAt,
            BookingId: clash.Id,
            Status: StatusWord(clash.Status),
            Kind: clash.ScheduleId is not null ? "schedule" : isBlock ? "block" : "booking",
            Label: clash.ScheduleId is { } sid ? labels.GetValueOrDefault(sid) : clash.BlockLabel,
            MemberName: PersonNames.Of(clash.UserId, names),
            AmountCredits: clash.AmountChargedCredits,

            // A quote is null when the row is not cancellable through the money path — a block,
            // or a booking somebody has already checked into. Zero is the truth there: lifting a
            // block refunds nothing, and nothing is owed once the lights have been on.
            WouldRefundCredits: quote is null ? 0m : quote.RefundCredits);
    }

    private async Task<Dictionary<Guid, string>> ScheduleLabelsAsync(
        IReadOnlyList<Booking> candidates, CancellationToken ct)
    {
        var ids = candidates.Where(b => b.ScheduleId is not null).Select(b => b.ScheduleId!.Value).Distinct().ToList();
        if (ids.Count == 0) return [];

        return await _db.BookingSchedules.AsNoTracking()
            .Where(s => ids.Contains(s.Id))
            .ToDictionaryAsync(s => s.Id, s => s.Name, ct);
    }

    private static string StatusWord(BookingStatus status)
    {
        // Block body rather than an expression body, for the lizard reason in
        // memory/gotchas.md — see BookingRefusals.CodeOf for the mechanism.
        return status switch
        {
            BookingStatus.Booked => "booked",
            BookingStatus.NoShow => "no_show",
            BookingStatus.Completed => "completed",
            BookingStatus.AdminBlock => "block",
            _ => "cancelled",
        };
    }

    // ------------------------------------------------------------------ writing

    /// <summary>Builds the row a spec describes. Not saved.</summary>
    public static BookingSchedule ToRow(ScheduleSpec spec, Guid actorId)
    {
        // Block body for the lizard reason in memory/gotchas.md — see StatusWord below.
        return new BookingSchedule
        {
            Name = spec.Name,
            Label = spec.Label,
            DaysOfWeek = spec.DaysOfWeek,
            StartMinute = spec.StartMinute,
            EndMinute = spec.EndMinute,
            StartDate = spec.StartDate,
            EndDate = spec.EndDate,
            IntervalWeeks = spec.IntervalWeeks,
            CreatedByUserId = actorId,
        };
    }

    /// <summary>
    /// Writes every occurrence inside the horizon that is not already there and has not
    /// started.
    ///
    /// <para>
    /// <b><c>StartsAt &gt; now</c> is the whole of past-immutability.</b> Not a rule someone has
    /// to remember at four call sites — a predicate on the one query that writes. An occurrence
    /// whose start has passed is never written, never rewritten, and never cancelled by a
    /// schedule edit.
    /// </para>
    ///
    /// <para>
    /// A collision with a member's booking is <b>skipped and counted</b>, not an error and never
    /// an overwrite: the horizon simply does not advance past a night the club has not cleared,
    /// so a stalled horizon is visible on the schedule's own row rather than discovered on the
    /// night. <c>23P01</c> is caught per row because the exclusion constraint is the only place
    /// a court-time collision is decidable, and two admins editing at once will race here.
    /// </para>
    /// </summary>
    public async Task<MaterialisationOutcome> MaterialiseAsync(
        BookingSchedule schedule, CancellationToken ct)
    {
        var view = await _settings.GetAsync(ct);
        var (zone, _, _) = DoorClock.ZoneOf(view);
        var now = DateTimeOffset.UtcNow;
        var today = ScheduleClock.Today(zone, now);
        var horizon = today.AddDays(ScheduleSettings.EffectiveHorizonDays(view));

        if (schedule.Status == ScheduleStatus.Ended)
        {
            return new MaterialisationOutcome(0, schedule.MaterialisedThrough, 0);
        }

        var courts = await _db.BookingScheduleCourts.AsNoTracking()
            .Where(c => c.ScheduleId == schedule.Id).Select(c => c.CourtId).ToListAsync(ct);
        if (courts.Count == 0) return new MaterialisationOutcome(0, schedule.MaterialisedThrough, 0);

        var exceptions = await _db.BookingScheduleExceptions.AsNoTracking()
            .Where(x => x.ScheduleId == schedule.Id).ToListAsync(ct);

        var existing = await _db.Bookings.AsNoTracking()
            .Where(b => b.ScheduleId == schedule.Id && b.Status != BookingStatus.Cancelled)
            .Select(b => new { b.CourtId, b.StartsAt })
            .ToListAsync(ct);
        var already = existing.Select(e => (e.CourtId, e.StartsAt.ToUniversalTime())).ToHashSet();

        var written = 0;
        var collisions = 0;
        var clashDates = new List<DateOnly>();
        var cap = ScheduleSettings.MaxRowsPerChange(view);
        var reached = schedule.MaterialisedThrough;

        foreach (var occurrence in ScheduleOccurrences.Expand(schedule, exceptions, zone, schedule.StartDate, horizon))
        {
            if (occurrence.Status == ScheduleOccurrenceStatus.Skipped) continue;
            if (occurrence.StartsAt <= now) continue;
            if (written >= cap) break;

            var (rows, clashed) = await WriteOccurrenceAsync(schedule, occurrence, courts, already, view, ct);
            written += rows;
            collisions += clashed;

            // The horizon advances only past an occurrence that landed WHOLE. A night where one
            // court was already sold is a night the club has not cleared, and reporting it as
            // materialised would hide exactly the thing an admin has to act on.
            if (clashed == 0) reached = occurrence.EndsAt.ToUniversalTime();
            else clashDates.Add(occurrence.Date);
        }

        schedule.MaterialisedThrough = reached;
        schedule.UpdatedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);

        // The admins hear about a clash (R23). Raised on its own save rather than staged into the
        // one above: a clash is the ABSENCE of a write, so there is no event row to commit it with,
        // and this path runs on every sweep while the clash stands — the dedupe key (the schedule
        // and its first clash) is what makes that one notice, and a collision on it must never be
        // able to fail the save that advances the horizon.
        if (clashDates.Count > 0)
        {
            await AdminNotices.RaiseAsync(_db, _tenant.TenantId,
                AdminNotices.ScheduleConflict(schedule, clashDates, collisions), DateTimeOffset.UtcNow, ct);
        }

        return new MaterialisationOutcome(written, reached, collisions);
    }

    private async Task<(int Rows, int Collisions)> WriteOccurrenceAsync(
        BookingSchedule schedule, ScheduleOccurrence occurrence, IReadOnlyList<Guid> courts,
        HashSet<(Guid, DateTimeOffset)> already, TenantSettingsView view, CancellationToken ct)
    {
        var startsAt = occurrence.StartsAt.ToUniversalTime();
        var endsAt = occurrence.EndsAt.ToUniversalTime();
        var minutes = (int)(endsAt - startsAt).TotalMinutes;
        var slice = Math.Max(view.SliceMinutes, 1);

        var rows = 0;
        var collisions = 0;

        foreach (var courtId in courts)
        {
            if (already.Contains((courtId, startsAt))) continue;

            _db.Bookings.Add(new Booking
            {
                TenantId = _tenant.TenantId,
                CourtId = courtId,
                UserId = null,
                BookedByUserId = null,
                PaidByUserId = null,
                ActorUserId = schedule.CreatedByUserId,
                StartsAt = startsAt,
                EndsAt = endsAt,
                SliceMinutes = slice,
                SliceCount = Math.Max(minutes / slice, 1),
                AmountChargedCredits = 0m,
                Status = BookingStatus.AdminBlock,
                BlockLabel = schedule.Label,
                ScheduleId = schedule.Id,
                ScheduleOccurrenceDate = occurrence.Date,
            });

            try
            {
                await _db.SaveChangesAsync(ct);
                already.Add((courtId, startsAt));
                rows++;
            }
            catch (DbUpdateException ex) when (IsOverlapViolation(ex))
            {
                // Somebody already holds this court-time. Never overwritten — the admin's path
                // forward is the conflict list and bulk-cancel, which refunds each member and
                // emails them.
                Detach();
                collisions++;
                _logger.LogInformation(
                    "Schedule {ScheduleId} could not take court {CourtId} at {StartsAt}: already reserved",
                    schedule.Id, courtId, startsAt);
            }
        }

        return (rows, collisions);
    }

    /// <summary>
    /// Soft-cancels every UNSTARTED occurrence of a schedule from an instant onward.
    ///
    /// <para>
    /// Cancelled rather than deleted, exactly as <c>AdminBlockService.RemoveAsync</c> does: the
    /// exclusion constraint ignores cancelled rows so the court frees immediately, and the block
    /// stays on the record.
    /// </para>
    /// </summary>
    public async Task<int> CancelFutureAsync(Guid scheduleId, DateTimeOffset from, CancellationToken ct)
    {
        var floor = from < DateTimeOffset.UtcNow ? DateTimeOffset.UtcNow : from;

        var rows = await _db.Bookings
            .Where(b => b.ScheduleId == scheduleId
                        && b.Status == BookingStatus.AdminBlock
                        && b.StartsAt > floor)
            .ToListAsync(ct);

        foreach (var row in rows)
        {
            row.Status = BookingStatus.Cancelled;
            row.CancelledAt = DateTimeOffset.UtcNow;
        }

        if (rows.Count > 0) await _db.SaveChangesAsync(ct);
        return rows.Count;
    }

    /// <summary>The rows one date of a schedule holds, cancelled. Past dates are untouched.</summary>
    public async Task<int> CancelOccurrenceAsync(Guid scheduleId, DateOnly date, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var rows = await _db.Bookings
            .Where(b => b.ScheduleId == scheduleId
                        && b.ScheduleOccurrenceDate == date
                        && b.Status == BookingStatus.AdminBlock
                        && b.StartsAt > now)
            .ToListAsync(ct);

        foreach (var row in rows)
        {
            row.Status = BookingStatus.Cancelled;
            row.CancelledAt = DateTimeOffset.UtcNow;
        }

        if (rows.Count > 0) await _db.SaveChangesAsync(ct);
        return rows.Count;
    }

    private void Detach()
    {
        foreach (var entry in _db.ChangeTracker.Entries().Where(e => e.State == EntityState.Added).ToList())
        {
            entry.State = EntityState.Detached;
        }
    }

    private static bool IsOverlapViolation(DbUpdateException ex)
        => ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == "23P01";
}
