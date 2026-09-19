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
        };
    }

    private static int TryInt(JsonElement root, string name, int fallback)
        => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : fallback;
    private static decimal TryDecimal(JsonElement root, string name, decimal fallback)
        => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDecimal() : fallback;
    private static string TryString(JsonElement root, string name, string fallback)
        => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? fallback : fallback;
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
    /// full of "unreachable" and "back" — and auto-registration is unbounded, so anyone
    /// holding the club's device key could mint boards that each did it. An alert nobody reads
    /// is worse than no alert, because the club believes it has one.
    /// </para>
    /// </summary>
    public int DeviceAlertCooldownMinutes { get; init; } = DefaultDeviceAlertCooldownMinutes;

    /// <summary>
    /// When the club is open, per weekday. Empty means "no per-weekday map configured",
    /// in which case <see cref="HoursFor"/> falls back to the flat
    /// <see cref="DayStartMinute"/>/<see cref="DayEndMinute"/> pair the Settings page edits.
    /// </summary>
    public OperatingHours OperatingHours { get; init; } = OperatingHours.Empty;

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
