namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Every action the club's own change record can carry, stated once and in full — the
/// <see cref="DoorAuditActions"/> discipline applied to a second vocabulary.
///
/// <para>
/// <b>The headline is composed on the SERVER from this list</b>, never by a console holding its
/// own dictionary. That is the lesson <see cref="DoorAuditActions"/> is named after: a frontend
/// dictionary that has not heard of an action falls through to whichever branch is first, and a
/// door with thirteen admin edits read "13 refused scans". An action this vocabulary has no
/// word for renders as <see cref="Unrecognised"/> with a neutral sentence naming the raw
/// action — never a guessed one.
/// </para>
///
/// <para>
/// <b><see cref="DoorAuditActions"/> is deliberately not extended.</b> None of these is a door
/// action, and mixing the two vocabularies is the defect that type exists to prevent.
/// </para>
/// </summary>
public static class AdminChangeActions
{
    // ---- schedule ----
    public const string ScheduleCreated = "schedule.created";
    public const string ScheduleUpdatedFuture = "schedule.updated_future";
    public const string ScheduleOccurrenceSkipped = "schedule.occurrence_skipped";
    public const string ScheduleOccurrenceOverridden = "schedule.occurrence_overridden";
    public const string ScheduleEnded = "schedule.ended";

    // ---- booking ----
    public const string BookingsBulkCancelled = "bookings.bulk_cancelled";
    public const string BookingsBulkBooked = "bookings.bulk_booked";
    public const string BookingCancelledByAdmin = "booking.cancelled_by_admin";
    public const string BookingBlocked = "booking.blocked";
    public const string BookingBlockLifted = "booking.block_lifted";

    // ---- credit ----
    public const string CreditAdjusted = "credit.adjusted";
    public const string CreditToppedUp = "credit.topped_up";

    // ---- group ----
    public const string GroupCreated = "group.created";
    public const string GroupUpdated = "group.updated";
    public const string GroupArchived = "group.archived";
    public const string GroupMembersChanged = "group.members_changed";

    // ---- member ----
    public const string MemberClassChanged = "member.class_changed";
    public const string MemberApproved = "member.approved";
    public const string MemberRejected = "member.rejected";
    public const string MemberSuspended = "member.suspended";
    public const string MemberReactivated = "member.reactivated";
    public const string MemberPasswordReset = "member.password_reset";

    /// <summary>
    /// A member was made an administrator, or stopped being one (R20).
    ///
    /// <para>
    /// <b>In THIS table, not only in <c>audit_log</c>.</b> Who can administer the club is the
    /// one change that can be used to hide every other change: an admin who appoints an
    /// accomplice, or quietly removes the colleague who would notice, has changed who reads this
    /// record. <c>audit_log</c> has a delete path; this table does not. The revoke carries a
    /// reason because "why was I removed?" is the question the club will actually be asked.
    /// </para>
    /// </summary>
    public const string MemberAdminGranted = "member.admin_granted";

    /// <inheritdoc cref="MemberAdminGranted"/>
    public const string MemberAdminRevoked = "member.admin_revoked";

    /// <summary>
    /// An admin looked at one member's night.
    ///
    /// <para>
    /// <b>The privacy record, and the reason it is in THIS table.</b> The trace is the most
    /// surveillance-capable surface in the product, and a surveillance-capable surface whose
    /// access log can be deleted is not audited. <c>audit_log</c> has a delete path; this table
    /// does not.
    /// </para>
    /// </summary>
    public const string MemberTraceViewed = "member.trace_viewed";

    // ---- setting ----
    public const string SettingsUpdated = "settings.updated";
    public const string CourtCreated = "court.created";
    public const string CourtUpdated = "court.updated";
    public const string CourtDeactivated = "court.deactivated";

    /// <summary>
    /// An admin downloaded the club's change record.
    ///
    /// <para>
    /// <b>Not in D2's original list, and added deliberately rather than reusing
    /// <see cref="SettingsUpdated"/>.</b> An export is a thing that happened to the club's
    /// records and it is not a settings change; filing it as one would make the record lie
    /// about itself in the one table designed to be trusted. The door log already audits its
    /// own export for the same reason.
    /// </para>
    /// </summary>
    public const string ChangesExported = "changes.exported";

    // ---- device ----
    public const string DeviceUpdated = "device.updated";
    public const string DeviceDeleted = "device.deleted";
    public const string DeviceApiKeyRegenerated = "device.api_key_regenerated";
    public const string DoorsShutAll = "doors.shut_all";
    public const string DoorsReopenedAll = "doors.reopened_all";
    public const string MonitoringErrorResolved = "monitoring.error_resolved";

    /// <summary>
    /// What a row whose action this vocabulary does not know renders as. Not stored — a writer
    /// always names a real action — but returned by <see cref="Headline"/> so a console never
    /// has to guess, and so a future writer that forgets to extend this list produces a neutral
    /// sentence rather than somebody else's.
    /// </summary>
    public const string Unrecognised = "unrecognised";

    /// <summary>Every action above, in area order. Pinned against <see cref="AreaOf"/> by a test.</summary>
    public static readonly string[] All =
    [
        ScheduleCreated, ScheduleUpdatedFuture, ScheduleOccurrenceSkipped, ScheduleOccurrenceOverridden, ScheduleEnded,
        BookingsBulkCancelled, BookingsBulkBooked, BookingCancelledByAdmin, BookingBlocked, BookingBlockLifted,
        CreditAdjusted, CreditToppedUp,
        GroupCreated, GroupUpdated, GroupArchived, GroupMembersChanged,
        MemberClassChanged, MemberApproved, MemberRejected, MemberSuspended, MemberReactivated,
        MemberPasswordReset, MemberTraceViewed, MemberAdminGranted, MemberAdminRevoked,
        SettingsUpdated, CourtCreated, CourtUpdated, CourtDeactivated, ChangesExported,
        DeviceUpdated, DeviceDeleted, DeviceApiKeyRegenerated, DoorsShutAll, DoorsReopenedAll, MonitoringErrorResolved,
    ];

