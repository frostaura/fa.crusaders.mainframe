using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The players-and-splits settings (D11–D13): defaults are the plan's, reads are clamped, quiet
/// hours are the club's own clock, and a share's deadline is measured from the SOLD end.
/// </summary>
public class PlayerSettingsTests
{
    private static TenantSettingsView View(string tz = "UTC") =>
        new(15, 8m, 30m, 5, 15, 14, tz, 1.6m, 100m, 1000m, 60, "16:00-19:00", 1, 2, 0, 1440, 7, ButtonMap.Default());

    [Fact]
    public void Defaults_are_the_plans_numbers()
    {
        var s = View();
        Assert.Equal(48, PlayerSettings.ShareLapseHours(s));
        Assert.Equal(21 * 60, PlayerSettings.QuietStartMinute(s));
        Assert.Equal(7 * 60, PlayerSettings.QuietEndMinute(s));
        Assert.Equal(90, PlayerSettings.RecentPartnerDays(s));
        Assert.Equal(2, PlayerSettings.NudgeLimit(s));
        Assert.Equal(30, PlayerSettings.DirectorySearchesPerMinute(s));
    }

    [Fact]
    public void A_hand_edited_number_is_clamped_on_read()
    {
        var s = View() with { ShareLapseHours = 0, DirectorySearchesPerMinute = 100_000, PlayerNudgeLimit = -3, MemberQuietStartMinute = 5000 };
        Assert.Equal(PlayerSettings.MinShareLapseHours, PlayerSettings.ShareLapseHours(s));
        Assert.Equal(PlayerSettings.MaxDirectorySearchesPerMinute, PlayerSettings.DirectorySearchesPerMinute(s));
        Assert.Equal(PlayerSettings.MinNudgeLimit, PlayerSettings.NudgeLimit(s));
        Assert.Equal(PlayerSettings.MaxQuietMinute, PlayerSettings.QuietStartMinute(s));
    }

    [Theory]
    [InlineData("2026-09-23T20:59:00Z", "2026-09-23T20:59:00Z")] // before the window: now
    [InlineData("2026-09-23T21:00:00Z", "2026-09-24T07:00:00Z")] // the window opens
    [InlineData("2026-09-23T23:30:00Z", "2026-09-24T07:00:00Z")] // late evening: tomorrow 07:00
    [InlineData("2026-09-24T03:00:00Z", "2026-09-24T07:00:00Z")] // small hours: this morning 07:00
    [InlineData("2026-09-24T07:00:00Z", "2026-09-24T07:00:00Z")] // the window has closed
    public void Quiet_hours_hold_non_urgent_mail_until_they_end(string at, string expected)
    {
        Assert.Equal(DateTimeOffset.Parse(expected), PlayerSettings.NextSendable(DateTimeOffset.Parse(at), View()));
    }

    [Fact]
    public void Quiet_hours_are_the_clubs_clock_not_the_servers()
    {
        // 20:00 UTC is 22:00 in Johannesburg — inside the club's quiet hours; they end at 07:00 SAST.
        var at = DateTimeOffset.Parse("2026-09-23T20:00:00Z");
        Assert.Equal(DateTimeOffset.Parse("2026-09-24T05:00:00Z"), PlayerSettings.NextSendable(at, View("Africa/Johannesburg")));
    }

    [Fact]
    public void Equal_start_and_end_switch_quiet_hours_off()
    {
        var at = DateTimeOffset.Parse("2026-09-23T23:30:00Z");
        Assert.Equal(at, PlayerSettings.NextSendable(at, View() with { MemberQuietStartMinute = 0, MemberQuietEndMinute = 0 }));
    }

    [Fact]
    public void A_daytime_window_that_does_not_cross_midnight_works_too()
    {
        var s = View() with { MemberQuietStartMinute = 12 * 60, MemberQuietEndMinute = 14 * 60 };
        Assert.Equal(DateTimeOffset.Parse("2026-09-23T14:00:00Z"), PlayerSettings.NextSendable(DateTimeOffset.Parse("2026-09-23T13:00:00Z"), s));
        Assert.Equal(DateTimeOffset.Parse("2026-09-23T15:00:00Z"), PlayerSettings.NextSendable(DateTimeOffset.Parse("2026-09-23T15:00:00Z"), s));
    }

    /// <summary>
    /// The deadline is the SOLD end plus the lapse hours — never the truncated <c>EndsAt</c> a
    /// no-show sweep leaves, or the organiser not turning up would shorten the partners' time to pay.
    /// </summary>
    [Fact]
    public void The_share_deadline_is_measured_from_the_sold_end()
    {
        var start = DateTimeOffset.Parse("2026-09-23T08:00:00Z");
        var booking = new Booking { StartsAt = start, EndsAt = start.AddMinutes(5), SliceMinutes = 15, SliceCount = 4 };
        Assert.Equal(start.AddMinutes(60).AddHours(48), PlayerSettings.ShareDeadline(booking, View()));
    }
}
