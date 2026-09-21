using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

public sealed class ScheduleService
{
    private readonly MainframeDbContext _db;
    private readonly TenantSettingsAccessor _settings;

    public ScheduleService(MainframeDbContext db, TenantSettingsAccessor settings)
    { _db = db; _settings = settings; }

    public async Task<ScheduleDay> GetDayAsync(DateOnly date, Guid? viewingUserId, CancellationToken ct)
        => await GetDayAsync(date, viewingUserId, viewerIsAdmin: false, ct);

    public async Task<ScheduleDay> GetDayAsync(DateOnly date, Guid? viewingUserId, bool viewerIsAdmin, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        var tz = ResolveTz(settings.Timezone);
        var dayStartLocal = date.ToDateTime(TimeOnly.MinValue);
        var dayStartUtc = TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(dayStartLocal, DateTimeKind.Unspecified), tz);
        var dayEndUtc = dayStartUtc.AddDays(1);

        var courts = await _db.Courts.Where(c => c.IsActive).OrderBy(c => c.CourtNumber).ToListAsync(ct);

        var bookings = await _db.Bookings
            .Where(b => b.Status != BookingStatus.Cancelled
                     && b.StartsAt < dayEndUtc && b.EndsAt > dayStartUtc)
            .ToListAsync(ct);

        var userIds = bookings.Where(b => b.UserId is not null).Select(b => b.UserId!.Value).Distinct().ToList();
        var memberByUser = await _db.Memberships
            .Where(m => userIds.Contains(m.UserId))
            .ToDictionaryAsync(m => m.UserId, ct);

        // Courts keyed once rather than re-scanned per booking: the old shape walked the
        // whole booking list once per court, which on a four-court day is four passes and
        // on a twenty-court club is twenty. The output order is unchanged.
        var bookingsByCourt = bookings.ToLookup(b => b.CourtId);

        // One read for the whole grid, not one per cell. A league night is four courts by
        // twelve slices, so resolving the plan's name inside the loop would be forty-eight
        // queries for one string — the N+1 the lookup above already exists to prevent.
        var scheduleIds = bookings.Where(b => b.ScheduleId is not null)
            .Select(b => b.ScheduleId!.Value).Distinct().ToList();
        var scheduleNames = scheduleIds.Count == 0
            ? []
            : await _db.BookingSchedules.AsNoTracking()
                .Where(s => scheduleIds.Contains(s.Id))
                .ToDictionaryAsync(s => s.Id, s => s.Name, ct);

        var slots = new List<ScheduleSlot>(bookings.Count);
        foreach (var court in courts)
        {
            foreach (var b in bookingsByCourt[court.Id])
            {
                var member = b.UserId is { } u ? memberByUser.GetValueOrDefault(u) : null;
                var isMine = viewingUserId is not null && viewingUserId == b.UserId;

                // Attendance and price are the booking OWNER's business, and the admin's.
                // "The booking grid shows photo + name only" — no email, phone, membership
                // number, and by the same reasoning no other member's spend. Null rather
                // than zero, so the client cannot render a figure it was never given.
                var maySeeDetail = isMine || viewerIsAdmin;

                slots.Add(new ScheduleSlot(
                    CourtId: court.Id,
                    CourtNumber: court.CourtNumber,
                    StartsAtUtc: b.StartsAt,
                    EndsAtUtc: b.EndsAt,
                    Status: b.Status.ToString().ToLowerInvariant(),
                    OwnerUserId: b.UserId,
                    OwnerFirstName: member is null ? null : FirstName(member.FullName),
                    OwnerPhotoUrl: member?.PhotoUrl,
                    IsMine: isMine,
                    BookingId: b.Id,
                    BlockLabel: b.BlockLabel,
                    // The single fact the cancel affordance needed and never had: the
                    // lights have been on, so nothing comes back. A grep of the frontend
                    // for check-in used to return three comments and no rendered field,
                    // because the projection did not carry it at all.
                    CheckedIn: maySeeDetail ? b.CheckedInAt is not null : null,
                    AmountChargedCredits: maySeeDetail ? b.AmountChargedCredits : null,
                    ScheduleId: b.ScheduleId,
                    ScheduleName: b.ScheduleId is { } sid ? scheduleNames.GetValueOrDefault(sid) : null));
            }
        }

        // The hours for THIS weekday, not a flat pair. tenant_settings.operating_hours has
        // been written by the seeder since day one and read by nothing, so a club that
        // shuts at 20:00 on a Saturday had its grid drawn to 22:00 and sold every slot in
        // between. Same two field names on the wire: the client asks for one day at a time
        // and this is that day's answer.
        var (openMinute, closeMinute) = settings.HoursFor(dayStartLocal.DayOfWeek);

