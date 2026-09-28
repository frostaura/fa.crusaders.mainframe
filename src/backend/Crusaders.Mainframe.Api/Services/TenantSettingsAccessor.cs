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
        // credits_per_zar_league is no longer read: the league rate lives on the league group
        // (D2, migration GroupsReplaceClass), and the regular rate is the default for a member
        // whose groups set none.
        decimal topupBlockZar = TryDecimal(root, "topup_block_zar", 100m);                   // A.3 — block of R100.
        decimal topupMaxZarPerMember = TryDecimal(root, "topup_max_zar_per_member", 1000m);  // A.3 — R1000 cap.
        int memberPerDayMaxMinutes = TryInt(root, "member_per_day_max_minutes", 60);         // A.4 / B.3 — 60 minutes per day per member.
        string peakHours = TryString(root, "peak_hours", TenantSettingsView.DefaultPeakHoursRange);  // A.12 — peak window.
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
            creditsPerZarRegular,
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

            // The admin notifier's six (R23). Raw here, bounded by AdminNotificationSettings at
            // each reader, on the split every block above keeps.
            FaultSpikeCount = TryInt(root, "fault_spike_count", AdminNotificationSettings.DefaultFaultSpikeCount),
            FaultSpikeMinutes = TryInt(root, "fault_spike_minutes", AdminNotificationSettings.DefaultFaultSpikeMinutes),
            ApplicationReminderHours = TryInt(
                root, "application_reminder_hours", AdminNotificationSettings.DefaultApplicationReminderHours),
            AdminNotificationRetentionDays = TryInt(
                root, "admin_notification_retention_days", AdminNotificationSettings.DefaultRetentionDays),
            TopUpFailureCooldownMinutes = TryInt(
                root, "topup_failure_cooldown_minutes", AdminNotificationSettings.DefaultTopUpFailureCooldownMinutes),
            OverdraftCooldownMinutes = TryInt(
                root, "overdraft_cooldown_minutes", AdminNotificationSettings.DefaultOverdraftCooldownMinutes),

            // Players and splits (D11–D13). Raw here, bounded by PlayerSettings at each reader.
            ShareLapseHours = TryInt(root, PlayerSettings.ShareLapseHoursKey, PlayerSettings.DefaultShareLapseHours),
            ShareReminderHours = TryInt(root, PlayerSettings.ShareReminderHoursKey, PlayerSettings.DefaultShareReminderHours),
            ShareReminderMax = TryInt(root, PlayerSettings.ShareReminderMaxKey, PlayerSettings.DefaultShareReminderMax),
            PlayerNudgeLimit = TryInt(root, PlayerSettings.NudgeLimitKey, PlayerSettings.DefaultNudgeLimit),
            DirectorySearchesPerMinute = TryInt(
                root, PlayerSettings.DirectorySearchesPerMinuteKey, PlayerSettings.DefaultDirectorySearchesPerMinute),
            MemberQuietStartMinute = TryInt(root, PlayerSettings.QuietStartMinuteKey, PlayerSettings.DefaultQuietStartMinute),
            MemberQuietEndMinute = TryInt(root, PlayerSettings.QuietEndMinuteKey, PlayerSettings.DefaultQuietEndMinute),
            RecentPartnerDays = TryInt(root, PlayerSettings.RecentPartnerDaysKey, PlayerSettings.DefaultRecentPartnerDays),
            MemberNotificationRetentionDays = TryInt(
                root, PlayerSettings.NotificationRetentionDaysKey, PlayerSettings.DefaultNotificationRetentionDays),

            SseKeepaliveSeconds = TryInt(root, "sse_keepalive_seconds", RealtimeSettings.DefaultKeepaliveSeconds),
            ControlBoardResyncSeconds = TryInt(root, "control_board_resync_seconds", RealtimeSettings.DefaultResyncSeconds),
            ControlBoardStaleMultiplier = TryInt(root, "control_board_stale_multiplier", RealtimeSettings.DefaultStaleMultiplier),
            RealtimeFallbackAfterFailures = TryInt(root, "realtime_fallback_after_failures", RealtimeSettings.DefaultFallbackAfterFailures),
            RealtimeFallbackWindowSeconds = TryInt(root, "realtime_fallback_window_seconds", RealtimeSettings.DefaultFallbackWindowSeconds),
            RealtimePollSecondsWallet = TryInt(root, "realtime_poll_seconds_wallet", RealtimeSettings.DefaultPollSecondsWallet),
            RealtimePollSecondsControlBoard = TryInt(root, "realtime_poll_seconds_control_board", RealtimeSettings.DefaultPollSecondsControlBoard),

            // Bounded at BulkSettings, for the same reason the five above are bounded at
            // DoorSettings: this method's contract is "what the column says", and "what an
            // admin bulk action may act on" is a different question with a different answer
            // for a hand-edited document.
            AdminBulkMaxItems = TryInt(root, "admin_bulk_max_items", BulkSettings.DefaultMaxItems),

            // The two night-trace numbers. Raw here and bounded by TraceSettings at the one
            // reader, exactly like the five door settings above — and for a sharper reason: the
            // first of them is the kill switch on the most surveillance-capable surface in the
            // product, so "what the column says" and "what the endpoint may act on" must be two
            // separate questions with one answer each. See TraceSettings.
            MemberTraceEnabled = TryBool(root, "member_trace_enabled", TraceSettings.DefaultEnabled),
            MemberTraceMaxEvents = TryInt(root, "member_trace_max_events", TraceSettings.DefaultMaxEvents),

            // The three schedule numbers. Raw here, bounded at ScheduleSettings — and the
            // horizon is the sharpest case of that rule in this lane, because a horizon
            // shorter than advance_booking_days lets a member book into a league night that
            // has not been written yet, weeks before anyone finds out.
            ScheduleMaterialisationDays = TryInt(
                root, "schedule_materialisation_days", ScheduleSettings.DefaultMaterialisationDays),
            ScheduleMaxRowsPerChange = TryInt(
                root, "schedule_max_rows_per_change", ScheduleSettings.DefaultMaxRowsPerChange),
            ScheduleWorkerIntervalSeconds = TryInt(
                root, "schedule_worker_interval_seconds", ScheduleSettings.DefaultWorkerIntervalSeconds),

            // GOAL item 3 (member groups) and item 19 (slots per day). Raw here like every
            // other key; bounded by BookingLimits and GroupRules at each reader.
            MemberMaxSlotsPerDay = TryInt(root, "member_max_slots_per_day", BookingLimits.DefaultMaxSlotsPerDay),
            SameDayCapRelaxation = TryBool(root, "same_day_cap_relaxation", true),
            SameDayRelaxationWindowMinutes = TryInt(
                root, "same_day_relaxation_window_minutes", BookingLimits.DefaultSameDayRelaxationWindowMinutes),
            WalkUpHonoursDayCap = TryBool(root, "walk_up_honours_day_cap", false),
            MemberGroupsEnabled = TryBool(root, "member_groups_enabled", true),

            // GOAL item 12's glyph set. Read RAW, like every other key; ActionGlyphs is what
            // decides what an unrecognised stored value means.
            ActionGlyphs = TryString(root, ActionGlyphs.Key, ActionGlyphs.Thumbs),

            // The club's money symbol. Read RAW for the same reason; CurrencySymbol is what
            // decides what an unprintable stored value means. It governs RAND only — the
            // reasoning, and the incident behind it, are in that file.
            CurrencySymbol = TryString(root, CurrencySymbol.Key, CurrencySymbol.Default),
        };
    }

    /// <summary>
    /// An integer setting, or the default — <b>never an exception</b>.
    ///
    /// <para>
    /// D2-B18. This was <c>ValueKind == Number ? v.GetInt32() : fallback</c>, and
    /// <c>JsonValueKind.Number</c> is true of <c>15.5</c> and of <c>99999999999</c> — both of
    /// which make <c>GetInt32()</c> <b>throw</b> (<c>FormatException</c> and
    /// <c>OverflowException</c> respectively). This accessor is read on the heartbeat, on every
    /// booking and on every device event, so one hand-edited or restored-from-backup document
    /// containing <c>{"slice_minutes": 15.5}</c> answered <b>500 to every request in the
    /// club</b> — boxes included — with no way back except an UPDATE on the JSON column, in a
    /// file whose own comment above says a broken document "must not stop every box in the club
    /// from working". A club that mistypes one number does not get to have its doors stop
    /// answering.
    /// </para>
    ///
    /// <para>
    /// <c>TryGetInt32</c> is the whole fix, and the same reasoning covers the two below: a key
    /// present with the wrong shape is indistinguishable from an absent one, which is the lesser
    /// of the two evils and the one the rest of this accessor already assumes. Falling back to
    /// the default keeps the club running on a known-good number and leaves the wrong one
    /// visible on the settings page, which is the failure mode a person can act on.
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
    /// Strict about the JSON kind for the same reason the three above are: a document holding
    /// the STRING <c>"false"</c> falls back to the default rather than being coerced, because
    /// the two plausible coercions disagree (<c>bool.Parse</c> says false, truthiness says true)
    /// and a setting that silently turns the relay restore off is a court that stays dark after
    /// a power cut. <c>"true"</c> the string is a client bug, and silently reading it as
    /// <c>true</c> would hide it for as long as the value happened to be the one wanted.
    /// </para>
    /// </summary>
    // Block body, not an expression one: lizard's C# parser reads the `{` of a switch as the
    // END of the function and dumps the rest of the file into a *global* pseudo-function
    // whose length trips `-L 200`. See memory/gotchas.md.
    private static bool TryBool(JsonElement root, string name, bool fallback)
    {
        if (!root.TryGetProperty(name, out var v)) return fallback;
        if (v.ValueKind == JsonValueKind.True) return true;
        if (v.ValueKind == JsonValueKind.False) return false;
        return fallback;
    }
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
    // FIFTEEN seconds, not three (GOAL item 2 — the founder asked for the number by name).
    // Three was chosen as "long enough to push a door", which is true of a person standing in
    // front of it with both hands free and false of the member this club actually has: a
    // racquet bag on one shoulder, a phone held up to a scanner, and a door that has re-locked
    // before they reach it. The cost of a re-lock is a second scan and a member who believes
    // the door is broken; the cost of twelve more seconds is twelve seconds. This moves the
    // DEFAULT only — GateAccess.MaxUnlockSeconds is unchanged at 30, and the firmware's own
    // re-lock dwell and window cap still bound it at the door.
    //
    // Thirty minutes of early entry is the club's own habit — a member due on court at six
    // arrives at half past five to change — and it is deliberately much longer than
    // activation_cue_window_minutes, because getting into the BUILDING early is ordinary and
    // getting the LIGHTS on early is somebody else's court.
    public const int DefaultGateUnlockSeconds = 15;
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
    /// Most items one admin bulk action may carry. Read via <see cref="BulkSettings.MaxItems"/>.
    ///
    /// <para>
    /// Raw as stored, like everything else on this record, and bounded at the reader — a
    /// hand-edited document is not a PUT, and this number decides how many payer locks and
    /// GiST index writes one request may take.
    /// </para>
    /// </summary>
    public int AdminBulkMaxItems { get; init; } = BulkSettings.DefaultMaxItems;

    // ---- The two night-trace settings ----
    //
    // Raw as stored, like everything else on this record, and read through TraceSettings, which
    // is where the bounds and the kill switch's meaning live. The defaults are TraceSettings'
    // own constants rather than literals here, so the accessor's fallback and this initialiser
    // cannot drift.

    /// <summary>
    /// Whether this club's admins may read one member's night. Read via
    /// <see cref="TraceSettings.Enabled"/>; false makes the route answer <c>404</c>.
    /// </summary>
    public bool MemberTraceEnabled { get; init; } = TraceSettings.DefaultEnabled;

    /// <summary>Most events one trace returns. Read via <see cref="TraceSettings.MaxEvents"/>.</summary>
    public int MemberTraceMaxEvents { get; init; } = TraceSettings.DefaultMaxEvents;

    // ---- The three schedule settings ----
    //
    // Raw as stored and read through ScheduleSettings, where the bounds live along with the
    // cross-field rule that the horizon must reach at least as far as advance_booking_days.

    /// <summary>How far ahead occurrences are written, days. Read via <see cref="ScheduleSettings.MaterialisationDays"/>.</summary>
    public int ScheduleMaterialisationDays { get; init; } = ScheduleSettings.DefaultMaterialisationDays;

    /// <summary>Most rows one schedule change may touch. Read via <see cref="ScheduleSettings.MaxRowsPerChange"/>.</summary>
    public int ScheduleMaxRowsPerChange { get; init; } = ScheduleSettings.DefaultMaxRowsPerChange;

    /// <summary>The materialisation worker's tick, seconds. Read via <see cref="ScheduleSettings.WorkerInterval"/>.</summary>
    public int ScheduleWorkerIntervalSeconds { get; init; } = ScheduleSettings.DefaultWorkerIntervalSeconds;

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

    // ---- The admin notifier's six (R23) ----

    /// <summary>Open faults inside the window that make a spike. Read via <see cref="AdminNotificationSettings.FaultSpikeCount"/>.</summary>
    public int FaultSpikeCount { get; init; } = AdminNotificationSettings.DefaultFaultSpikeCount;

    /// <summary>The fault-spike window, minutes. Read via <see cref="AdminNotificationSettings.FaultSpikeMinutes"/>.</summary>
    public int FaultSpikeMinutes { get; init; } = AdminNotificationSettings.DefaultFaultSpikeMinutes;

    /// <summary>Hours an application may wait before the admins are reminded. Read via <see cref="AdminNotificationSettings.ApplicationReminderHours"/>.</summary>
    public int ApplicationReminderHours { get; init; } = AdminNotificationSettings.DefaultApplicationReminderHours;

    /// <summary>Days a finished admin notice stays on the feed. Read via <see cref="AdminNotificationSettings.RetentionDays"/>.</summary>
    public int AdminNotificationRetentionDays { get; init; } = AdminNotificationSettings.DefaultRetentionDays;

    /// <summary>Minutes inside which top-up failures of one reason are one mail. Read via <see cref="AdminNotificationSettings.TopUpFailureCooldown"/>.</summary>
    public int TopUpFailureCooldownMinutes { get; init; } = AdminNotificationSettings.DefaultTopUpFailureCooldownMinutes;

    /// <summary>Minutes inside which one admin overdrawing one member is one mail. Read via <see cref="AdminNotificationSettings.OverdraftCooldown"/>.</summary>
    public int OverdraftCooldownMinutes { get; init; } = AdminNotificationSettings.DefaultOverdraftCooldownMinutes;

    // ---- Players and splits (D11–D13). Raw here, bounded by PlayerSettings at each reader. ----

    public int ShareLapseHours { get; init; } = PlayerSettings.DefaultShareLapseHours;
    public int ShareReminderHours { get; init; } = PlayerSettings.DefaultShareReminderHours;
    public int ShareReminderMax { get; init; } = PlayerSettings.DefaultShareReminderMax;
    public int PlayerNudgeLimit { get; init; } = PlayerSettings.DefaultNudgeLimit;
    public int DirectorySearchesPerMinute { get; init; } = PlayerSettings.DefaultDirectorySearchesPerMinute;
    public int MemberQuietStartMinute { get; init; } = PlayerSettings.DefaultQuietStartMinute;
    public int MemberQuietEndMinute { get; init; } = PlayerSettings.DefaultQuietEndMinute;
    public int RecentPartnerDays { get; init; } = PlayerSettings.DefaultRecentPartnerDays;
    public int MemberNotificationRetentionDays { get; init; } = PlayerSettings.DefaultNotificationRetentionDays;

    // ---- The live streams' seven numbers ----

    /// <summary>Seconds of quiet before a stream writes a <c>ping</c>. Read via <see cref="RealtimeSettings.KeepAlive"/>.</summary>
    public int SseKeepaliveSeconds { get; init; } = RealtimeSettings.DefaultKeepaliveSeconds;

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

    // ---- GOAL item 19: how much of a club day one member may hold ----
    //
    // Raw as stored, like everything else on this record. Read through BookingLimits, which is
    // where the bounds live and where "0 means unlimited" is written down once.

    /// <summary>Slots one member may book per club day; 0 = unlimited. Read via <see cref="BookingLimits.MaxSlotsPerDay"/>.</summary>
    public int MemberMaxSlotsPerDay { get; init; } = BookingLimits.DefaultMaxSlotsPerDay;

    /// <summary>
    /// Whether blueprint B.3's same-day relaxation applies at all. On by default because it is
    /// the customer's own rule; the club that wants a hard cap turns it off in one place rather
    /// than discovering the cap is decorative.
    /// </summary>
    public bool SameDayCapRelaxation { get; init; } = true;

    /// <summary>How close to a slot's start the relaxation reaches, minutes. Read via <see cref="BookingLimits.SameDayRelaxationWindowMinutes"/>.</summary>
    public int SameDayRelaxationWindowMinutes { get; init; } = BookingLimits.DefaultSameDayRelaxationWindowMinutes;

    /// <summary>
    /// Whether a walk-up at the box is REFUSED by the per-day cap. Off by default: the member
    /// is physically standing at a court that is about to go unlit and the club wants the
    /// revenue. A walk-up always COUNTS toward the cap either way — the setting decides only
    /// whether it is refused by it.
    /// </summary>
    public bool WalkUpHonoursDayCap { get; init; }

    /// <summary>
    /// Whether member groups' BOOKING RESTRICTIONS (GOAL item 3 — windows, prices, caps) are
    /// consulted. On by default and harmless there, because the seeded groups are unrestricted
    /// and inheriting: a club that never opens the groups screen behaves exactly as it does today.
    ///
    /// <para>
    /// <b>It does not switch off a group's tariff</b> — its top-up rate and peak priority, the
    /// two things the member class carried before D2. No switch ever turned the class off, and a
    /// club that disabled restrictions must not silently move every league member to the regular
    /// rate. See <see cref="MemberTariffs"/>.
    /// </para>
    /// </summary>
    public bool MemberGroupsEnabled { get; init; } = true;

    /// <summary>
    /// Which glyph pair a confirm/decline button wears — <c>thumbs</c> or <c>marks</c>. Read via
    /// <see cref="Services.ActionGlyphs.For"/>, which is where an unrecognised stored value is
    /// decided rather than obeyed.
    /// </summary>
    public string ActionGlyphs { get; init; } = Services.ActionGlyphs.Thumbs;

    /// <summary>
    /// The symbol the club's REAL MONEY figures wear — <c>R</c>, <c>R$</c>, <c>CHF</c>. Read via
    /// <see cref="Services.CurrencySymbol.For"/>, which is where an unprintable stored value is
    /// decided rather than obeyed.
    ///
    /// <para>
    /// <b>It is not the credit unit and must never become it.</b> Credits are the unit of
    /// account and convert at <see cref="CreditsPerZarRegular"/>; a credit figure wearing this
    /// symbol is the defect <see cref="Services.CurrencySymbol"/> documents.
    /// </para>
    /// </summary>
    public string CurrencySymbol { get; init; } = Services.CurrencySymbol.Default;

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

    /// <summary>
    /// The club's peak window, as the booking rule will actually apply it.
    ///
    /// <para>
    /// <b>D2-B16: this used to fail OPEN, and silently.</b> The settings PUT requires
    /// <c>start &lt; end</c>; this reader did not, so a stored <c>"19:00-16:00"</c> produced
    /// <c>inPeak = slotStart &gt;= 19:00 &amp;&amp; slotStart &lt; 16:00</c> — false for every
    /// instant there has ever been. League exclusivity was off for every Regular member of that
    /// club, no screen said so, and the settings page rendered the inverted range back as
    /// though it were in force.
    /// </para>
    ///
    /// <para>
    /// <b>An unusable value falls back to the default window rather than to "no peak".</b>
    /// Peak exclusivity is an ACCESS rule, and an access rule whose configuration cannot be
    /// read should narrow rather than open — the same posture <see cref="GateAccessPolicies"/>
    /// takes about a door, and the opposite of the one <see cref="OperatingHours"/> takes,
    /// because opening hours decide whether the club can trade at all and failing closed there
    /// would shut it. Two postures, two reasons, both written down.
    /// </para>
    ///
    /// <para>
    /// <b>EMPTY is a real instruction and is honoured.</b> A club that does not run league nights
    /// stores an empty <c>peak_hours</c>, several fixtures do, and
    /// <c>SchedulePeakVisibilityTests</c> pins it — inventing 16:00–19:00 for those clubs would
    /// grey out a quarter of their day on the grid and refuse bookings the club wants to sell.
    /// The fall-back is for a value that is present and UNUSABLE, which is a typo rather than a
    /// decision: the club plainly meant to have a peak window, and the safe reading of a typo in
    /// an access rule is the rule, not its absence.
    /// </para>
    /// </summary>
    public (TimeOnly start, TimeOnly end)? PeakHours()
    {
        if (string.IsNullOrWhiteSpace(PeakHoursRange)) return null;
        return TryParsePeakRange(PeakHoursRange) ?? TryParsePeakRange(DefaultPeakHoursRange);
    }

    /// <summary>The window every club gets until it sets its own — blueprint A.12.</summary>
    public const string DefaultPeakHoursRange = "16:00-19:00";

    private static (TimeOnly start, TimeOnly end)? TryParsePeakRange(string range)
    {
        var parts = range.Split('-');
        if (parts.Length != 2) return null;
        if (!TimeOnly.TryParse(parts[0].Trim(), out var s) || !TimeOnly.TryParse(parts[1].Trim(), out var e)) return null;
        // The half the PUT enforced and this did not. An empty or inverted window is not a
        // narrower rule, it is no rule — which is the failure this whole method is named for.
        return s < e ? (s, e) : null;
    }
}
