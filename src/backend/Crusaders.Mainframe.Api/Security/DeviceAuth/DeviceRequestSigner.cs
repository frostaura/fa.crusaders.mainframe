using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Crusaders.Mainframe.Api.Security.DeviceAuth;

/// <summary>
/// The canonical string a device signs, and the HMAC over it.
///
/// <para>
/// Kept as a separate, side-effect-free class for two reasons: the firmware has to
/// reproduce it byte for byte on an 8-bit micro, and it is the piece most likely to
/// be got subtly wrong. A canonicalisation that lets two different requests produce
/// the same signing string is a signature-reuse hole, so every field is
/// length-delimited by a newline and the body is hashed rather than embedded.
/// </para>
/// </summary>
public static class DeviceRequestSigner
{
    public const string DeviceIdHeader = "X-Device-Id";
    public const string TimestampHeader = "X-Device-Timestamp";
    public const string NonceHeader = "X-Device-Nonce";
    public const string SignatureHeader = "X-Device-Signature";

    /// <summary>
    /// METHOD \n PATH \n UNIX_SECONDS \n NONCE \n hex(SHA256(body))
    ///
    /// The method is upper-cased and the path is taken verbatim including its query,
    /// so a signature for GET /a cannot be replayed against POST /a or /a?admin=1.
    /// </summary>
    public static string CanonicalString(string method, string pathAndQuery, long unixSeconds, string nonce, ReadOnlySpan<byte> body)
    {
        var bodyHash = Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant();

        return string.Concat(
            method.ToUpperInvariant(), "\n",
            pathAndQuery, "\n",
            unixSeconds.ToString(CultureInfo.InvariantCulture), "\n",
            nonce, "\n",
            bodyHash);
    }

    /// <summary>Lowercase hex HMAC-SHA256, matching the existing webhook signature convention.</summary>
    public static string Sign(byte[] key, string canonical)
    {
        var mac = HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(canonical));
        return Convert.ToHexString(mac).ToLowerInvariant();
    }

    /// <summary>Constant-time comparison — a timing side channel here leaks the signature a byte at a time.</summary>
    public static bool Verify(byte[] key, string canonical, string presented)
    {
        var expected = Encoding.UTF8.GetBytes(Sign(key, canonical));
        var actual = Encoding.UTF8.GetBytes(presented ?? string.Empty);

        return expected.Length == actual.Length
               && CryptographicOperations.FixedTimeEquals(expected, actual);
    }
}
