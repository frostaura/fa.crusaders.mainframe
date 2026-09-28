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

    /// <summary>Whether devices are sent players and keys (§5.2–§5.3): <c>v1</c> or <c>v1_only</c>.</summary>
    public static bool RostersCarryPlayers(TenantSettingsView s) => Phase(s) is V1 or V1Only;

    /// <summary>Whether a legacy code is still honoured anywhere: every phase but <c>v1_only</c>.</summary>
    public static bool LegacyAccepted(TenantSettingsView s) => Phase(s) != V1Only;

    /// <summary>Whether bookings still mint per-booking codes: only in <c>legacy</c>.</summary>
    public static bool MintsBookingCodes(TenantSettingsView s) => Phase(s) == Legacy;

    public static int CutoffDays(TenantSettingsView s) => Math.Clamp(s.MemberCodeCutoffDays, MinCutoffDays, MaxCutoffDays);

    /// <summary>
    /// The oldest scan the server will check (§4.2), milliseconds:
    /// <c>(scan_memory_seconds + lcd_choice_seconds) × 1000 + 30 000</c> from the club's own
    /// clamped settings — the box never remembers a scan longer than scan memory plus one pay-for
    /// question, plus one step of slack. At most 390 000.
    /// </summary>
    public static long MaxScanAgeMs(TenantSettingsView s) =>
        ((long)BoxSettings.ScanMemorySeconds(s) + BoxSettings.LcdChoiceSeconds(s)) * 1000L + (MemberCodeMath.StepSeconds * 1000L);
}
