using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// N-F6 — the peak-hours rule was enforced by <c>BookingService</c> and invisible to the grid.
///
/// <para>
/// Blueprint A.12 reserves the peak window for league and senior members until
/// <c>peak_advance_hours_for_regular</c> before a slot starts. Until this, the schedule payload
/// said nothing about it, so a Regular member's grid drew 44 cells a day — counted by a finder
/// on 2026-09-10 — as green, clickable "Available", with the same cursor and the same
/// "Book Court 2 at 17:00 for 50.00 cr" label as a slot they could have. The confirmation modal
/// then quoted court, time, cost, balance now and balance after, and the refusal arrived only
/// after Confirm. feature-spec §5 defines <c>available</c> as "green, clickable"; a slot that is
/// neither should not be wearing it.
/// </para>
///
/// <para>
/// The client cannot infer any of this: the member's own class is on no member-facing payload,
/// and <c>peak_hours</c> is admin-only. So the day carries the window, the advance allowance and
/// one flag saying whether THIS viewer is bound by the rule — and these assert that the flag
/// follows the same answer <c>CheckPeakHoursRule</c> gives, for each of the three viewers.
/// </para>
/// </summary>
public class SchedulePeakVisibilityTests
{
    /// <summary>The Crusaders peak window, on a UTC clock so local minutes and UTC minutes agree.</summary>
    private static async Task GivePeakHoursAsync(TestHost host, string peak, int advanceHours)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.TenantSettings.FirstAsync(s => s.TenantId == host.Tenant.Id);
        row.SettingsJson = $$"""
            {"slice_minutes":15,"slice_price_credits":8,"penalty_pct":30,"grace_window_minutes":5,
             "penalty_window_minutes":15,"advance_booking_days":3650,"timezone":"UTC",
             "member_per_day_max_minutes":0,"day_start_minute":360,"day_end_minute":1320,
             "peak_hours":"{{peak}}","peak_advance_hours_for_regular":{{advanceHours}}}
            """;
        await db.SaveChangesAsync();
    }

    private static DateOnly SomeFutureDay => DateOnly.FromDateTime(DateTime.UtcNow).AddDays(8);

    [Fact]
    public async Task The_day_carries_the_peak_window_the_booking_rule_enforces()
    {
        await using var host = await TestHost.CreateAsync();
        await GivePeakHoursAsync(host, "16:00-19:00", 1);
        using var scope = host.NewScope();
        var schedule = scope.ServiceProvider.GetRequiredService<ScheduleService>();

        var day = await schedule.GetDayAsync(SomeFutureDay, host.PlayerUser.Id, default);

        // Minutes past local midnight, the same unit as DayStartMinute beside it, so the grid
        // compares like with like rather than re-parsing "16:00-19:00" on the client.
        Assert.Equal(16 * 60, day.PeakStartMinute);
        Assert.Equal(19 * 60, day.PeakEndMinute);
        Assert.Equal(1, day.PeakAdvanceHoursForRegular);
    }

    [Fact]
    public async Task A_regular_member_is_bound_by_the_rule_and_a_league_member_is_not()
    {
        await using var host = await TestHost.CreateAsync();
        await GivePeakHoursAsync(host, "16:00-19:00", 1);
        using var scope = host.NewScope();
        var schedule = scope.ServiceProvider.GetRequiredService<ScheduleService>();

        var regular = await schedule.GetDayAsync(SomeFutureDay, host.PlayerUser.Id, default);
        var league = await schedule.GetDayAsync(SomeFutureDay, host.LeaguePlayerUser.Id, default);

        // The same first line as CheckPeakHoursRule: LeagueOrSenior is never refused.
        Assert.False(regular.ViewerMayBookPeak);
        Assert.True(league.ViewerMayBookPeak);
    }

    [Fact]
    public async Task An_admin_is_not_bound_by_it_either()
    {
        await using var host = await TestHost.CreateAsync();
        await GivePeakHoursAsync(host, "16:00-19:00", 1);
        using var scope = host.NewScope();
        var schedule = scope.ServiceProvider.GetRequiredService<ScheduleService>();

        // A.6/A.11: "Admin always bypasses caps and peak-hour rules." A grid that greyed peak
        // cells out for the desk would make the club unable to book its own league night.
        var asAdmin = await schedule.GetDayAsync(SomeFutureDay, host.AdminUser.Id, viewerIsAdmin: true, default);

        Assert.True(asAdmin.ViewerMayBookPeak);
    }

    [Fact]
    public async Task A_club_with_no_peak_window_reports_none_rather_than_a_default()
    {
        await using var host = await TestHost.CreateAsync();
        // Empty is what a club that does not run league nights has, and what several fixtures
        // in this suite set. Inventing 16:00-19:00 here would grey out a quarter of their day.
        await GivePeakHoursAsync(host, "", 1);
        using var scope = host.NewScope();
        var schedule = scope.ServiceProvider.GetRequiredService<ScheduleService>();

        var day = await schedule.GetDayAsync(SomeFutureDay, host.PlayerUser.Id, default);

        Assert.Null(day.PeakStartMinute);
        Assert.Null(day.PeakEndMinute);
    }
}
