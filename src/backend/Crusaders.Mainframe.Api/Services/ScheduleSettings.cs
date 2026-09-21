namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The three numbers a repeating schedule runs on, read once and bounded on the way out.
///
/// <para>
/// <b>Same rule as <see cref="DoorSettings"/>, and the first of these is the one that matters.</b>
/// The materialisation horizon must be at least <c>advance_booking_days</c>, or a member can
/// book fourteen days out into a league night that has not been written yet — and the failure
/// appears weeks later, on the night, as a member holding a paid court the club has promised
/// to a division. That is a CROSS-FIELD rule and it is validated on the PUT; this class is the
/// second half of the same promise, because the PUT is not the only way a value reaches the
/// column.
/// </para>
/// </summary>
public static class ScheduleSettings
{
    /// <summary>
    /// How far ahead occurrences are written. Sixty days — two months of a league season, and
    /// comfortably past the fourteen-day default booking horizon.
    /// </summary>
    public const int DefaultMaterialisationDays = 60;

    /// <summary>A week. Below that the horizon is shorter than most clubs' booking window.</summary>
    public const int MinMaterialisationDays = 7;

    /// <summary>A year, past which an open-ended weekly series is writing thousands of rows nobody has looked at.</summary>
    public const int MaxMaterialisationDays = 365;

    /// <summary>
    /// Most rows one schedule change may create or cancel at once. Two thousand.
    ///
    /// <para>
    /// A bound on the CHANGE rather than on the schedule: a club correcting a typo in a
    /// season-long league night touches every unstarted occurrence on every court, and the
    /// number that makes that safe is the number of rows, not the number of weeks.
    /// </para>
    /// </summary>
    public const int DefaultMaxRowsPerChange = 2000;

    public const int MinMaxRowsPerChange = 100;

    public const int MaxMaxRowsPerChange = 20_000;

    /// <summary>How often the worker tops the horizon up. Fifteen minutes.</summary>
    public const int DefaultWorkerIntervalSeconds = 900;

    /// <summary>A minute. Faster than that is a sweep of every tenant's schedules for no gain.</summary>
    public const int MinWorkerIntervalSeconds = 60;

    /// <summary>An hour, past which a horizon that has stalled stays stalled for a working day.</summary>
    public const int MaxWorkerIntervalSeconds = 3600;

    /// <summary>Most active schedules one club may hold. Beyond this the calendar is not a calendar.</summary>
    public const int MaxActiveSchedules = 64;

    /// <summary>The refusal when the booking horizon reaches past the materialisation horizon.</summary>
    public const string AdvanceDaysExceedHorizon = "advance_days_exceed_schedule_horizon";

    /// <summary>The club's materialisation horizon in days, clamped to the range its own PUT declares.</summary>
    public static int MaterialisationDays(TenantSettingsView settings)
        => Math.Clamp(settings.ScheduleMaterialisationDays, MinMaterialisationDays, MaxMaterialisationDays);

    /// <summary>Most rows one schedule change may touch, clamped.</summary>
    public static int MaxRowsPerChange(TenantSettingsView settings)
        => Math.Clamp(settings.ScheduleMaxRowsPerChange, MinMaxRowsPerChange, MaxMaxRowsPerChange);

    /// <summary>
    /// The tick a club with no settings row of its own gets — the documented default, as a
    /// TimeSpan.
    ///
    /// <para>
    /// The worker needs an interval before it has read any club's settings (and again if the
    /// sweep throws before it reads one), and constructing an empty <c>TenantSettingsView</c>
    /// for that is not possible — it is a positional record with nineteen required members. One
    /// named constant rather than a literal in the worker, so the default cannot drift from the
    /// one the accessor falls back to.
    /// </para>
    /// </summary>
    public static readonly TimeSpan DefaultWorkerInterval = TimeSpan.FromSeconds(DefaultWorkerIntervalSeconds);

    /// <summary>The worker's tick, clamped.</summary>
    public static TimeSpan WorkerInterval(TenantSettingsView settings)
        => TimeSpan.FromSeconds(Math.Clamp(
            settings.ScheduleWorkerIntervalSeconds, MinWorkerIntervalSeconds, MaxWorkerIntervalSeconds));

    /// <summary>
    /// The horizon a club can actually honour: never shorter than its own booking window.
    ///
    /// <para>
    /// The cross-field rule is refused on the PUT, but the two values can also arrive by hand
    /// or in a restored document, and the consequence of the pair being wrong is a member
    /// booking into an unwritten league night. Taking the larger of the two here means the
    /// worst a bad pair costs is some extra rows, rather than a court sold twice.
    /// </para>
    /// </summary>
    public static int EffectiveHorizonDays(TenantSettingsView settings)
        => Math.Max(MaterialisationDays(settings), Math.Max(settings.AdvanceBookingDays, 0));
}