        // N-F6. The peak-hours rule was enforced by BookingService and invisible to the grid,
        // so 44 cells a day rendered to a Regular member as green, clickable "Available" —
        // same colour, same cursor, same "Book Court 2 at 17:00 for 50.00 cr" label as a slot
        // they could actually have — and the refusal arrived only after they had read a price
        // and pressed Confirm. The client cannot infer this: the member's class is not on any
        // member-facing payload and peak_hours is admin-only. So the day carries the window,
        // the advance allowance, and one flag saying whether THIS viewer is bound by it.
        var peak = settings.PeakHours();
        var viewerMayBookPeak = viewerIsAdmin || await ViewerBypassesPeakAsync(viewingUserId, ct);

        return new ScheduleDay(
            Date: date,
            Timezone: settings.Timezone,
            SliceMinutes: settings.SliceMinutes,
            DayStartMinute: openMinute,
            DayEndMinute: closeMinute,
            AdvanceBookingDays: settings.AdvanceBookingDays,
            PenaltyPct: settings.PenaltyPct,
            PenaltyWindowMinutes: settings.PenaltyWindowMinutes,
            PeakStartMinute: peak is { } p ? (int)p.start.ToTimeSpan().TotalMinutes : null,
            PeakEndMinute: peak is { } q ? (int)q.end.ToTimeSpan().TotalMinutes : null,
            PeakAdvanceHoursForRegular: settings.PeakAdvanceHoursForRegular,
            ViewerMayBookPeak: viewerMayBookPeak,
            Courts: courts.Select(c => new ScheduleCourt(c.Id, c.CourtNumber, c.Name, c.SlicePriceCredits)).ToList(),
            Slots: slots);
    }

    /// <summary>
    /// Is this viewer exempt from the peak-hours league/senior rule?
    /// </summary>
    /// <remarks>
    /// Mirrors <c>BookingService.CheckPeakHoursRule</c>'s first line, which returns null — no
    /// refusal — for <see cref="MemberClass.LeagueOrSenior"/>. An anonymous or membership-less
    /// viewer falls to <c>Regular</c>, the stricter answer: the grid may never offer a slot the
    /// booking service would refuse, and the cost of being wrong the other way is one extra
    /// cell drawn as restricted.
    /// </remarks>
    private async Task<bool> ViewerBypassesPeakAsync(Guid? viewingUserId, CancellationToken ct)
    {
        if (viewingUserId is not { } userId) return false;
        var cls = await _db.Memberships
            .Where(m => m.UserId == userId)
            .Select(m => m.MemberClass)
            .FirstOrDefaultAsync(ct);
        return cls == MemberClass.LeagueOrSenior;
    }

    private static string FirstName(string fullName)
    {
        var i = fullName.IndexOf(' ');
        return i < 0 ? fullName : fullName[..i];
    }

    private static TimeZoneInfo ResolveTz(string id)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch { return TimeZoneInfo.Utc; }
    }
}

public sealed record ScheduleDay(
    DateOnly Date,
    string Timezone,
    int SliceMinutes,
    int DayStartMinute,
    int DayEndMinute,
    int AdvanceBookingDays,
    decimal PenaltyPct,
    int PenaltyWindowMinutes,
    /// <summary>Peak window, minutes past local midnight. Null when `peak_hours` is unset or malformed.</summary>
    int? PeakStartMinute,
    int? PeakEndMinute,
    /// <summary>How close to a peak slot a Regular member may take it anyway (A.12).</summary>
    int PeakAdvanceHoursForRegular,
    /// <summary>True for an admin or a league/senior member — the two the peak rule never refuses.</summary>
    bool ViewerMayBookPeak,
    List<ScheduleCourt> Courts,
    List<ScheduleSlot> Slots);

public sealed record ScheduleCourt(Guid Id, int CourtNumber, string Name, decimal SlicePriceCredits);

public sealed record ScheduleSlot(
    Guid CourtId,
    int CourtNumber,
    DateTimeOffset StartsAtUtc,
    DateTimeOffset EndsAtUtc,
    string Status,
    Guid? OwnerUserId,
    string? OwnerFirstName,
    string? OwnerPhotoUrl,
    bool IsMine,
    Guid? BookingId,
    string? BlockLabel,
    bool? CheckedIn,
    decimal? AmountChargedCredits,

    /// <summary>
    /// The repeating schedule that produced this row, when one did — item 14.
    ///
    /// <para>
    /// <b>The NAME, not the label, and both are deliberate.</b> An occurrence's
    /// <c>BlockLabel</c> is the schedule's <c>Label</c> — the words the club wants ON the cell
    /// ("League — Div 1"). This is the schedule's <c>Name</c>, which is unique per club and is
    /// what identifies the plan a hold belongs to ("Tuesday league"). The grid renders the
    /// plan's name beside "Club hold"; the label alone could not say which of two league nights
    /// this is, because a label is not unique.
    /// </para>
    ///
    /// <para>
    /// Null on every ordinary booking and on a one-off admin block, which is what lets a cell
    /// tell a recurring hold from a hold somebody made by hand.
    /// </para>
    /// </summary>
    Guid? ScheduleId = null,
    string? ScheduleName = null);
