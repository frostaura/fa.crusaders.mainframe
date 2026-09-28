namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The players-and-splits numbers (D11–D13), each a tenant setting, clamped on read and bounded
/// on the settings PUT from these same constants — the split every settings class here keeps,
/// because the PUT is not the only way a number reaches the column.
/// </summary>
public static class PlayerSettings
{
    public const string ShareLapseHoursKey = "share_lapse_hours";
    public const string ShareReminderHoursKey = "share_reminder_hours";
    public const string ShareReminderMaxKey = "share_reminder_max";
    public const string NudgeLimitKey = "player_nudge_limit";
    public const string DirectorySearchesPerMinuteKey = "directory_searches_per_minute";
    public const string QuietStartMinuteKey = "member_quiet_start_minute";
    public const string QuietEndMinuteKey = "member_quiet_end_minute";
    public const string RecentPartnerDaysKey = "recent_partner_days";
    public const string NotificationRetentionDaysKey = "member_notification_retention_days";

    /// <summary>
    /// Hours after a session's sold end that an unpaid share may still be paid (D11). After it the
    /// share lapses and the organiser's cover stands — there are no debts between members.
    /// </summary>
    public const int DefaultShareLapseHours = 48;
    public const int MinShareLapseHours = 1;
    public const int MaxShareLapseHours = 168;

    /// <summary>Hours between automatic reminders of an unanswered or unpaid share.</summary>
    public const int DefaultShareReminderHours = 24;
    public const int MinShareReminderHours = 6;
    public const int MaxShareReminderHours = 168;

    /// <summary>Automatic reminders per share, ever. Two: one the day after, one before it lapses. Zero switches them off.</summary>
    public const int DefaultShareReminderMax = 2;
    public const int MinShareReminderMax = 0;
    public const int MaxShareReminderMax = 10;

    /// <summary>
    /// Nudges an organiser may send one player in any 24 hours. Two — a nudge is a mail the
    /// partner did not ask for, and Playtomic's weakest point is partners pestered into muting it.
    /// </summary>
    public const int DefaultNudgeLimit = 2;
    public const int MinNudgeLimit = 0;
    public const int MaxNudgeLimit = 10;

    /// <summary>Directory searches one member may make a minute. A directory is a scraping surface.</summary>
    public const int DefaultDirectorySearchesPerMinute = 30;
    public const int MinDirectorySearchesPerMinute = 5;
    public const int MaxDirectorySearchesPerMinute = 120;

    /// <summary>Quiet hours for non-urgent member mail, in club-local minutes of the day: 21:00–07:00. Equal start and end switches them off.</summary>
    public const int DefaultQuietStartMinute = 21 * 60;
    public const int DefaultQuietEndMinute = 7 * 60;
    public const int MinQuietMinute = 0;
    public const int MaxQuietMinute = (24 * 60) - 1;

    /// <summary>How far back "recent partners" looks — 90 days of accepted games.</summary>
    public const int DefaultRecentPartnerDays = 90;
    public const int MinRecentPartnerDays = 7;
    public const int MaxRecentPartnerDays = 365;

    /// <summary>Days a READ inbox line is kept. Unread lines are never pruned by age.</summary>
    public const int DefaultNotificationRetentionDays = 180;
    public const int MinNotificationRetentionDays = 7;
    public const int MaxNotificationRetentionDays = 730;

    public static int ShareLapseHours(TenantSettingsView s) => Math.Clamp(s.ShareLapseHours, MinShareLapseHours, MaxShareLapseHours);

    public static int ShareReminderHours(TenantSettingsView s) =>
        Math.Clamp(s.ShareReminderHours, MinShareReminderHours, MaxShareReminderHours);

    public static int ShareReminderMax(TenantSettingsView s) =>
        Math.Clamp(s.ShareReminderMax, MinShareReminderMax, MaxShareReminderMax);

    public static int NudgeLimit(TenantSettingsView s) => Math.Clamp(s.PlayerNudgeLimit, MinNudgeLimit, MaxNudgeLimit);

    public static int DirectorySearchesPerMinute(TenantSettingsView s) =>
        Math.Clamp(s.DirectorySearchesPerMinute, MinDirectorySearchesPerMinute, MaxDirectorySearchesPerMinute);

    public static int QuietStartMinute(TenantSettingsView s) => Math.Clamp(s.MemberQuietStartMinute, MinQuietMinute, MaxQuietMinute);

    public static int QuietEndMinute(TenantSettingsView s) => Math.Clamp(s.MemberQuietEndMinute, MinQuietMinute, MaxQuietMinute);

    public static int RecentPartnerDays(TenantSettingsView s) =>
        Math.Clamp(s.RecentPartnerDays, MinRecentPartnerDays, MaxRecentPartnerDays);

    public static int NotificationRetentionDays(TenantSettingsView s) =>
        Math.Clamp(s.MemberNotificationRetentionDays, MinNotificationRetentionDays, MaxNotificationRetentionDays);

    /// <summary>
    /// The instant after which a seat's share can no longer be paid: the SOLD end plus the lapse
    /// hours. Sold rather than <c>EndsAt</c>, because the no-show sweep truncates <c>EndsAt</c>
    /// and a partner's deadline must not move because the organiser did not turn up.
    /// </summary>
    public static DateTimeOffset ShareDeadline(Domain.Booking booking, TenantSettingsView s) =>
        BookingService.OriginalEndsAt(booking).AddHours(ShareLapseHours(s));

    /// <summary>
    /// When non-urgent member mail staged at <paramref name="at"/> may leave: <paramref name="at"/>
    /// itself outside quiet hours, else the quiet window's end in the club's own clock.
    /// </summary>
    public static DateTimeOffset NextSendable(DateTimeOffset at, TenantSettingsView s)
    {
        var start = QuietStartMinute(s);
        var end = QuietEndMinute(s);
        if (start == end) return at;

        var zone = ClubClock.ZoneOf(s);
        var local = TimeZoneInfo.ConvertTime(at, zone);
        var minute = (local.Hour * 60) + local.Minute;
        var quiet = start < end ? minute >= start && minute < end : minute >= start || minute < end;
        if (!quiet) return at;

        // The next local instant at `end` minutes past midnight, today or tomorrow.
        var day = local.Date;
        var candidate = day.AddMinutes(end);
        if (candidate <= local.DateTime) candidate = candidate.AddDays(1);
        var offset = zone.GetUtcOffset(candidate);
        return new DateTimeOffset(candidate, offset).ToUniversalTime();
    }
}
