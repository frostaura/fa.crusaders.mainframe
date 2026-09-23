namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The admin notifier's six tenant settings, clamped on read for the reason every other
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
/// <b>The two cooldowns an admin's own traffic is bounded by are here.</b> Top-up failures of one
/// reason, and one admin overdrawing one member, were constant windows (30 and 15 minutes) on the
/// argument that they bound how often one admin can mail every colleague rather than how a club
/// runs. They are still numbers a club may reasonably want different — a club with one admin who
/// wants to see every overdraft, a club whose gateway flaps for an hour at a time — and every
/// configurable number is a tenant setting, so they are <c>topup_failure_cooldown_minutes</c> and
/// <c>overdraft_cooldown_minutes</c>. The floors keep the reason they were constants: neither can
/// be set to zero, so neither can be turned into a mail per event.
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

    /// <summary>
    /// Minutes inside which top-up failures of one reason are one mail. Half an hour: a gateway
    /// having a bad quarter of an hour fails every member who tries, and the club needs to hear
    /// it once. The floor is five so a failing gateway cannot become a mail per member.
    /// </summary>
    public const int DefaultTopUpFailureCooldownMinutes = 30;

    public const int MinTopUpFailureCooldownMinutes = 5;
    public const int MaxTopUpFailureCooldownMinutes = 1440;

    /// <summary>
    /// Minutes inside which one admin overdrawing one member is one mail. A quarter of an hour: a
    /// bulk booking of twenty courts below zero is one decision, and twenty mails to every
    /// colleague would teach them to ignore the kind that exists so they will not.
    /// </summary>
    public const int DefaultOverdraftCooldownMinutes = 15;

    public const int MinOverdraftCooldownMinutes = 1;
    public const int MaxOverdraftCooldownMinutes = 240;

    public static int FaultSpikeCount(TenantSettingsView s) =>
        Math.Clamp(s.FaultSpikeCount, MinFaultSpikeCount, MaxFaultSpikeCount);

    public static int FaultSpikeMinutes(TenantSettingsView s) =>
        Math.Clamp(s.FaultSpikeMinutes, MinFaultSpikeMinutes, MaxFaultSpikeMinutes);

    public static int ApplicationReminderHours(TenantSettingsView s) =>
        Math.Clamp(s.ApplicationReminderHours, MinApplicationReminderHours, MaxApplicationReminderHours);

    public static int RetentionDays(TenantSettingsView s) =>
        Math.Clamp(s.AdminNotificationRetentionDays, MinRetentionDays, MaxRetentionDays);

    public static int TopUpFailureCooldownMinutes(TenantSettingsView s) =>
        Math.Clamp(s.TopUpFailureCooldownMinutes, MinTopUpFailureCooldownMinutes, MaxTopUpFailureCooldownMinutes);

    public static int OverdraftCooldownMinutes(TenantSettingsView s) =>
        Math.Clamp(s.OverdraftCooldownMinutes, MinOverdraftCooldownMinutes, MaxOverdraftCooldownMinutes);

    /// <summary>The top-up failure window, clamped. Per failure reason — see <c>AdminNotices.TopUpFailed</c>.</summary>
    public static TimeSpan TopUpFailureCooldown(TenantSettingsView s) =>
        TimeSpan.FromMinutes(TopUpFailureCooldownMinutes(s));

    /// <summary>The overdraft window, clamped. Per acting admin and member — see <c>AdminNotices.OverdraftAuthorised</c>.</summary>
    public static TimeSpan OverdraftCooldown(TenantSettingsView s) =>
        TimeSpan.FromMinutes(OverdraftCooldownMinutes(s));

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