    /// <summary>
    /// The actions that MUST carry a reason. Destructive, in the sense that matters to a club:
    /// somebody's court, somebody's money or somebody's privacy went away, and "why" is the
    /// only part of that a record can still answer six months later.
    /// </summary>
    public static readonly string[] ReasonRequired =
    [
        BookingsBulkCancelled, BookingCancelledByAdmin, ScheduleEnded, ScheduleOccurrenceSkipped,
        CreditAdjusted, CreditToppedUp, GroupArchived, MemberSuspended, MemberRejected, CourtDeactivated,
        DeviceDeleted, MemberAdminRevoked,
    ];

    /// <summary>The area an action belongs to, or null when the action is not one of ours.</summary>
    public static string? AreaOf(string action)
    {
        // Block body rather than an expression body, for the lizard reason in
        // memory/gotchas.md. lizard's C# parser cannot follow `=> x switch { … }`: it
        // loses scope and emits a *global* pseudo-function spanning the whole FILE,
        // which then trips the 200-line function gate on any file long enough to
        // matter. A block body parses cleanly and costs two lines.
        return action switch
        {
            ScheduleCreated or ScheduleUpdatedFuture or ScheduleOccurrenceSkipped
                or ScheduleOccurrenceOverridden or ScheduleEnded => AdminChangeAreas.Schedule,
            BookingsBulkCancelled or BookingsBulkBooked or BookingCancelledByAdmin
                or BookingBlocked or BookingBlockLifted => AdminChangeAreas.Booking,
            CreditAdjusted or CreditToppedUp => AdminChangeAreas.Credit,
            GroupCreated or GroupUpdated or GroupArchived or GroupMembersChanged => AdminChangeAreas.Group,
            MemberClassChanged or MemberApproved or MemberRejected or MemberSuspended
                or MemberReactivated or MemberPasswordReset or MemberTraceViewed
                or MemberAdminGranted or MemberAdminRevoked => AdminChangeAreas.Member,
            SettingsUpdated or CourtCreated or CourtUpdated or CourtDeactivated
                or ChangesExported => AdminChangeAreas.Setting,
            DeviceUpdated or DeviceDeleted or DeviceApiKeyRegenerated or DoorsShutAll
                or DoorsReopenedAll or MonitoringErrorResolved => AdminChangeAreas.Device,
            _ => null,
        };
    }

    /// <summary>
    /// The sentence a volunteer admin reads, composed here rather than in the browser.
    ///
    /// <para>
    /// <paramref name="subjectLabel"/> is woven in where it makes the sentence say something,
    /// and left out where it would repeat itself. An unknown action returns a neutral sentence
    /// naming the raw string — the one thing a dictionary may never do is guess.
    /// </para>
    /// </summary>
    public static string Headline(string action, string? subjectLabel)
    {
        var name = string.IsNullOrWhiteSpace(subjectLabel) ? null : subjectLabel.Trim();
        var of = name is null ? "" : $" — {name}";

        return action switch
        {
            ScheduleCreated => $"Created a repeating schedule{of}",
            ScheduleUpdatedFuture => $"Changed a repeating schedule and its future dates{of}",
            ScheduleOccurrenceSkipped => $"Skipped one date of a repeating schedule{of}",
            ScheduleOccurrenceOverridden => $"Changed the times of one date of a repeating schedule{of}",
            ScheduleEnded => $"Ended a repeating schedule{of}",

            BookingsBulkCancelled => "Cancelled several bookings at once",
            BookingsBulkBooked => "Made several bookings at once",
            BookingCancelledByAdmin => $"Cancelled a booking{of}",
            BookingBlocked => $"Blocked a court{of}",
            BookingBlockLifted => $"Lifted a court block{of}",

            CreditAdjusted => $"Adjusted a member's credits{of}",
            CreditToppedUp => $"Topped up a member's credits{of}",

            GroupCreated => $"Created a member group{of}",
            GroupUpdated => $"Changed a member group{of}",
            GroupArchived => $"Archived a member group{of}",
            GroupMembersChanged => $"Changed who is in a member group{of}",

            MemberClassChanged => $"Changed a member's class{of}",
            MemberApproved => $"Approved a member{of}",
            MemberRejected => $"Rejected an applicant{of}",
            MemberSuspended => $"Suspended a member{of}",
            MemberReactivated => $"Reactivated a member{of}",
            MemberPasswordReset => $"Reset a member's password{of}",
            MemberTraceViewed => $"Looked at one member's activity{of}",
            MemberAdminGranted => $"Made a member an administrator{of}",
            MemberAdminRevoked => $"Removed a member's administrator rights{of}",

            SettingsUpdated => "Changed the club's settings",
            CourtCreated => $"Added a court{of}",
            CourtUpdated => $"Changed a court{of}",
            CourtDeactivated => $"Deactivated a court{of}",
            ChangesExported => "Downloaded the club's change record",

            DeviceUpdated => $"Changed a device{of}",
            DeviceDeleted => $"Removed a device{of}",
            DeviceApiKeyRegenerated => "Regenerated the club's device key",
            DoorsShutAll => "Shut every door at once",
            DoorsReopenedAll => "Reopened the doors",
            MonitoringErrorResolved => $"Marked a device fault as resolved{of}",

            _ => $"Did something this club's records have no word for ({action})",
        };
    }
}
