using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The closed vocabulary of IoT fault codes, their severities, and the sentence each one reads
/// as on a club's monitoring page.
///
/// <para>
/// <b>Closed, and deliberately so.</b> An open vocabulary is an admin panel full of strings
/// nobody can act on, and it makes the severity column — the one an admin sorts by — the
/// firmware's opinion rather than the server's. The device wire already normalises and caps a
/// <c>kind</c> at 32 characters; this applies the same discipline to what a fault is called.
/// </para>
///
/// <para>
/// <b>An unrecognised code is recorded as <see cref="Unknown"/> with the raw string in the
/// detail, never dropped.</b> That is <c>DoorAuditActions.UnrecognisedKind</c>'s rule — a feed
/// that silently drops rows is a feed an admin cannot reason about — and it is what stops a
/// firmware release from going dark on the monitoring page the day it ships.
/// </para>
///
/// <para>
/// This type is NOT an extension of <c>DoorAuditActions</c> and must never become one. A
/// board's health is not a door action, and mixing the two vocabularies is the exact defect
/// that type is named after.
/// </para>
/// </summary>
public static class DeviceErrorCodes
{
    // ---- Device-reported (Source = Device) ----
    // The court box's set, per the devices design's closed vocabulary. The names are the
    // firmware's, verbatim: the board sends them in the fault event's `subject` field and a
    // translation layer here would be a second place to get them wrong.

    public const string SerialBadCrc = "serial_badcrc";
    public const string SerialBadFrame = "serial_badframe";
    public const string SerialOverrunRx = "serial_overrun_rx";
    public const string SerialOverrunTx = "serial_overrun_tx";
    public const string SerialBadVerb = "serial_badverb";
    public const string SerialBadArg = "serial_badarg";
    public const string SerialNoCourt = "serial_nocourt";
    public const string MegaLinkLost = "mega_link_lost";
    public const string MegaLinkBack = "mega_link_back";
    public const string OnNotAcked = "on_not_acked";
    public const string ExtRefused = "ext_refused";
    public const string RelayCmdDropped = "relay_cmd_dropped";
    public const string ScanOversize = "scan_oversize";
    public const string ButtonUnauthorised = "button_unauthorised";
    public const string LcdI2cTimeout = "lcd_i2c_timeout";
    public const string LcdResync = "lcd_resync";
    public const string WdtReset = "wdt_reset";
    public const string QueueOverflow = "queue_overflow";
    public const string StoreWriteFailed = "store_write_failed";
    public const string RosterRejected = "roster_rejected";
    public const string Http4xx = "http_4xx";
    public const string Http5xx = "http_5xx";
    public const string HttpTimeout = "http_timeout";
    public const string ApiBreakerOpen = "api_breaker_open";
    public const string HeartbeatRejected = "heartbeat_rejected";
    public const string RestoreFailed = "restore_failed";
    public const string ClockCorrected = "clock_corrected";
    public const string FaultOverflow = "fault_overflow";

    // The door gate's own additions to the shared set.
    public const string ScannerUartError = "scanner_uart_error";
    public const string NvsWriteFailed = "nvs_write_failed";
    public const string UnlockClamped = "unlock_clamped";
    public const string RelockOverdue = "relock_overdue";

    /// <summary>
    /// The board restarted. <b>Recorded at <see cref="DeviceErrorSeverity.Info"/>, and that is
    /// not a downgrade.</b> A boot is not a fault — every board boots — but a board booting
    /// repeatedly is the single clearest signal of a failing power supply, and the count column
    /// is what turns "it rebooted" into "it has rebooted forty times today".
    /// </summary>
    public const string Boot = "boot";

    // ---- Server-detected (Source = Server) ----

    public const string AuthFailed = "auth_failed";
    public const string UnregisteredMac = "unregistered_mac";
    public const string MalformedBody = "malformed_body";
    public const string ClockClamped = "clock_clamped";
    public const string EventRejected = "event_rejected";
    public const string SeqRegression = "seq_regression";
    public const string OutageOpened = "outage_opened";
    public const string CourtNotMapped = "court_not_mapped";
    public const string WalkupRefused = "walkup_refused";
    public const string ActivationRefused = "activation_refused";
    public const string TooManyUnacknowledgedDevices = "too_many_unacknowledged_devices";

    /// <summary>The board's since-boot count of heartbeats it could not push, as a delta. See <c>DeviceErrorService</c>.</summary>
    public const string QueueNoPush = "queue_no_push";

