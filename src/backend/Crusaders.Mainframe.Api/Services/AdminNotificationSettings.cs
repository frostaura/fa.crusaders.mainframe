namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The admin notifier's four tenant settings, clamped on read for the reason every other
/// settings class here is: the settings PUT is not the only way a number reaches the column, and
/// one of these names a cutoff the notifier DELETES rows against.
///
/// <para>
/// <b>The door's refusal spike is not here.</b> It already had its two numbers
/// (<c>door_refusal_spike_count</c> / <c>_minutes</c>) and the doors tile already raises its flag
/// from them; the notifier reads the same two through <see cref="DoorSettings"/>, so the mail and
/// the flag on the tile can never disagree about what a spike is.
/// </para>
///
/// <para>
/// <b>Nor is the cooldown on a spike.</b> <c>device_alert_cooldown_minutes</c> already says how
/// often any board may mail the club about itself; a spike is a board (or the fleet) mailing the
/// club about itself, so it is bounded by the same number rather than by a second one that a
/// club would have to learn is different.
/// </para>
/// </summary>
public static class AdminNotificationSettings
{
    /// <summary>
    /// Distinct open faults of error severity or worse, seen inside the window, that make a
    /// spike. Five: one board with a bad sensor opens one fault row however often it repeats, so
    /// five is five different things going wrong at once.
    /// </summary>
    public const int DefaultFaultSpikeCount = 5;

    public const int MinFaultSpikeCount = 2;
    public const int MaxFaultSpikeCount = 100;

    /// <summary>The window those faults must fall inside, minutes.</summary>
    public const int DefaultFaultSpikeMinutes = 15;

    public const int MinFaultSpikeMinutes = 5;
    public const int MaxFaultSpikeMinutes = 240;

    /// <summary>
    /// How long an application may wait before the admins are reminded about it. A day, which
    /// is also what the applicant is told to expect ("a day or two").
    /// </summary>
    public const int DefaultApplicationReminderHours = 24;

    public const int MinApplicationReminderHours = 1;
    public const int MaxApplicationReminderHours = 168;

    /// <summary>
    /// Days a finished notice stays on the admin feed before it is deleted. Pending notices are
    /// never deleted by age — a notice nobody has been told about yet is not history.
    /// </summary>
    public const int DefaultRetentionDays = 90;

    public const int MinRetentionDays = 7;
    public const int MaxRetentionDays = 730;

    public static int FaultSpikeCount(TenantSettingsView s) =>
        Math.Clamp(s.FaultSpikeCount, MinFaultSpikeCount, MaxFaultSpikeCount);

    public static int FaultSpikeMinutes(TenantSettingsView s) =>
        Math.Clamp(s.FaultSpikeMinutes, MinFaultSpikeMinutes, MaxFaultSpikeMinutes);

    public static int ApplicationReminderHours(TenantSettingsView s) =>
        Math.Clamp(s.ApplicationReminderHours, MinApplicationReminderHours, MaxApplicationReminderHours);

    public static int RetentionDays(TenantSettingsView s) =>
        Math.Clamp(s.AdminNotificationRetentionDays, MinRetentionDays, MaxRetentionDays);

    /// <summary>
    /// How long after one spike mail another of the same scope is withheld: the club's
    /// <c>device_alert_cooldown_minutes</c>, clamped exactly as the outage sweep clamps it.
    /// </summary>
    public static TimeSpan SpikeCooldown(TenantSettingsView s) =>
        TimeSpan.FromMinutes(Math.Clamp(
            s.DeviceAlertCooldownMinutes,
            TenantSettingsView.MinDeviceAlertCooldownMinutes,
            TenantSettingsView.MaxDeviceAlertCooldownMinutes));
}
