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

    /// <summary>
    /// An admin booked one court for a member, on that member's wallet (decision R19).
    ///
    /// <para>
    /// <b>One row per on-behalf booking, a batch's items included</b> — written in the booking's
    /// own unit of work and marked <c>part_of_batch</c> when it is one. It used to be suppressed
    /// for a batch in favour of the one <see cref="BookingsBulkBooked"/> row, but that row is
    /// saved after the whole loop: a request that died mid-batch left members charged for
    /// bookings this table said nothing about. The batch row is now the summary, not the record.
    /// </para>
    /// </summary>
    public const string BookingBookedOnBehalf = "booking.booked_on_behalf";

    /// <summary>
    /// A booking took its payer's balance below zero because an admin asked for it by name —
    /// on behalf of a member, or on the admin's OWN wallet, which R19 (2026-09-23) allows.
    ///
    /// <para>
    /// <b>Written for every booking that overdrew</b>, single or batch item, with the balance
    /// before and after. <c>audit_log</c> records the same effect but has a delete path; an
    /// overdraft, and above all an admin's overdraft of their own wallet, is the entry a club
    /// most needs to still be able to read. No reason is demanded: the override is already a
    /// deliberate, named request, and a batch has no per-item reason to give.
    /// </para>
    /// </summary>
    public const string BookingOverdraftAuthorised = "booking.overdraft_authorised";

    // ---- credit ----
    // Admin god mode on a booking's players (D11). Every one moves who plays or who pays.
    public const string BookingPlayerAdded = "booking.player_added";
    public const string BookingPlayerRemoved = "booking.player_removed";
    public const string BookingPlayerAcceptedOnBehalf = "booking.player_accepted_on_behalf";
    public const string BookingShareSettledOutside = "booking.share_settled_outside";
    public const string BookingShareCollected = "booking.share_collected";

    // Stored codes in an append-only table, so they keep "credit" (P13 §2.5); only their words
    // changed: an adjustment of a member's minutes, and a package sold at the desk.
    public const string MinutesAdjusted = "credit.adjusted";
    public const string PackageSold = "credit.topped_up";

    // P13 §4.5: the club's minutes packages. Area credit, subject kind package, none reason-required.
    public const string PackageCreated = "package.created";
    public const string PackageUpdated = "package.updated";
    public const string PackageArchived = "package.archived";

    // ---- group ----
    public const string GroupCreated = "group.created";
    public const string GroupUpdated = "group.updated";
    public const string GroupArchived = "group.archived";
    public const string GroupMembersChanged = "group.members_changed";

    /// <summary>
    /// A member group with no members was deleted outright. Not in D2's original list; added
    /// because a group that vanished with no row here is a change the club cannot see ever
    /// happened. A group WITH members cannot be deleted, only archived.
    /// </summary>
    public const string GroupDeleted = "group.deleted";

    // ---- member ----
    public const string MemberApproved = "member.approved";
    public const string MemberRejected = "member.rejected";
    public const string MemberSuspended = "member.suspended";
    public const string MemberReactivated = "member.reactivated";
    public const string MemberPasswordReset = "member.password_reset";

    /// <summary>
    /// A member's account deleted by the club. One with history is erased in place — the name,
    /// address, photo and every credential wiped, the rows kept so the books still balance — and one
    /// without is removed outright. The row keeps the name the club knew them by, because this
    /// record is where "who was deleted, by whom and why" is answered afterwards. Carries the reason.
    /// </summary>
    public const string MemberDeleted = "member.deleted";

    /// <summary>
    /// The desk reset a member's rotating code — every code their phone could show is dead, every
    /// session ended, passkeys removed unless kept (member-code §10). Review round 1, B6: it wrote
    /// nothing here, so "who signed me out?" had no answer. Carries the desk's reason.
    /// </summary>
    public const string MemberCodeReset = "member.code_reset";

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

    /// <summary>
    /// An admin looked at, or exported, one member's door history (decision D9).
    ///
    /// <para>
    /// <b>In THIS table as well as <c>audit_log</c></b>, for the trace's reason: D9 reversed a
    /// privacy rule, and the reversal is only defensible if who looked cannot be quietly
    /// removed. <c>audit_log</c> has a delete path; this table does not.
    /// </para>
    /// </summary>
    public const string MemberDoorHistoryViewed = "member.door_history_viewed";

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

    /// <summary>
    /// A club webhook added or removed (review round 3, A-5). Filed under settings: it changes
    /// where the club's event stream goes, which is configuration, not a device. There is no
    /// edit, enable, disable or secret-rotate route to record — the admin surface is create and
    /// delete only.
    /// </summary>
    public const string WebhookCreated = "webhook.created";
    public const string WebhookDeleted = "webhook.deleted";

    /// <summary>
    /// An admin moved between the club and its demo club, or wiped the demo's made-up data.
    /// Written into the REAL club's record (never the demo's), so who opened the demo — and when
    /// they came back — is on the record that survives every reset. Settings, because it is the
    /// admin choosing which copy of the app they work in, not anything a member sees.
    /// </summary>
    public const string DemoEntered = "demo.entered";
    public const string DemoLeft = "demo.left";
    public const string DemoReset = "demo.reset";
    /// <summary>The admin flipped to, and back from, the demo club's member view (a plain member of the demo) — written like the others, into the real club's record.</summary>
    public const string DemoMemberViewEntered = "demo.member_view_entered";
    public const string DemoMemberViewLeft = "demo.member_view_left";

    // ---- device ----
    public const string DeviceUpdated = "device.updated";
    public const string DeviceDeleted = "device.deleted";
    public const string DeviceApiKeyRegenerated = "device.api_key_regenerated";
    public const string DoorsShutAll = "doors.shut_all";
    public const string DoorsReopenedAll = "doors.reopened_all";
    public const string MonitoringErrorResolved = "monitoring.error_resolved";

    // Play (D14). A result the club removed, and a disputed result the club kept.
    public const string PlayResultVoided = "play.result_voided";
    public const string PlayResultUpheld = "play.result_upheld";

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
        BookingBookedOnBehalf, BookingOverdraftAuthorised,
        BookingPlayerAdded, BookingPlayerRemoved, BookingPlayerAcceptedOnBehalf, BookingShareSettledOutside, BookingShareCollected,
        MinutesAdjusted, PackageSold, PackageCreated, PackageUpdated, PackageArchived,
        GroupCreated, GroupUpdated, GroupArchived, GroupMembersChanged, GroupDeleted,
        MemberApproved, MemberRejected, MemberSuspended, MemberReactivated, MemberDeleted,
        MemberPasswordReset, MemberCodeReset, MemberTraceViewed, MemberDoorHistoryViewed, MemberAdminGranted, MemberAdminRevoked,
        SettingsUpdated, CourtCreated, CourtUpdated, CourtDeactivated, ChangesExported, WebhookCreated, WebhookDeleted,
        DemoEntered, DemoLeft, DemoReset, DemoMemberViewEntered, DemoMemberViewLeft,
        DeviceUpdated, DeviceDeleted, DeviceApiKeyRegenerated, DoorsShutAll, DoorsReopenedAll, MonitoringErrorResolved,
        PlayResultVoided, PlayResultUpheld,
    ];

    /// <summary>
    /// The actions that MUST carry a reason. Destructive, in the sense that matters to a club:
    /// somebody's court, somebody's money or somebody's privacy went away, and "why" is the
    /// only part of that a record can still answer six months later.
    /// </summary>
    public static readonly string[] ReasonRequired =
    [
        BookingsBulkCancelled, BookingCancelledByAdmin, BookingBlockLifted, ScheduleEnded, ScheduleOccurrenceSkipped,
        MinutesAdjusted, PackageSold, GroupArchived, MemberSuspended, MemberRejected, MemberDeleted, CourtDeactivated,
        DeviceDeleted, MemberAdminRevoked, MemberAdminGranted, MemberCodeReset,
        BookingPlayerRemoved, BookingPlayerAcceptedOnBehalf, BookingShareSettledOutside, BookingShareCollected,
        PlayResultVoided, PlayResultUpheld,
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
                or BookingBlocked or BookingBlockLifted
                or BookingBookedOnBehalf or BookingOverdraftAuthorised
                or BookingPlayerAdded or BookingPlayerRemoved or BookingPlayerAcceptedOnBehalf
                or BookingShareSettledOutside or BookingShareCollected => AdminChangeAreas.Booking,
            MinutesAdjusted or PackageSold
                or PackageCreated or PackageUpdated or PackageArchived => AdminChangeAreas.Money,
            GroupCreated or GroupUpdated or GroupArchived or GroupMembersChanged
                or GroupDeleted => AdminChangeAreas.Group,
            MemberApproved or MemberRejected or MemberSuspended or MemberDeleted
                or MemberReactivated or MemberPasswordReset or MemberCodeReset or MemberTraceViewed
                or MemberDoorHistoryViewed or MemberAdminGranted or MemberAdminRevoked => AdminChangeAreas.Member,
            SettingsUpdated or CourtCreated or CourtUpdated or CourtDeactivated
                or ChangesExported or WebhookCreated or WebhookDeleted
                or DemoEntered or DemoLeft or DemoReset or DemoMemberViewEntered or DemoMemberViewLeft => AdminChangeAreas.Setting,
            DeviceUpdated or DeviceDeleted or DeviceApiKeyRegenerated or DoorsShutAll
                or DoorsReopenedAll or MonitoringErrorResolved => AdminChangeAreas.Device,
            PlayResultVoided or PlayResultUpheld => AdminChangeAreas.Play,
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
            BookingBookedOnBehalf => $"Booked a court for a member{of}",
            BookingOverdraftAuthorised => $"Let a booking take a balance below zero{of}",
            BookingPlayerAdded => $"Added a player to a booking{of}",
            BookingPlayerRemoved => $"Took a player off a booking{of}",
            BookingPlayerAcceptedOnBehalf => $"Accepted a game on a member's behalf{of}",
            BookingShareSettledOutside => $"Recorded a share as paid by hand{of}",
            BookingShareCollected => $"Collected a member's share of a booking{of}",

            MinutesAdjusted => $"Adjusted a member's minutes{of}",
            PackageSold => $"Sold a member a package{of}",
            PackageCreated => $"Created a minutes package{of}",
            PackageUpdated => $"Changed a minutes package{of}",
            PackageArchived => $"Retired a minutes package{of}",   // R9 J9-7: the console's word

            GroupCreated => $"Created a member group{of}",
            GroupUpdated => $"Changed a member group{of}",
            GroupArchived => $"Archived a member group{of}",
            GroupMembersChanged => $"Changed who is in a member group{of}",
            GroupDeleted => $"Deleted a member group{of}",

            MemberApproved => $"Approved a member{of}",
            MemberRejected => $"Rejected an applicant{of}",
            MemberSuspended => $"Suspended a member{of}",
            MemberReactivated => $"Reactivated a member{of}",
            MemberDeleted => $"Deleted a member{of}",
            MemberPasswordReset => $"Gave a member a temporary password{of}",
            MemberCodeReset => $"Reset a member's code and signed them out everywhere{of}",
            MemberTraceViewed => $"Looked at one member's activity{of}",
            MemberDoorHistoryViewed => $"Looked at one member's door history{of}",
            MemberAdminGranted => $"Made a member an administrator{of}",
            MemberAdminRevoked => $"Removed a member's administrator rights{of}",

            SettingsUpdated => "Changed the club's settings",
            CourtCreated => $"Added a court{of}",
            CourtUpdated => $"Changed a court{of}",
            CourtDeactivated => $"Deactivated a court{of}",
            ChangesExported => "Downloaded the club's change record",
            WebhookCreated => $"Added a webhook{of}",
            WebhookDeleted => $"Removed a webhook{of}",
            DemoEntered => "Opened the demo club",
            DemoLeft => "Came back from the demo club",
            DemoReset => "Reset the demo club's made-up data",
            DemoMemberViewEntered => "Opened the demo club as a member",
            DemoMemberViewLeft => "Came back from the demo club's member view",

            DeviceUpdated => $"Changed a device{of}",
            DeviceDeleted => $"Removed a device{of}",
            DeviceApiKeyRegenerated => "Regenerated the club's device key",
            DoorsShutAll => "Shut every door at once",
            DoorsReopenedAll => "Reopened the doors",
            MonitoringErrorResolved => $"Marked a device fault as resolved{of}",

            PlayResultVoided => $"Removed a match result{of}",
            PlayResultUpheld => $"Kept a disputed match result{of}",

            _ => $"Did something this club's records have no word for ({action})",
        };
    }

    /// <summary>
    /// The headline, reading the row's own <c>after</c> where the action alone cannot say it: a
    /// desk sale the club took no rand for — <c>package_free</c>, or a sale recorded at R0.00 — was
    /// GIVEN, not sold (review round 8, E8-5). Every other action reads as <see cref="Headline(string, string?)"/>.
    /// </summary>
    public static string Headline(string action, string? subjectLabel, string? afterJson)
    {
        if (action != PackageSold || !NoChargeSale(afterJson)) return Headline(action, subjectLabel);
        var name = string.IsNullOrWhiteSpace(subjectLabel) ? null : subjectLabel.Trim();
        return name is null ? "Gave a member a package at no charge" : $"Gave a member a package at no charge — {name}";
    }

    /// <summary>Whether a sale's <c>after</c> says nothing was taken. Malformed or older rows read as a sale.</summary>
    private static bool NoChargeSale(string? afterJson)
    {
        if (string.IsNullOrWhiteSpace(afterJson)) return false;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(afterJson);
            var root = doc.RootElement;
            if (root.ValueKind != System.Text.Json.JsonValueKind.Object) return false;
            if (root.TryGetProperty("reason_code", out var code) && code.ValueKind == System.Text.Json.JsonValueKind.String
                && code.GetString() == Endpoints.AdminCreditReasons.PackageFree) return true;
            return root.TryGetProperty("zar_received", out var zar) && zar.ValueKind == System.Text.Json.JsonValueKind.Number
                && zar.GetDecimal() == 0m;
        }
        catch (System.Text.Json.JsonException)
        {
            return false;
        }
    }
}
