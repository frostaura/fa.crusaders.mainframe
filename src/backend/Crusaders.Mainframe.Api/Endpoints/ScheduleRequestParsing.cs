using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// What an admin sent when they described a repeating booking. Times as <c>HH:mm</c> and days as
/// the three-letter keys <c>OperatingHours</c> already uses, because a club that learned the
/// vocabulary on its opening hours should not learn a second one here.
/// </summary>
public sealed record ScheduleRequest(
    string? Name, string? Label, IReadOnlyList<string>? Days, string? Start, string? End,
    DateOnly? StartDate, DateOnly? EndDate, short IntervalWeeks = 1,
    IReadOnlyList<Guid>? Courts = null);

/// <summary>
/// Turns a <see cref="ScheduleRequest"/> into a <see cref="ScheduleSpec"/>, or into the one
/// refusal that says what is wrong with it.
///
/// <para>
/// <b>Every refusal carries the figure its sentence needs.</b> A volunteer admin told
/// "schedule_not_slice_aligned" cannot act; told it with <c>slice_minutes: 15</c> beside it,
/// they can. That is the same rule every booking refusal in this product already follows, and
/// the reason it is stated here is that a schedule has eight ways to be wrong rather than one.
/// </para>
/// </summary>
public static class ScheduleRequestParsing
{
    public const string NameInvalid = "schedule_name_invalid";
    public const string NameTaken = "schedule_name_taken";
    public const string LabelInvalid = "schedule_label_invalid";
    public const string DaysInvalid = "schedule_days_invalid";
    public const string TimeRangeInvalid = "schedule_time_range_invalid";
    public const string NotSliceAligned = "schedule_not_slice_aligned";
    public const string IntervalOutOfRange = "schedule_interval_out_of_range";
    public const string DateRangeInvalid = "schedule_date_range_invalid";
    public const string CourtsInvalid = "schedule_courts_invalid";
    public const string TooLarge = "schedule_too_large";
    public const string LimitReached = "schedule_limit_reached";
    public const string Conflicts = "schedule_conflicts";
    public const string OccurrenceInPast = "occurrence_in_past";
    public const string NotFound = "schedule_not_found";

    private const int MinNameLength = 2;
    private const int MaxNameLength = 128;
    private const int MaxLabelLength = 128;

    /// <summary>
    /// The spec, or a refusal. Block body for the lizard reason in <c>memory/gotchas.md</c> —
    /// each arm is a different sentence an admin reads, and folding them would produce one
    /// message that fits none of the eight cases.
    /// </summary>
    public static (ScheduleSpec? Spec, IResult? Refusal) Parse(
        ScheduleRequest req, TenantSettingsView view)
    {
        var name = req.Name?.Trim();
        if (name is null || name.Length is < MinNameLength or > MaxNameLength)
            return (null, Results.BadRequest(new { error = NameInvalid }));

        var label = req.Label?.Trim();
        if (label is null || label.Length is 0 or > MaxLabelLength)
            return (null, Results.BadRequest(new { error = LabelInvalid }));

        var (mask, daysBad) = Mask(req.Days);
        if (daysBad) return (null, Results.BadRequest(new { error = DaysInvalid, days = OperatingHours.DayKeys }));

        var start = Minutes(req.Start);
        var end = Minutes(req.End);
        if (start is null || end is null || start >= end || end > BookingSchedule.MinutesPerDay)
            return (null, Results.BadRequest(new { error = TimeRangeInvalid }));

        // Slice alignment is enforced HERE even though a member's own booking is not yet
        // checked for it (D2-B15). A schedule is the thing that would systematically produce
        // off-grid rows: eleven league nights on two courts at 18:05–20:50 would blank two
        // extra grid cells every week for a season, because the grid's overlap rule blanks any
        // cell a booking touches. One mistyped time, a season of lost inventory.
        var slice = Math.Max(view.SliceMinutes, 1);
        if (start.Value % slice != 0 || (end.Value - start.Value) % slice != 0)
            return (null, Results.BadRequest(new { error = NotSliceAligned, slice_minutes = slice }));

        if (req.IntervalWeeks is < 1 or > BookingSchedule.MaxIntervalWeeks)
            return (null, Results.BadRequest(new
            {
                error = IntervalOutOfRange,
                min = 1,
                max = BookingSchedule.MaxIntervalWeeks,
            }));

        if (req.StartDate is not { } startDate)
            return (null, Results.BadRequest(new { error = DateRangeInvalid }));
        if (req.EndDate is { } endDate && endDate < startDate)
            return (null, Results.BadRequest(new { error = DateRangeInvalid }));

        var courts = req.Courts ?? [];
        if (courts.Count == 0 || courts.Distinct().Count() != courts.Count)
            return (null, Results.BadRequest(new { error = CourtsInvalid }));

        return (new ScheduleSpec(
            name, label, mask, start.Value, end.Value, startDate, req.EndDate,
            req.IntervalWeeks, courts), null);
    }