    /// <summary>The board's since-boot count of queued events its ring overwrote, as a delta.</summary>
    public const string QueueEventsLost = "queue_events_lost";

    /// <summary>
    /// The board's restore was served and the following heartbeat said it restored nothing.
    ///
    /// <para>
    /// <b>This is the one an admin must see.</b> It means a court is dark that the club
    /// believes is lit, with a member standing on it who has already been charged.
    /// </para>
    /// </summary>
    public const string RestoreNotConfirmed = "restore_not_confirmed";

    /// <summary>
    /// What a code this server has never heard of is recorded as. The raw string goes into the
    /// row's detail, so a firmware ahead of this server is visible rather than silent.
    /// </summary>
    public const string Unknown = "unknown";

    /// <summary>
    /// The row a board's distinct-fingerprint budget overflows into, carrying
    /// <c>suppressed=&lt;n&gt;</c> in its detail.
    ///
    /// <para>
    /// One row saying "and 412 more we stopped recording — this board is in trouble" is more
    /// useful to an admin than 412 rows, and an unbounded table fed by anything holding the
    /// club key is a denial of service against the club's own monitoring screen.
    /// </para>
    /// </summary>
    public const string ErrorLogOverflow = "error_log_overflow";

    /// <summary>
    /// Severity for a code, assigned here and never by the reporter.
    ///
    /// <para>
    /// Every code in <see cref="All"/> has an entry, which is pinned by a test rather than
    /// trusted: a code added to the vocabulary and forgotten here would silently grade as
    /// <see cref="DeviceErrorSeverity.Error"/> and either shout or hide depending on which
    /// default was chosen.
    /// </para>
    /// </summary>
    public static DeviceErrorSeverity SeverityOf(string code)
    {
        return code switch
        {
        // Critical — the club cannot sell or deliver court time until somebody attends.
        RelayCmdDropped or RestoreFailed or RestoreNotConfirmed or MegaLinkLost => DeviceErrorSeverity.Critical,

        // Error — a board is failing at something it is for.
        SerialBadCrc or SerialBadFrame or SerialOverrunRx or SerialOverrunTx
            or SerialBadVerb or SerialBadArg or SerialNoCourt
            or OnNotAcked or ExtRefused or LcdI2cTimeout
            or WdtReset or StoreWriteFailed or Http5xx or ApiBreakerOpen
            or ScannerUartError or NvsWriteFailed or RelockOverdue
            or AuthFailed or CourtNotMapped or Unknown => DeviceErrorSeverity.Error,

        // Warning — degraded, self-correcting, or a rule the club set being hit.
        LcdResync or QueueOverflow or RosterRejected or Http4xx or HttpTimeout
            or HeartbeatRejected or ClockCorrected or FaultOverflow
            or ScanOversize or ButtonUnauthorised or UnlockClamped
            or UnregisteredMac or MalformedBody or ClockClamped or EventRejected
            or SeqRegression or OutageOpened or WalkupRefused or ActivationRefused
            or TooManyUnacknowledgedDevices or QueueNoPush or QueueEventsLost
            or ErrorLogOverflow => DeviceErrorSeverity.Warning,

        // Info — worth counting, not worth waking anybody.
        MegaLinkBack or Boot => DeviceErrorSeverity.Info,

            _ => DeviceErrorSeverity.Error,
        };
    }

