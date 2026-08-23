using System.Security.Cryptography;
using System.Text;

namespace Crusaders.Mainframe.Api.Payments.PayFast;

/// <summary>
/// The PayFast MD5 signature, and the PHP-compatible encoding it depends on.
///
/// <para>
/// This is a separate, side-effect-free class because it is the piece most likely to be
/// got subtly wrong, and a mismatch produces no useful error — PayFast simply rejects the
/// payment or the ITN, with no indication of which byte differed.
/// </para>
///
/// <para>
/// <b>.NET has no built-in that matches PHP's <c>urlencode()</c>.</b> Three differences,
/// each individually enough to break every signature:
/// </para>
/// <list type="bullet">
///   <item>PHP encodes a space as <c>+</c>. <c>Uri.EscapeDataString</c> emits <c>%20</c>.</item>
///   <item>PHP escapes <c>~</c> as <c>%7E</c>. <c>Uri.EscapeDataString</c> treats it as an
///         RFC 3986 unreserved character and leaves it literal.</item>
///   <item>PHP emits <b>uppercase</b> hex. Several .NET escaping helpers emit lowercase.</item>
/// </list>
/// <para>
/// So the encoder is hand-written, and pinned by a corpus generated from an independent
/// implementation at <c>src/contracts/payfast/</c>.
/// </para>
/// </summary>
public static class PayFastSignature
{
    /// <summary>
    /// PHP's <c>urlencode()</c>, byte for byte.
    ///
    /// <para>
    /// Encodes over UTF-8 <i>bytes</i>, not characters: a multi-byte character becomes one
    /// <c>%XX</c> group per byte. Iterating chars would emit garbage for any accented name,
    /// and South African member names are full of them.
    /// </para>
    /// </summary>
    public static string UrlEncode(string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        var sb = new StringBuilder(bytes.Length * 3);

        foreach (var b in bytes)
        {
            var c = (char)b;

            // PHP's safe set is exactly A-Za-z0-9 and '_', '.', '-'. Note the absence of
            // '~', which is where a "sensible" RFC 3986 implementation diverges.
            if (c is (>= 'A' and <= 'Z') or (>= 'a' and <= 'z') or (>= '0' and <= '9') or '_' or '.' or '-')
            {
                sb.Append(c);
            }
            else if (c == ' ')
            {
                sb.Append('+');
            }
            else
            {
                sb.Append('%').Append(b.ToString("X2", System.Globalization.CultureInfo.InvariantCulture));
            }
        }

        return sb.ToString();
    }

    /// <summary>
    /// The string PayFast hashes.
    ///
    /// <para>
    /// Order is significant and is the caller's to decide — PayFast signs the pairs in the
    /// order given, which for a payment request is the documented field order and for an
    /// ITN is the order the fields arrived in. A <c>Dictionary</c> would silently reorder
    /// them, so this takes an ordered sequence and the ITN parser preserves POST order.
    /// </para>
    ///
    /// <para>
    /// Empty and null values are dropped entirely rather than sent as <c>key=</c>. Note
    /// that <c>"0"</c> is not empty and must survive — dropping it changes the signature.
    /// </para>
    /// </summary>
    public static string ParameterString(IEnumerable<KeyValuePair<string, string?>> fields, string? passphrase)
    {
        var parts = fields
            .Where(f => !string.IsNullOrEmpty(f.Value))
            .Select(f => $"{f.Key}={UrlEncode(f.Value!)}")
            .ToList();

        // Appended as one more encoded pair, and omitted entirely when the merchant has no
        // passphrase set — an empty `passphrase=` pair is not the same string and does not
        // verify.
        if (!string.IsNullOrEmpty(passphrase))
        {
            parts.Add($"passphrase={UrlEncode(passphrase)}");
        }

        return string.Join("&", parts);
    }

    /// <summary>Lowercase hex MD5 of the parameter string.</summary>
    public static string Compute(IEnumerable<KeyValuePair<string, string?>> fields, string? passphrase)
    {
        var bytes = MD5.HashData(Encoding.UTF8.GetBytes(ParameterString(fields, passphrase)));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    /// <summary>
    /// Constant-time comparison of a presented signature.
    ///
    /// <para>
    /// MD5 is PayFast's choice, not ours, and it is weak — but the timing channel is a
    /// separate and avoidable problem, so it is avoided.
    /// </para>
    /// </summary>
    public static bool Verify(IEnumerable<KeyValuePair<string, string?>> fields, string? passphrase, string? presented)
    {
        if (string.IsNullOrWhiteSpace(presented)) return false;

        var expected = Encoding.UTF8.GetBytes(Compute(fields, passphrase));
        var actual = Encoding.UTF8.GetBytes(presented.Trim().ToLowerInvariant());

        return expected.Length == actual.Length && CryptographicOperations.FixedTimeEquals(expected, actual);
    }
}
