using System.Text.Json;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Strongly-typed view over the tenant_settings JSON document.
/// Hard-defaults match the Crusaders working assumptions in the client blueprint Rev 2.
/// </summary>
public sealed class TenantSettingsAccessor
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;

    public TenantSettingsAccessor(MainframeDbContext db, ITenantContext tenant)
    { _db = db; _tenant = tenant; }

    public async Task<TenantSettingsView> GetAsync(CancellationToken ct)
    {
        var row = await _db.TenantSettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == _tenant.TenantId, ct);
        var json = row?.SettingsJson ?? "{}";
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        int sliceMinutes = TryInt(root, "slice_minutes", 15);                       // Blueprint B.4 — 15-minute default for Crusaders.
        decimal slicePrice = TryDecimal(root, "slice_price_credits", 8m);                // Now read as credits per slice.
        decimal penaltyPct = TryDecimal(root, "penalty_pct", 30m);
        int graceMin = TryInt(root, "grace_window_minutes", 5);
        int penaltyMin = TryInt(root, "penalty_window_minutes", 15);
        int advanceDays = TryInt(root, "advance_booking_days", 14);
        int dayStartMinute = TryInt(root, "day_start_minute", 6 * 60);   // 06:00 default — matches AdminConfigEndpoints.
        int dayEndMinute = TryInt(root, "day_end_minute", 22 * 60);      // 22:00 default — matches AdminConfigEndpoints.
        string tz = TryString(root, "timezone", "Africa/Johannesburg");

        // Phase 8 additions per client blueprint Rev 2.
        decimal creditsPerZarRegular = TryDecimal(root, "credits_per_zar_regular", 1.6m);    // A.8 — R100 → 160 credits.
        decimal creditsPerZarLeague = TryDecimal(root, "credits_per_zar_league", 2.4m);      // A.8 — R100 → 240 credits.
        decimal topupBlockZar = TryDecimal(root, "topup_block_zar", 100m);                   // A.3 — block of R100.
        decimal topupMaxZarPerMember = TryDecimal(root, "topup_max_zar_per_member", 1000m);  // A.3 — R1000 cap.
        int memberPerDayMaxMinutes = TryInt(root, "member_per_day_max_minutes", 60);         // A.4 / B.3 — 60 minutes per day per member.
        string peakHours = TryString(root, "peak_hours", "16:00-19:00");                     // A.12 — peak window.
        int peakAdvanceHoursForRegular = TryInt(root, "peak_advance_hours_for_regular", 1);  // A.12 — Regular members may grab a still-empty peak slot within 1h of start.
        int retentionYears = TryInt(root, "retention_years", 2);                             // D.1 — 2-year retention.
        int noShowLookbackDays = TryInt(root, "no_show_lookback_days", 7);                   // How far back the no-show sweep reaches; bounds a first-run backlog.

        // What each of the court box's eight buttons does. The wiring is fixed and the
        // meaning is not; the firmware learns this on the heartbeat. Lenient on read —
        // a settings document somebody hand-edited into nonsense must not stop every
        // box in the club from working. See ButtonMap.
        var buttonMap = ButtonMap.FromSettings(root);

        // The per-weekday opening hours the seeder has always written and NOTHING had
        // ever read. `operating_hours` was referenced in exactly two places in the tree:
        // the seeder that writes it and one validation string. So a Saturday club that
        // shuts at 20:00 sold court time at 21:45, and a member could buy 03:00 on a
        // Sunday through the API — a slot the grid cannot draw, so they could not see it,
        // cancel it, or get it back.
        var operatingHours = OperatingHours.FromSettings(root);

        return new TenantSettingsView(
            sliceMinutes, slicePrice, penaltyPct, graceMin, penaltyMin, advanceDays, tz,
            creditsPerZarRegular, creditsPerZarLeague,
            topupBlockZar, topupMaxZarPerMember,
            memberPerDayMaxMinutes,
            peakHours, peakAdvanceHoursForRegular,
            retentionYears,
            dayStartMinute, dayEndMinute,
            noShowLookbackDays,
            buttonMap)
        {
            // Court-box and identification numbers previously hardcoded around the
            // codebase, pulled into settings per the every-configurable-number
            // invariant. Init-only rather than positional so existing construction
            // sites (and their tests) are untouched.
            WalkUpMaxMinutes = TryInt(root, "walk_up_max_minutes", TenantSettingsView.DefaultWalkUpMaxMinutes),
            HeartbeatSeconds = TryInt(root, "heartbeat_seconds", TenantSettingsView.DefaultHeartbeatSeconds),
            ActivationForwardWindowMinutes = TryInt(root, "activation_forward_window_minutes", TenantSettingsView.DefaultActivationForwardWindowMinutes),
            ActivationCueWindowMinutes = TryInt(root, "activation_cue_window_minutes", TenantSettingsView.DefaultActivationCueWindowMinutes),
            QrLifetimeSeconds = TryInt(root, "qr_lifetime_seconds", TenantSettingsView.DefaultQrLifetimeSeconds),
            RosterWindowMinutes = TryInt(root, "roster_window_minutes", TenantSettingsView.DefaultRosterWindowMinutes),
            OperatingHours = operatingHours,

            // The three door-gate numbers. Same init-only pattern and the same
            // constant-written-once rule as the six above; the policy is the one setting in
            // this document that is a string enum, and the one that fails CLOSED rather than
            // to its default when the stored value is not one of the two — see
            // GateAccessPolicies.FromSettings for why a door is the exception.
            GateUnlockSeconds = TryInt(root, "gate_unlock_seconds", TenantSettingsView.DefaultGateUnlockSeconds),
            GateAccessPolicy = GateAccessPolicies.FromSettings(root),
            GateEarlyEntryMinutes = TryInt(root, "gate_early_entry_minutes", TenantSettingsView.DefaultGateEarlyEntryMinutes),

            // Not a door number: it bounds how often ANY board may mail the club about
            // itself, doors and court boxes alike. It lives beside them because the door is
            // what made the absence of one expensive — auto-registration is unbounded, so a
            // key-holder could mint boards that each alerted every admin.
            DeviceAlertCooldownMinutes = TryInt(
                root, "device_alert_cooldown_minutes", TenantSettingsView.DefaultDeviceAlertCooldownMinutes),

            // The five Wave 1 door settings. Read RAW here, exactly like every other key on
            // this accessor, and bounded by DoorSettings at each reader — which is the whole
            // point: this method's contract is "what the column says", and "what a door may
            // act on" is a different question with a different answer for a hand-edited
            // document. See DoorSettings and door-gate.md §8.
            DoorLogRetentionDays = TryInt(root, "door_log_retention_days", DoorSettings.DefaultLogRetentionDays),
            DoorRefusalSpikeCount = TryInt(root, "door_refusal_spike_count", DoorSettings.DefaultRefusalSpikeCount),
            DoorRefusalSpikeMinutes = TryInt(root, "door_refusal_spike_minutes", DoorSettings.DefaultRefusalSpikeMinutes),
            ClubContactPhone = TryString(root, "club_contact_phone", ""),
            ClubContactEmail = TryString(root, "club_contact_email", ""),

            // The nine numbers the court box's SCREEN runs on, and the three monitoring and
            // seven realtime bounds. Raw here and clamped at each reader (BoxSettings,
            // MonitoringSettings, RealtimeSettings) — the same split as the five door
            // settings above, and for the same reason: this method's contract is "what the
            // column says", and "what a board may act on" is a different question with a
            // different answer for a hand-edited document.
            LcdRevertSeconds = TryInt(root, "lcd_revert_seconds", BoxSettings.DefaultLcdRevertSeconds),
            LcdChoiceSeconds = TryInt(root, "lcd_choice_seconds", BoxSettings.DefaultLcdChoiceSeconds),
            LcdCardSeconds = TryInt(root, "lcd_card_seconds", BoxSettings.DefaultLcdCardSeconds),
            LcdHintSeconds = TryInt(root, "lcd_hint_seconds", BoxSettings.DefaultLcdHintSeconds),
            ScanMemorySeconds = TryInt(root, "scan_memory_seconds", BoxSettings.DefaultScanMemorySeconds),
            ClockTrustMinutes = TryInt(root, "clock_trust_minutes", BoxSettings.DefaultClockTrustMinutes),
            RelayRestoreEnabled = TryBool(root, "relay_restore_enabled", BoxSettings.DefaultRelayRestoreEnabled),
            DeviceFaultReporting = TryBool(root, "device_fault_reporting", BoxSettings.DefaultDeviceFaultReporting),
            DeviceFaultMaxPerHour = TryInt(root, "device_fault_max_per_hour", BoxSettings.DefaultDeviceFaultMaxPerHour),

            DeviceErrorRetentionDays = TryInt(root, "device_error_retention_days", MonitoringSettings.DefaultRetentionDays),
            DeviceErrorMaxOpenRows = TryInt(root, "device_error_max_open_rows", MonitoringSettings.DefaultMaxOpenRows),
            DeviceErrorIngestPerMinute = TryInt(root, "device_error_ingest_per_minute", MonitoringSettings.DefaultIngestPerMinute),

            SseKeepAliveSeconds = TryInt(root, "sse_keepalive_seconds", RealtimeSettings.DefaultKeepAliveSeconds),
            ControlBoardResyncSeconds = TryInt(root, "control_board_resync_seconds", RealtimeSettings.DefaultResyncSeconds),
            ControlBoardStaleMultiplier = TryInt(root, "control_board_stale_multiplier", RealtimeSettings.DefaultStaleMultiplier),
            RealtimeFallbackAfterFailures = TryInt(root, "realtime_fallback_after_failures", RealtimeSettings.DefaultFallbackAfterFailures),
            RealtimeFallbackWindowSeconds = TryInt(root, "realtime_fallback_window_seconds", RealtimeSettings.DefaultFallbackWindowSeconds),
            RealtimePollSecondsWallet = TryInt(root, "realtime_poll_seconds_wallet", RealtimeSettings.DefaultPollSecondsWallet),
            RealtimePollSecondsControlBoard = TryInt(root, "realtime_poll_seconds_control_board", RealtimeSettings.DefaultPollSecondsControlBoard),
        };
    }

    /// <summary>
    /// An integer setting, or the default.
    ///
    /// <para>
    /// <b><c>TryGetInt32</c> and not <c>GetInt32</c>, which is a real defect and not tidiness.</b>
    /// The kind check only proves the value is a NUMBER; <c>GetInt32</c> then throws
    /// <c>FormatException</c> on <c>15.5</c> and <c>OverflowException</c> on anything past
    /// <c>int.MaxValue</c>. This accessor is read on the heartbeat, on every booking and on
    /// every device event, so one hand-edited or restored-from-backup document containing
    /// <c>{"slice_minutes": 15.5}</c> answered <b>500 to every request in the club</b> — boxes
    /// included — with no way back except an UPDATE on the JSON column. Falling back to the
    /// default keeps the club running on a known-good number and leaves the wrong one visible
    /// on the settings page, which is the failure mode a person can act on.
    /// </para>
    /// </summary>
    private static int TryInt(JsonElement root, string name, int fallback)
        => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i)
            ? i : fallback;

    /// <summary>A decimal setting, or the default. <c>TryGetDecimal</c> for the reason <see cref="TryInt"/> gives.</summary>
    private static decimal TryDecimal(JsonElement root, string name, decimal fallback)
        => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDecimal(out var d)
            ? d : fallback;

    private static string TryString(JsonElement root, string name, string fallback)
        => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? fallback : fallback;

    /// <summary>
    /// A boolean setting, or the default.
    ///
    /// <para>
    /// Strict about the JSON kind: a document holding the STRING <c>"false"</c> falls back to
    /// the default rather than being coerced, because the two plausible coercions disagree
    /// (<c>bool.Parse</c> says false, truthiness says true) and a setting that silently turns
    /// the relay restore off is a court that stays dark after a power cut.
    /// </para>
    /// </summary>
    private static bool TryBool(JsonElement root, string name, bool fallback)
        => root.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? v.GetBoolean() : fallback;
}

