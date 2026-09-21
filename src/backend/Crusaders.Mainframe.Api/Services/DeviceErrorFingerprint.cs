using System.Security.Cryptography;
using System.Text;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// What makes two fault reports the same fault.
///
/// <para>
/// The fingerprint is what the filtered unique index on <c>device_errors</c> de-duplicates on,
/// so getting it wrong in either direction is expensive: too coarse and two unrelated faults
/// on one board merge into a row whose count means nothing; too fine and a board with a jittery
/// timeout opens a thousand rows and the club's monitoring page becomes the thing that is
/// broken.
/// </para>
/// </summary>
public static class DeviceErrorFingerprint
{
    /// <summary>
    /// The detail as it participates in the fingerprint: lower-cased, trimmed, and with every
    /// run of digits replaced by a single <c>#</c>.
    ///
    /// <para>
    /// <b>Digit-collapsing is the whole reason this method exists.</b>
    /// <c>http_timeout after 5031ms</c> and <c>http_timeout after 5104ms</c> are one fault
    /// reported twice, and without the collapse they are two rows — then a thousand, because
    /// the number is never the same twice. It is applied <b>only</b> here: the row stores
    /// <c>Detail</c> verbatim, so an admin reads the real number while the index sees the
    /// shape.
    /// </para>
    /// </summary>
    public static string NormaliseDetail(string? detail)
    {
        if (string.IsNullOrWhiteSpace(detail)) return "";

        var lowered = detail.Trim().ToLowerInvariant();
        var sb = new StringBuilder(lowered.Length);
        var inDigits = false;
        foreach (var ch in lowered)
        {
            if (char.IsAsciiDigit(ch))
            {
                if (!inDigits) { sb.Append('#'); inDigits = true; }
                continue;
            }
            inDigits = false;
            sb.Append(ch);
        }
        return sb.ToString();
    }

    /// <summary>
    /// The fingerprint: 32 hex characters of SHA-256 over the tenant, the board's identity, the
    /// code, the relay and the digit-collapsed detail.
    ///
    /// <para>
    /// The board's identity falls back through <paramref name="deviceId"/> then
    /// <paramref name="claimedMac"/> then a literal <c>?</c>, because the two server-detected
    /// codes that matter most — an authentication failure and an unregistered MAC — have no
    /// device row by construction and must still de-duplicate rather than opening a row per
    /// attempt. A flood of bad keys from one source is one row with a climbing count, which is
    /// what an admin needs to see; a row per attempt is the flood succeeding.
    /// </para>
    ///
    /// <para>
    /// The fields are joined with a separator that cannot occur in any of them, so
    /// <c>("ab", "c")</c> and <c>("a", "bc")</c> cannot collide.
    /// </para>
    /// </summary>
    public static string Of(Guid tenantId, Guid? deviceId, string? claimedMac, string code, int? court, string? detail)
    {
        var identity = deviceId is { } id ? id.ToString("N")
            : !string.IsNullOrWhiteSpace(claimedMac) ? claimedMac.Trim().ToLowerInvariant()
            : "?";

        var material = string.Join('',
            tenantId.ToString("N"), identity, code, (court ?? -1).ToString(), NormaliseDetail(detail));

        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(material));
        return Convert.ToHexString(digest)[..32].ToLowerInvariant();
    }
}
