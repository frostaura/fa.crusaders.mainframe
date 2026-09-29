using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>The seven play settings (<c>docs/specs/play.md</c> §6.4): defaults, clamping on read, the bounds the PUT refuses at.</summary>
public sealed class PlaySettingsTests
{
    private static TenantSettingsView View() =>
        new(15, 8m, 30m, 5, 15, 14, "UTC", 1.6m, 100m, 1000m, 60, "16:00-19:00", 1, 2, 0, 1440, 7, ButtonMap.Default());

    [Fact]
    public void The_defaults_are_the_spec_s()
    {
        var s = View();
        Assert.Equal(48, PlaySettings.AutoConfirmHours(s));
        Assert.Equal(7, PlaySettings.RecordDays(s));
        Assert.Equal(4, PlaySettings.RestEveryWeeks(s));
        Assert.Equal(2, PlaySettings.RestCap(s));
        Assert.Equal(8, PlaySettings.PauseWeeksPerYear(s));
        Assert.Equal(420, PlaySettings.EarlyBirdBeforeMinute(s));
        Assert.Equal(1260, PlaySettings.NightOwlFromMinute(s));
    }

    [Fact]
    public void A_hand_edited_value_is_clamped_on_read()
    {
        var low = View() with
        {
            ResultAutoConfirmHours = 1, ResultRecordDays = 0, StreakRestEveryWeeks = 1, StreakRestCap = -3,
            StreakPauseWeeksPerYear = -1, PlayEarlyBirdBeforeMinute = -5, PlayNightOwlFromMinute = 60,
        };
        Assert.Equal((12, 1, 2, 0, 0, 0, 720), (PlaySettings.AutoConfirmHours(low), PlaySettings.RecordDays(low), PlaySettings.RestEveryWeeks(low),
            PlaySettings.RestCap(low), PlaySettings.PauseWeeksPerYear(low), PlaySettings.EarlyBirdBeforeMinute(low), PlaySettings.NightOwlFromMinute(low)));

        var high = View() with
        {
            ResultAutoConfirmHours = 1000, ResultRecordDays = 99, StreakRestEveryWeeks = 50, StreakRestCap = 9,
            StreakPauseWeeksPerYear = 60, PlayEarlyBirdBeforeMinute = 2000, PlayNightOwlFromMinute = 5000,
        };
        Assert.Equal((168, 30, 12, 4, 26, 720, 1439), (PlaySettings.AutoConfirmHours(high), PlaySettings.RecordDays(high), PlaySettings.RestEveryWeeks(high),
            PlaySettings.RestCap(high), PlaySettings.PauseWeeksPerYear(high), PlaySettings.EarlyBirdBeforeMinute(high), PlaySettings.NightOwlFromMinute(high)));
    }

    [Fact]
    public void The_bounds_table_names_all_seven_keys_once()
    {
        Assert.Equal(
            ["result_autoconfirm_hours", "result_record_days", "streak_rest_every_weeks", "streak_rest_cap", "streak_pause_weeks_per_year",
             "play_early_bird_before_minute", "play_night_owl_from_minute"],
            PlaySettings.Bounds.Select(b => b.Key));
        Assert.Equal(new StreakRules(4, 2, 8), PlaySettings.StreakRulesOf(View()));
    }
}
