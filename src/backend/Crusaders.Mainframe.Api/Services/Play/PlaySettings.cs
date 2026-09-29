namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The seven play numbers (D14, <c>docs/specs/play.md</c> §6.4), each a tenant setting, clamped on
/// read and bounded on the settings PUT from these same constants — the <see cref="PlayerSettings"/>
/// split, because the PUT is not the only way a number reaches the column.
/// </summary>
public static class PlaySettings
{
    public const string AutoConfirmHoursKey = "result_autoconfirm_hours";
    public const string RecordDaysKey = "result_record_days";
    public const string RestEveryWeeksKey = "streak_rest_every_weeks";
    public const string RestCapKey = "streak_rest_cap";
    public const string PauseWeeksPerYearKey = "streak_pause_weeks_per_year";
    public const string EarlyBirdBeforeMinuteKey = "play_early_bird_before_minute";
    public const string NightOwlFromMinuteKey = "play_night_owl_from_minute";

    /// <summary>Hours a pending result waits for the other side before silence confirms it.</summary>
    public const int DefaultAutoConfirmHours = 48;
    public const int MinAutoConfirmHours = 12;
    public const int MaxAutoConfirmHours = 168;

    /// <summary>Days after a booking's end that a result may still be recorded.</summary>
    public const int DefaultRecordDays = 7;
    public const int MinRecordDays = 1;
    public const int MaxRecordDays = 30;

    /// <summary>Attended weeks in a run that earn one rest week.</summary>
    public const int DefaultRestEveryWeeks = 4;
    public const int MinRestEveryWeeks = 2;
    public const int MaxRestEveryWeeks = 12;

    /// <summary>Rest weeks a member may hold at once. Zero turns rest weeks off.</summary>
    public const int DefaultRestCap = 2;
    public const int MinRestCap = 0;
    public const int MaxRestCap = 4;

    /// <summary>Paused-and-not-attended weeks allowed per club year. Zero turns pausing off.</summary>
    public const int DefaultPauseWeeksPerYear = 8;
    public const int MinPauseWeeksPerYear = 0;
    public const int MaxPauseWeeksPerYear = 26;

    /// <summary>A session starting before this club-local minute earns "Early bird" (07:00).</summary>
    public const int DefaultEarlyBirdBeforeMinute = 7 * 60;
    public const int MinEarlyBirdBeforeMinute = 0;
    public const int MaxEarlyBirdBeforeMinute = 12 * 60;

    /// <summary>A session starting at or after this club-local minute earns "Night owl" (21:00).</summary>
    public const int DefaultNightOwlFromMinute = 21 * 60;
    public const int MinNightOwlFromMinute = 12 * 60;
    public const int MaxNightOwlFromMinute = (24 * 60) - 1;

    public static int AutoConfirmHours(TenantSettingsView s) =>
        Math.Clamp(s.ResultAutoConfirmHours, MinAutoConfirmHours, MaxAutoConfirmHours);

    public static int RecordDays(TenantSettingsView s) => Math.Clamp(s.ResultRecordDays, MinRecordDays, MaxRecordDays);

    public static int RestEveryWeeks(TenantSettingsView s) =>
        Math.Clamp(s.StreakRestEveryWeeks, MinRestEveryWeeks, MaxRestEveryWeeks);

    public static int RestCap(TenantSettingsView s) => Math.Clamp(s.StreakRestCap, MinRestCap, MaxRestCap);

    public static int PauseWeeksPerYear(TenantSettingsView s) =>
        Math.Clamp(s.StreakPauseWeeksPerYear, MinPauseWeeksPerYear, MaxPauseWeeksPerYear);

    public static int EarlyBirdBeforeMinute(TenantSettingsView s) =>
        Math.Clamp(s.PlayEarlyBirdBeforeMinute, MinEarlyBirdBeforeMinute, MaxEarlyBirdBeforeMinute);

    public static int NightOwlFromMinute(TenantSettingsView s) =>
        Math.Clamp(s.PlayNightOwlFromMinute, MinNightOwlFromMinute, MaxNightOwlFromMinute);

    /// <summary>Every bound, for the settings PUT and its test: (key, min, max).</summary>
    public static readonly IReadOnlyList<(string Key, int Min, int Max)> Bounds =
    [
        (AutoConfirmHoursKey, MinAutoConfirmHours, MaxAutoConfirmHours),
        (RecordDaysKey, MinRecordDays, MaxRecordDays),
        (RestEveryWeeksKey, MinRestEveryWeeks, MaxRestEveryWeeks),
        (RestCapKey, MinRestCap, MaxRestCap),
        (PauseWeeksPerYearKey, MinPauseWeeksPerYear, MaxPauseWeeksPerYear),
        (EarlyBirdBeforeMinuteKey, MinEarlyBirdBeforeMinute, MaxEarlyBirdBeforeMinute),
        (NightOwlFromMinuteKey, MinNightOwlFromMinute, MaxNightOwlFromMinute),
    ];

    /// <summary>The streak rule's three numbers, clamped, as the pure walk takes them.</summary>
    public static StreakRules StreakRulesOf(TenantSettingsView s) =>
        new(RestEveryWeeks(s), RestCap(s), PauseWeeksPerYear(s));
}
