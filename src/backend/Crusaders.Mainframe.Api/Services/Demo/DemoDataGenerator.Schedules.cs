using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services.Demo;

public sealed partial class DemoDataGenerator
{
    /// <summary>The demo's repeating bookings: a weekly league night and a Saturday coaching block.</summary>
    private static readonly (string Name, string Label, DayOfWeek Day, int Start, int End, bool LastCourts)[] Series =
    [
        ("League night", "League night", DayOfWeek.Tuesday, 18 * 60, 20 * 60, false),
        ("Saturday coaching", "Coaching", DayOfWeek.Saturday, 8 * 60, 10 * 60, true),
    ];

    /// <summary>
    /// Two repeating schedules that began eight weeks ago. Their past nights are written as the
    /// materialiser writes them (it never writes the past itself), and every night from now to the
    /// club's horizon is materialised by <see cref="BookingScheduleService"/> — the real path.
    /// Every block holds its court, so the bookings drawn afterwards go around them.
    /// </summary>
    private async Task PlanSchedulesAsync(DemoWorld w, CancellationToken ct)
    {
        if (w.Courts.Count == 0) return;
        var zone = w.Zone;
        var started = w.Today.AddDays(-56);
        foreach (var (name, label, day, start, end, lastCourts) in Series)
        {
            var courts = lastCourts ? w.Courts.TakeLast(1).ToList() : w.Courts.Take(Math.Min(2, w.Courts.Count)).ToList();
            var schedule = new BookingSchedule
            {
                TenantId = w.TenantId,
                Name = name,
                Label = label,
                DaysOfWeek = 1 << (int)day,
                StartMinute = start,
                EndMinute = end,
                StartDate = started,
                CreatedByUserId = w.AdminId,
                CreatedAt = w.At(started.AddDays(-3), 9 * 60),
            };
            _db.BookingSchedules.Add(schedule);
            foreach (var court in courts)
            {
                _db.BookingScheduleCourts.Add(new BookingScheduleCourt { TenantId = w.TenantId, ScheduleId = schedule.Id, CourtId = court.Id });
            }
            WritePastNights(w, schedule, courts, zone);
            await _db.SaveChangesAsync(ct);
            await _schedules.MaterialiseAsync(schedule, ct);
        }

        // What the materialiser wrote holds court time too.
        var blocks = await _db.Bookings.AsNoTracking()
            .Where(b => b.Status == BookingStatus.AdminBlock && b.StartsAt > w.Now)
            .Select(b => new { b.CourtId, b.StartsAt, b.EndsAt }).ToListAsync(ct);
        foreach (var b in blocks) w.Hold(b.CourtId, b.StartsAt, b.EndsAt);
    }

    private void WritePastNights(DemoWorld w, BookingSchedule schedule, List<Court> courts, TimeZoneInfo zone)
    {
        foreach (var night in ScheduleOccurrences.Expand(schedule, [], zone, schedule.StartDate, w.Today))
        {
            if (night.StartsAt > w.Now) continue;
            var startsAt = night.StartsAt.ToUniversalTime().Storable();
            var endsAt = night.EndsAt.ToUniversalTime().Storable();
            var minutes = (int)(endsAt - startsAt).TotalMinutes;
            var slice = Math.Max(w.Settings.SliceMinutes, 1);
            foreach (var court in courts)
            {
                w.Hold(court.Id, startsAt, endsAt);
                _db.Bookings.Add(new Booking
                {
                    TenantId = w.TenantId,
                    CourtId = court.Id,
                    ActorUserId = schedule.CreatedByUserId,
                    StartsAt = startsAt,
                    EndsAt = endsAt,
                    SliceMinutes = slice,
                    SliceCount = Math.Max(minutes / slice, 1),
                    Status = BookingStatus.AdminBlock,
                    BlockLabel = schedule.Label,
                    ScheduleId = schedule.Id,
                    ScheduleOccurrenceDate = night.Date,
                    CreatedAt = schedule.CreatedAt,
                });
            }
        }
    }
}
