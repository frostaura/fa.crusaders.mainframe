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

        var slots = new List<ScheduleSlot>();
        foreach (var court in courts)
        {
            foreach (var b in bookings.Where(b => b.CourtId == court.Id))
            {
                var member = b.UserId is { } u ? memberByUser.GetValueOrDefault(u) : null;
                slots.Add(new ScheduleSlot(
                    CourtId: court.Id,
                    CourtNumber: court.CourtNumber,
                    StartsAtUtc: b.StartsAt,
                    EndsAtUtc: b.EndsAt,
                    Status: b.Status.ToString().ToLowerInvariant(),
                    OwnerUserId: b.UserId,
                    OwnerFirstName: member is null ? null : FirstName(member.FullName),
                    OwnerPhotoUrl: member?.PhotoUrl,
                    IsMine: viewingUserId is not null && viewingUserId == b.UserId,
                    BookingId: b.Id,
                    BlockLabel: b.BlockLabel));
            }
        }

        return new ScheduleDay(
            Date: date,
            Timezone: settings.Timezone,
            SliceMinutes: settings.SliceMinutes,
            DayStartMinute: settings.DayStartMinute,
            DayEndMinute: settings.DayEndMinute,
            AdvanceBookingDays: settings.AdvanceBookingDays,
            Courts: courts.Select(c => new ScheduleCourt(c.Id, c.CourtNumber, c.Name, c.SlicePriceZar)).ToList(),
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
    List<ScheduleCourt> Courts,
    List<ScheduleSlot> Slots);

public sealed record ScheduleCourt(Guid Id, int CourtNumber, string Name, decimal SlicePriceZar);

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
    string? BlockLabel);
