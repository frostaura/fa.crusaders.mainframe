using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The one place a device path turns a scanned token into a member, for both families
/// (<c>docs/specs/member-code.md</c> §4.1): a nineteen-character token is a v1 member code and is
/// CHECKED; anything else is a legacy access code and is looked up, until the club's cut-off
/// (<c>v1_only</c>) refuses it. Length alone decides, so nothing can be read both ways.
/// </summary>
public static class MemberCodeIdentity
{
    /// <summary>The refusal for a code the server has already acted on in this class (§4.4).</summary>
    public const string CodeUsed = "code_used";

    /// <summary>
    /// What the token identifies, and — for a v1 code — the accepted match the caller claims a use
    /// against. A v1 code identifies its member and nothing else: a MEMBER-IDENT resolution with no
    /// booking, so every path treats it exactly as it treats the phone's old sixty-second code.
    /// Null on every failure, one answer for all of them.
    /// </summary>
    public static async Task<(ResolvedAccessCode? Resolved, MemberCodeMatch? Match)> ResolveAsync(
        AccessCodeService codes, MemberCodeService memberCodes, ScannedCode scan,
        TenantSettingsView settings, DateTimeOffset receivedAt, CancellationToken ct)
    {
        var (token, scanAgeMs) = scan;
        if (MemberCodeMath.IsV1Shaped(token?.Trim()))
        {
            var match = await memberCodes.VerifyAsync(token!.Trim(), receivedAt, scanAgeMs, settings, ct);
            return match is null
                ? (null, null)
                : (new ResolvedAccessCode(AccessCodePurpose.MemberIdent, match.UserId, null), match);
        }

        if (!MemberCodeSettings.LegacyAccepted(settings)) return (null, null);
        return (await codes.ResolveAsync(token, receivedAt, ct), null);
    }
}

/// <summary>What a device scanned, and how long ago it read it (<c>scan_age_ms</c>, §4.2; null means now).</summary>
public sealed record ScannedCode(string? Token, long? ScanAgeMs);
