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
                    AmountChargedCredits: maySeeDetail ? b.AmountChargedCredits : null));
            }
        }

        // The hours for THIS weekday, not a flat pair. tenant_settings.operating_hours has
        // been written by the seeder since day one and read by nothing, so a club that
        // shuts at 20:00 on a Saturday had its grid drawn to 22:00 and sold every slot in
        // between. Same two field names on the wire: the client asks for one day at a time
        // and this is that day's answer.
        var (openMinute, closeMinute) = settings.HoursFor(dayStartLocal.DayOfWeek);

        return new ScheduleDay(
            Date: date,
            Timezone: settings.Timezone,
            SliceMinutes: settings.SliceMinutes,
            DayStartMinute: openMinute,
            DayEndMinute: closeMinute,
            AdvanceBookingDays: settings.AdvanceBookingDays,
            PenaltyPct: settings.PenaltyPct,
            PenaltyWindowMinutes: settings.PenaltyWindowMinutes,
            Courts: courts.Select(c => new ScheduleCourt(c.Id, c.CourtNumber, c.Name, c.SlicePriceCredits)).ToList(),
            Slots: slots);
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
    decimal? AmountChargedCredits);