    /// <summary>
    /// The weekday bitmask, and whether the list was unusable.
    ///
    /// <para>
    /// An EMPTY list is invalid rather than "every day": a schedule naming no day produces no
    /// occurrence and would report success having reserved nothing, which is the worst of the
    /// three possible readings.
    /// </para>
    /// </summary>
    private static (int Mask, bool Invalid) Mask(IReadOnlyList<string>? days)
    {
        if (days is null || days.Count == 0) return (0, true);

        var mask = 0;
        foreach (var day in days)
        {
            var index = Array.IndexOf(OperatingHours.DayKeys, day?.Trim().ToLowerInvariant());
            if (index < 0) return (0, true);
            mask |= 1 << index;
        }

        return (mask, false);
    }

    /// <summary>
    /// <c>HH:mm</c> as minutes past local midnight, with <c>24:00</c> accepted as 1440.
    ///
    /// <para>
    /// <c>TimeOnly</c> cannot represent 24:00, and a club whose league night runs to midnight
    /// means the end of the day rather than the start of it — the same distinction
    /// <c>day_end_minute</c> already makes.
    /// </para>
    /// </summary>
    public static int? Minutes(string? text)
    {
        var value = text?.Trim();
        if (string.IsNullOrEmpty(value)) return null;
        if (value == "24:00") return BookingSchedule.MinutesPerDay;

        var parts = value.Split(':');
        if (parts.Length != 2) return null;
        if (!int.TryParse(parts[0], out var hours) || !int.TryParse(parts[1], out var minutes)) return null;
        if (hours is < 0 or > 23 || minutes is < 0 or > 59) return null;

        return hours * 60 + minutes;
    }

    /// <summary>The inverse, for the wire: minutes past midnight as <c>HH:mm</c>, 1440 as 24:00.</summary>
    public static string Clock(int minute)
        => minute >= BookingSchedule.MinutesPerDay ? "24:00" : $"{minute / 60:D2}:{minute % 60:D2}";

    /// <summary>The three-letter keys a mask names, in week order.</summary>
    public static IReadOnlyList<string> DayKeys(int mask)
        => Enumerable.Range(0, 7).Where(d => (mask & (1 << d)) != 0).Select(d => OperatingHours.DayKeys[d]).ToList();

    /// <summary>
    /// The refusals that need the database: a name already taken, courts that are not this
    /// club's live ones, and the active-schedule ceiling.
    /// </summary>
    public static async Task<IResult?> RefuseAgainstTheClubAsync(
        ScheduleSpec spec, Guid? excludeId, MainframeDbContext db, CancellationToken ct)
    {
        var lowered = spec.Name.ToLowerInvariant();
        var taken = await db.BookingSchedules.AsNoTracking()
            .AnyAsync(s => s.Id != excludeId && s.Name.ToLower() == lowered, ct);
        if (taken) return Results.Conflict(new { error = NameTaken, name = spec.Name });

        // Active only, and this club's only. A court another club owns is indistinguishable
        // from an invented one here, because the query filter is structural rather than a
        // comparison this method makes.
        var live = await db.Courts.AsNoTracking()
            .Where(c => c.IsActive && spec.CourtIds.Contains(c.Id))
            .Select(c => c.Id).ToListAsync(ct);
        if (live.Count != spec.CourtIds.Count)
        {
            return Results.BadRequest(new
            {
                error = CourtsInvalid,
                unknown = spec.CourtIds.Except(live).ToList(),
            });
        }

        if (excludeId is null)
        {
            var active = await db.BookingSchedules.AsNoTracking()
                .CountAsync(s => s.Status == ScheduleStatus.Active, ct);
            if (active >= ScheduleSettings.MaxActiveSchedules)
            {
                return Results.Conflict(new
                {
                    error = LimitReached,
                    max = ScheduleSettings.MaxActiveSchedules,
                });
            }
        }

        return null;
    }
}