    /// <summary>
    /// The sentence a club reads instead of the code.
    ///
    /// <para>
    /// Composed server-side for the same reason every other headline in this system is: the
    /// audience is club members and volunteer admins who are not good with technology, and
    /// <c>bridge_desync</c> is not a sentence. An unmapped code renders neutrally and carries
    /// the raw string — never a guess at what it might have meant.
    /// </para>
    /// </summary>
    public static string HeadlineOf(string code)
    {
        return code switch
        {
        SerialBadCrc or SerialBadFrame => "The two halves of the court box are garbling each other",
        SerialOverrunRx or SerialOverrunTx => "The court box's internal link is losing messages",
        SerialBadVerb or SerialBadArg or SerialNoCourt => "The court box sent an instruction its other half did not understand",
        MegaLinkLost => "The court box's two halves have stopped talking",
        MegaLinkBack => "The court box's two halves are talking again",
        OnNotAcked => "A lights-on instruction was not acknowledged",
        ExtRefused => "An extra-time instruction was refused",
        RelayCmdDropped => "A lights instruction could not be sent at all",
        ScanOversize => "A scanned code was too long to read",
        ButtonUnauthorised => "A button is being pressed with nobody signed in — it may be stuck",
        LcdI2cTimeout => "The screen stopped answering",
        LcdResync => "The screen had to be restarted",
        WdtReset => "The board restarted itself after locking up",
        QueueOverflow => "The board ran out of room and overwrote its own records",
        StoreWriteFailed => "The board could not save its place",
        RosterRejected => "The board refused part of the booking list it was sent",
        Http4xx => "The club's server refused the board's request",
        Http5xx => "The club's server failed on the board's request",
        HttpTimeout => "The board could not reach the club's server in time",
        ApiBreakerOpen => "The board has stopped trying to reach the club's server",
        HeartbeatRejected => "The board's check-in was refused",
        RestoreFailed => "The board could not switch the lights back on after a power cut",
        RestoreNotConfirmed => "A court should be lit after a power cut and the box has not confirmed it",
        ClockCorrected => "The board's clock was well out and has been corrected",
        FaultOverflow => "The board is reporting more kinds of fault than it can track",
        ScannerUartError => "The door's scanner is sending corrupt data",
        NvsWriteFailed => "The door could not save its settings",
        UnlockClamped => "The door was told to stay open for longer than it allows",
        RelockOverdue => "The door did not lock again when it should have",
        Boot => "The board restarted",
        AuthFailed => "Something tried to talk to the club's server with a bad key",
        UnregisteredMac => "A board the club has not registered tried to check in",
        MalformedBody => "A board sent something the server could not read",
        ClockClamped => "A board's clock was wrong and its times had to be corrected",
        EventRejected => "The server could not accept something a board reported",
        SeqRegression => "A board's record numbering went backwards",
        OutageOpened => "A board stopped reporting",
        CourtNotMapped => "A board lit a relay that is not wired to the court it named",
        WalkupRefused => "A walk-up purchase at the box was refused",
        ActivationRefused => "A member's scan at the box was refused",
        TooManyUnacknowledgedDevices => "More boards are trying to register than the club allows",
        QueueNoPush => "The board could not send some of its check-ins",
        QueueEventsLost => "The board lost some records before it could send them",
        ErrorLogOverflow => "This board is reporting more distinct problems than the club records",
        Unknown => "An error the club's software does not have a name for",
            _ => "An error the club's software does not have a name for",
        };
    }

    /// <summary>Every code this server will ever write, pinned by a test against the severity and headline maps.</summary>
    public static readonly IReadOnlyList<string> All =
    [
        SerialBadCrc, SerialBadFrame, SerialOverrunRx, SerialOverrunTx,
        SerialBadVerb, SerialBadArg, SerialNoCourt,
        MegaLinkLost, MegaLinkBack, OnNotAcked, ExtRefused, RelayCmdDropped,
        ScanOversize, ButtonUnauthorised, LcdI2cTimeout, LcdResync, WdtReset,
        QueueOverflow, StoreWriteFailed, RosterRejected,
        Http4xx, Http5xx, HttpTimeout, ApiBreakerOpen, HeartbeatRejected,
        RestoreFailed, ClockCorrected, FaultOverflow,
        ScannerUartError, NvsWriteFailed, UnlockClamped, RelockOverdue,
        Boot,
        AuthFailed, UnregisteredMac, MalformedBody, ClockClamped, EventRejected,
        SeqRegression, OutageOpened, CourtNotMapped, WalkupRefused, ActivationRefused,
        TooManyUnacknowledgedDevices, QueueNoPush, QueueEventsLost, RestoreNotConfirmed,
        Unknown, ErrorLogOverflow,
    ];

    private static readonly HashSet<string> Known = new(All, StringComparer.Ordinal);

    /// <summary>Whether <paramref name="code"/> is in the closed vocabulary, exactly as stored.</summary>
    public static bool IsKnown(string? code) => code is not null && Known.Contains(code);

    /// <summary>
    /// A reported code as it will be stored: trimmed, ordinal-lower-cased, and
    /// <see cref="Unknown"/> when it is not one this server knows.
    ///
    /// <para>
    /// Ordinal rather than the current culture, for the reason the event endpoint's own
    /// normaliser gives: <c>ToLower()</c> on a Turkish locale maps <c>I</c> to a dotless
    /// <c>ı</c>, so a server's regional settings would decide whether a board's faults were
    /// recognised — the class of bug that is invisible everywhere it is developed.
    /// </para>
    /// </summary>
    public static string Normalise(string? reported)
    {
        var trimmed = reported?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(trimmed)) return Unknown;
        return IsKnown(trimmed) ? trimmed : Unknown;
    }
}
