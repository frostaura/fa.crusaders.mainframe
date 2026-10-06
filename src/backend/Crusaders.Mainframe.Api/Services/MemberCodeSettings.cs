namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The member-code rollout's tenant settings (<c>docs/specs/member-code.md</c> §8), read with
/// their meaning applied — the same split <see cref="BoxSettings"/> keeps: the accessor says
/// what the column holds, this says what the product may act on.
/// </summary>
public static class MemberCodeSettings
{
    public const string PhaseKey = "member_code_phase";
    public const string CutoverAtKey = "member_code_cutover_at";
    public const string CutoffAtKey = "member_code_cutoff_at";
    public const string CutoffDaysKey = "member_code_cutoff_days";

    /// <summary>
    /// The administrator's hold on the automatic rollout: set by a BACKWARD move by hand, and
    /// while it is set the heartbeat never moves the phase forward. <b>Why it exists:</b> the
    /// automatic cut-over fires the first time every board speaks <c>codes:m1</c>, and a club
    /// that rolled back because v1 misbehaved still has every board speaking it — so the very
    /// next heartbeat undid the rollback, within a minute, every time. Only an administrator
    /// moving the phase forward again (or clearing the hold) lets the automatic move resume.
    /// </summary>
    public const string HoldKey = "member_code_manual_hold";
    public const string HoldByKey = "member_code_manual_hold_by";
    public const string HoldAtKey = "member_code_manual_hold_at";

    /// <summary>Per-booking codes and v1 codes both work; phones show legacy codes. The default.</summary>
    public const string Legacy = "legacy";

    /// <summary>Every enabled board speaks <c>codes:m1</c>: rosters carry players and keys, phones show v1, legacy works online only.</summary>
    public const string V1 = "v1";

    /// <summary>Legacy codes are refused everywhere.</summary>
    public const string V1Only = "v1_only";

    public static readonly string[] Phases = [Legacy, V1, V1Only];

    /// <summary>
    /// The cut-off follows the cut-over by at least this many days — the spec's "no sooner than
    /// 14 days later" is the floor, not merely the default.
    /// </summary>
    public const int DefaultCutoffDays = 14;
    public const int MinCutoffDays = 14;
    public const int MaxCutoffDays = 365;

    /// <summary>
    /// The phase the club is in. <b>An unknown stored value reads as <see cref="Legacy"/></b> —
    /// the phase that refuses nothing — because a hand-edited typo must degrade to "both kinds of
    /// code work", never to "every member's legacy code is refused".
    /// </summary>
    public static string Phase(TenantSettingsView s) =>
        Array.IndexOf(Phases, s.MemberCodePhase) >= 0 ? s.MemberCodePhase : Legacy;

    public static bool IsKnownPhase(string? phase) => phase is not null && Array.IndexOf(Phases, phase) >= 0;

    /// <summary>A phase's position on the one-way road, <c>legacy</c> = 0; an unknown value is <c>legacy</c>'s.</summary>
    public static int Rank(string? phase) => Math.Max(0, Array.IndexOf(Phases, phase ?? Legacy));

    /// <summary>Whether devices are sent players and keys (§5.2–§5.3): <c>v1</c> or <c>v1_only</c>.</summary>
    public static bool RostersCarryPlayers(TenantSettingsView s) => Phase(s) is V1 or V1Only;

    /// <summary>Whether a legacy code is still honoured anywhere: every phase but <c>v1_only</c>.</summary>
    public static bool LegacyAccepted(TenantSettingsView s) => Phase(s) != V1Only;

    /// <summary>
    /// Whether a legacy code was honoured at <paramref name="at"/> — for EVIDENCE, which is
    /// judged at the scan, not the upload (settlement model): a box that admitted a legacy code
    /// from a roster fetched before the cut-off reported something that was true then. After the
    /// cut-off instant, or in <c>v1_only</c> with no instant recorded, it was not.
    /// </summary>
    public static bool LegacyAcceptedAt(TenantSettingsView s, DateTimeOffset at) =>
        LegacyAccepted(s) || (s.MemberCodeCutoffAt is { } cutoff && at < cutoff);

    /// <summary>Whether bookings still mint per-booking codes: only in <c>legacy</c>.</summary>
    public static bool MintsBookingCodes(TenantSettingsView s) => Phase(s) == Legacy;

    public static int CutoffDays(TenantSettingsView s) => Math.Clamp(s.MemberCodeCutoffDays, MinCutoffDays, MaxCutoffDays);

    /// <summary>
    /// The oldest scan the server will check (§4.2), milliseconds:
    /// <c>(scan_memory_seconds + lcd_choice_seconds) × 1000 + 30 000</c> from the club's own
    /// clamped settings. At most 390 000.
    ///
    /// <para>
    /// The box holds itself 5 s inside this bound (bridge 2.2.9, <c>bridgelogic::ScanMemory</c>,
    /// R19 D19-2): a remembered scan, however many pay-for questions and PRESS AGAIN holds extend
    /// it, never carries a <c>scan_age_ms</c> past <c>(scan_memory + choice) × 1000 + 25 000</c>.
    /// When a whole further countdown would not fit under that cap the box forgets the scan and
    /// shows SCAN AGAIN instead of inviting a press this check would refuse. The 5 s is the box's
    /// margin for the pass between its expiry check and the request that carries the age.
    /// </para>
    /// </summary>
    public static long MaxScanAgeMs(TenantSettingsView s) =>
        ((long)BoxSettings.ScanMemorySeconds(s) + BoxSettings.LcdChoiceSeconds(s)) * 1000L + (MemberCodeMath.StepSeconds * 1000L);
}