public sealed record TenantSettingsView(
    int SliceMinutes,
    decimal DefaultSlicePriceCredits,           // Unit is credits per blueprint A.8/A.9. Legacy field name kept.
    decimal PenaltyPct,
    int GraceWindowMinutes,
    int PenaltyWindowMinutes,
    int AdvanceBookingDays,
    string Timezone,
    decimal CreditsPerZarRegular,
    decimal CreditsPerZarLeague,
    decimal TopupBlockZar,
    decimal TopupMaxZarPerMember,
    int MemberPerDayMaxMinutes,
    string PeakHoursRange,
    int PeakAdvanceHoursForRegular,
    int RetentionYears,
    int DayStartMinute,
    int DayEndMinute,
    int NoShowLookbackDays,
    ButtonMap Buttons)
{
    // ---- Init-only additions (WI-2) ----
    //
    // Added as init-only properties WITH defaults, not positional parameters, so no
    // existing constructor call site anywhere changes. The defaults match what the
    // code hardcoded before each number became a setting, and each is written ONCE,
    // as a constant: the accessor's TryInt fallback and the property initialiser both
    // read it, so the two cannot drift apart the way the settings endpoint's own
    // defaults once did.

    public const int DefaultWalkUpMaxMinutes = RelayHardCap.Minutes;
    public const int DefaultHeartbeatSeconds = 60;
    public const int DefaultActivationForwardWindowMinutes = 120;
    public const int DefaultActivationCueWindowMinutes = 10;
    public const int DefaultQrLifetimeSeconds = 60;
    public const int DefaultRosterWindowMinutes = 120;

    // ---- The bounds, named once ----
    //
    // These four were literals inside AdminConfigEndpoints.ValidateDeviceNumbers and nowhere
    // else, which made them bounds on the PUT rather than bounds on the SETTING. Nothing
    // clamps on the way out — TryInt above reads whatever the column holds — so a
    // hand-edited settings document handed the engine any number at all, and the two that
    // reach a DOOR (see BookingCodeWindow) could stretch a booking code's entry window to
    // forty-eight hours while the spec, the console and GateAccess.MaxEarlyEntryMinutes all
    // said four. Named here so the number an admin is refused at and the number the reader
    // clamps to cannot drift apart.

    /// <summary>Narrowest roster horizon a club may run. Below this a box is fetching a list that is empty before it is used.</summary>
    public const int MinRosterWindowMinutes = 5;

    /// <summary>Widest roster horizon a club may run — a day.</summary>
    public const int MaxRosterWindowMinutes = 1440;

    /// <summary>Widest lights-on cue window a club may run — a day.</summary>
    public const int MaxActivationCueWindowMinutes = 1440;

    /// <summary>Widest back-to-back disambiguation window a club may run — a day.</summary>
    public const int MaxActivationForwardWindowMinutes = 1440;

    // ---- How often a board may mail the club about itself ----

    /// <summary>
    /// How long <c>PeripheralHealthWorker</c> waits before mailing about the same board again.
    /// An hour: long enough that a board flapping on a bad uplink is one message rather than a
    /// hundred, short enough that a real outage is still reported within an admin's morning.
    /// </summary>
    public const int DefaultDeviceAlertCooldownMinutes = 60;

    /// <summary>Shortest cooldown a club may set. Below five minutes the sweep's own thirty-second stride starts to show through.</summary>
    public const int MinDeviceAlertCooldownMinutes = 5;

    /// <summary>Longest cooldown a club may set — a day, after which an outage nobody heard about is an outage nobody will.</summary>
    public const int MaxDeviceAlertCooldownMinutes = 1440;

    // ---- The door-gate numbers ----
    //
    // Three seconds is long enough to push a door and short enough that it has shut again
    // before the next person reaches it. Thirty minutes of early entry is the club's own
    // habit — a member due on court at six arrives at half past five to change — and it is
    // deliberately much longer than activation_cue_window_minutes, because getting into the
    // BUILDING early is ordinary and getting the LIGHTS on early is somebody else's court.
    public const int DefaultGateUnlockSeconds = 3;
    public const string DefaultGateAccessPolicy = GateAccessPolicies.ActiveMember;
    public const int DefaultGateEarlyEntryMinutes = 30;

    /// <summary>The longest walk-up a box may sell, minutes. Bounded above by <see cref="RelayHardCap.Minutes"/>; selling more than the relay can actuate is paying for darkness.</summary>
    public int WalkUpMaxMinutes { get; init; } = DefaultWalkUpMaxMinutes;

    /// <summary>How often a court box should call home, seconds. Was hardcoded 60 in the heartbeat response.</summary>
    public int HeartbeatSeconds { get; init; } = DefaultHeartbeatSeconds;

    /// <summary>How far ahead of a slot an identification can find the booking at all (back-to-back disambiguation window), minutes.</summary>
    public int ActivationForwardWindowMinutes { get; init; } = DefaultActivationForwardWindowMinutes;

    /// <summary>How far ahead of a slot an identification may actually stamp attendance and cue lights, minutes. Must not exceed the forward window.</summary>
    public int ActivationCueWindowMinutes { get; init; } = DefaultActivationCueWindowMinutes;

    /// <summary>Lifetime of a member-ident QR access code, seconds.</summary>
    public int QrLifetimeSeconds { get; init; } = DefaultQrLifetimeSeconds;

    /// <summary>How far ahead the heartbeat roster (and the QR screen's booking lookup) reaches, minutes.</summary>
    public int RosterWindowMinutes { get; init; } = DefaultRosterWindowMinutes;

    /// <summary>
    /// How long a door's lock is released per open, seconds. Clamped again on the way out to
    /// <c>[GateAccess.MinUnlockSeconds, GateAccess.MaxUnlockSeconds]</c>, because the settings
    /// PUT is not the only way a number reaches this column.
    /// </summary>
    public int GateUnlockSeconds { get; init; } = DefaultGateUnlockSeconds;

    /// <summary>
    /// Who may open a door: one of <see cref="GateAccessPolicies.All"/>. A string enum rather
    /// than a boolean because a third policy is foreseeable and a boolean cannot grow one.
    /// </summary>
    public string GateAccessPolicy { get; init; } = DefaultGateAccessPolicy;

    /// <summary>
    /// How long before a booking starts its holder may come into the building, minutes. Reads
    /// two ways and they are the same window on purpose: it is how far ahead of a slot the
    /// gate roster carries it, and it is the window the <c>booking_window</c> policy tests
    /// online. A member let in offline and a member let in online are let in on one rule.
    /// </summary>
    public int GateEarlyEntryMinutes { get; init; } = DefaultGateEarlyEntryMinutes;

    /// <summary>
    /// How long <c>PeripheralHealthWorker</c> waits before mailing the club about the same
    /// board again, minutes. Applies to court boxes and doors alike.
    ///
    /// <para>
    /// Without it the sweep mailed every admin on every transition, with no minimum outage and
    /// no cooldown, so a board on a marginal uplink flapping every few minutes was a mailbox
    /// full of "unreachable" and "back". An alert nobody reads is worse than no alert, because
    /// the club believes it has one.
    /// </para>
    ///
    /// <para>
    /// <b>It is per BOARD, and this comment used to claim more than that.</b> It said the
    /// cooldown also answered the case where "anyone holding the club's device key could mint
    /// boards that each did it", and it does not: twelve invented MACs are twelve boards, each
    /// inside its own first cooldown, so the club still got twelve mails in one tick and the
    /// ceiling was the tenant rate limit. What bounds the FLEET is two other rules —
    /// <c>PeripheralHealthWorker.Mailable</c>, which is silent about any board no admin has
    /// acknowledged, and <c>DeviceRegistryService.MaxUnacknowledgedDevices</c>, which stops
    /// the rows being created at all. This setting bounds a board that is flapping, which is
    /// the different problem it was added for.
    /// </para>
    /// </summary>
    public int DeviceAlertCooldownMinutes { get; init; } = DefaultDeviceAlertCooldownMinutes;

    /// <summary>
    /// When the club is open, per weekday. Empty means "no per-weekday map configured",
    /// in which case <see cref="HoursFor"/> falls back to the flat
    /// <see cref="DayStartMinute"/>/<see cref="DayEndMinute"/> pair the Settings page edits.
    /// </summary>
    public OperatingHours OperatingHours { get; init; } = OperatingHours.Empty;

    // ---- The five Wave 1 door settings ----
    //
    // Raw as stored, like everything else on this record. Every one of them is read through
    // DoorSettings, which is where the bounds live and the only place a reader should take
    // them from; the two strings are trimmed and cut there as well. The defaults are
    // DoorSettings' own constants rather than literals here, so the accessor's fallback and
    // this initialiser cannot drift — the trap the settings endpoint's own defaults fell into
    // once already (AdminSettingsHttpTests.Opening_the_settings_page_and_saving_it_changes_nothing).

    /// <summary>How long a club keeps its door rows, days. Read via <see cref="DoorSettings.LogRetentionDays"/>.</summary>
    public int DoorLogRetentionDays { get; init; } = DoorSettings.DefaultLogRetentionDays;

    /// <summary>Refusals at one door that raise the spike flag. Read via <see cref="DoorSettings.RefusalSpikeCount"/>.</summary>
    public int DoorRefusalSpikeCount { get; init; } = DoorSettings.DefaultRefusalSpikeCount;

    /// <summary>The window those refusals are counted in, minutes. Read via <see cref="DoorSettings.RefusalSpikeMinutes"/>.</summary>
    public int DoorRefusalSpikeMinutes { get; init; } = DoorSettings.DefaultRefusalSpikeMinutes;

    /// <summary>
    /// The number a member refused at a door should ring. Empty by default — a club that has
    /// not set one must not be given an invented one, and the member's page says so in words.
    /// </summary>
    public string ClubContactPhone { get; init; } = "";

    /// <summary>The address a member refused at a door should write to. Empty by default, for the same reason.</summary>
    public string ClubContactEmail { get; init; } = "";

    // ---- The nine numbers delivered to the court box on the heartbeat ----
    //
    // Raw as stored, like everything else on this record, and read through BoxSettings, which
    // is where the bounds live and the only place a reader should take them from. The defaults
    // are BoxSettings' own constants rather than literals here, so the accessor's fallback and
    // this initialiser cannot drift — the trap the settings endpoint's own defaults fell into
    // once already.

    /// <summary>Seconds a decided scan's result holds before the screen reverts (GOAL items 1 and 18). Read via <see cref="BoxSettings.LcdRevertSeconds"/>.</summary>
    public int LcdRevertSeconds { get; init; } = BoxSettings.DefaultLcdRevertSeconds;

    /// <summary>Seconds the court/time selection screens hold. Read via <see cref="BoxSettings.LcdChoiceSeconds"/>.</summary>
    public int LcdChoiceSeconds { get; init; } = BoxSettings.DefaultLcdChoiceSeconds;

    /// <summary>Seconds the member's name card shows. Read via <see cref="BoxSettings.LcdCardSeconds"/>.</summary>
    public int LcdCardSeconds { get; init; } = BoxSettings.DefaultLcdCardSeconds;

    /// <summary>Seconds a one-off hint holds the bottom row. Read via <see cref="BoxSettings.LcdHintSeconds"/>.</summary>
    public int LcdHintSeconds { get; init; } = BoxSettings.DefaultLcdHintSeconds;

    /// <summary>Seconds the box remembers who scanned. Read via <see cref="BoxSettings.ScanMemorySeconds"/>, which also holds it at or above the choice hold.</summary>
    public int ScanMemorySeconds { get; init; } = BoxSettings.DefaultScanMemorySeconds;

    /// <summary>Minutes the box trusts its adopted clock. Read via <see cref="BoxSettings.ClockTrustMinutes"/>.</summary>
    public int ClockTrustMinutes { get; init; } = BoxSettings.DefaultClockTrustMinutes;

    /// <summary>Whether a box may re-energise relays from the heartbeat's restore answer (GOAL item 17).</summary>
    public bool RelayRestoreEnabled { get; init; } = BoxSettings.DefaultRelayRestoreEnabled;

    /// <summary>Whether boards should report faults at all (GOAL item 7).</summary>
    public bool DeviceFaultReporting { get; init; } = BoxSettings.DefaultDeviceFaultReporting;

    /// <summary>Distinct fault reports one board may emit per hour. Read via <see cref="BoxSettings.DeviceFaultMaxPerHour"/>.</summary>
    public int DeviceFaultMaxPerHour { get; init; } = BoxSettings.DefaultDeviceFaultMaxPerHour;

    // ---- The IoT error log's three bounds ----

    /// <summary>Days a club keeps its error rows. Read via <see cref="MonitoringSettings.RetentionDays"/>.</summary>
    public int DeviceErrorRetentionDays { get; init; } = MonitoringSettings.DefaultRetentionDays;

    /// <summary>Distinct open rows one board may hold. Read via <see cref="MonitoringSettings.MaxOpenRows"/>.</summary>
    public int DeviceErrorMaxOpenRows { get; init; } = MonitoringSettings.DefaultMaxOpenRows;

    /// <summary>Reports one board may record per minute. Read via <see cref="MonitoringSettings.IngestPerMinute"/>.</summary>
    public int DeviceErrorIngestPerMinute { get; init; } = MonitoringSettings.DefaultIngestPerMinute;

    // ---- The live streams' seven numbers ----

    /// <summary>Seconds of quiet before a stream writes a <c>ping</c>. Read via <see cref="RealtimeSettings.KeepAlive"/>.</summary>
    public int SseKeepAliveSeconds { get; init; } = RealtimeSettings.DefaultKeepAliveSeconds;

    /// <summary>Seconds between full control-board snapshots. Read via <see cref="RealtimeSettings.ResyncSeconds"/>.</summary>
    public int ControlBoardResyncSeconds { get; init; } = RealtimeSettings.DefaultResyncSeconds;

    /// <summary>Heartbeat intervals of silence that make a light state stale. Read via <see cref="RealtimeSettings.StaleMultiplier"/>.</summary>
    public int ControlBoardStaleMultiplier { get; init; } = RealtimeSettings.DefaultStaleMultiplier;

    /// <summary>Consecutive stream failures after which a client polls instead.</summary>
    public int RealtimeFallbackAfterFailures { get; init; } = RealtimeSettings.DefaultFallbackAfterFailures;

    /// <summary>Seconds a client stays in polling mode before retrying the stream.</summary>
    public int RealtimeFallbackWindowSeconds { get; init; } = RealtimeSettings.DefaultFallbackWindowSeconds;

    /// <summary>Seconds between wallet polls while degraded.</summary>
    public int RealtimePollSecondsWallet { get; init; } = RealtimeSettings.DefaultPollSecondsWallet;

    /// <summary>Seconds between control-board polls while degraded.</summary>
    public int RealtimePollSecondsControlBoard { get; init; } = RealtimeSettings.DefaultPollSecondsControlBoard;

    /// <summary>
    /// The club's open and close for one local weekday, as minutes past local midnight.
    ///
    /// <para>
    /// The per-weekday <c>operating_hours</c> map wins where it names the day; the flat
    /// <c>day_start_minute</c>/<c>day_end_minute</c> pair is the default for every day it
    /// does not. That ordering keeps the existing Settings page meaningful (it edits the
    /// default) without letting it silently override a club that has set real weekend
    /// hours — which is exactly the state the Crusaders seed is in.
    /// </para>
    /// </summary>
    public (int OpenMinute, int CloseMinute) HoursFor(DayOfWeek day)
        => OperatingHours.For(day) ?? (DayStartMinute, DayEndMinute);

    /// <summary>Returns credits-per-rand for a given member class. Defaults to <see cref="CreditsPerZarRegular"/> if unknown.</summary>
    public decimal ConversionRateFor(Crusaders.Mainframe.Api.Domain.MemberClass cls)
        => cls == Crusaders.Mainframe.Api.Domain.MemberClass.LeagueOrSenior ? CreditsPerZarLeague : CreditsPerZarRegular;

    /// <summary>Parses <see cref="PeakHoursRange"/> ("16:00-19:00") into TimeOnly bounds. Returns null on malformed input.</summary>
    public (TimeOnly start, TimeOnly end)? PeakHours()
    {
        var parts = PeakHoursRange.Split('-');
        if (parts.Length != 2) return null;
        if (!TimeOnly.TryParse(parts[0].Trim(), out var s) || !TimeOnly.TryParse(parts[1].Trim(), out var e)) return null;
        return (s, e);
    }
}
