using System.Security.Cryptography;
using System.Text;

namespace Crusaders.Mainframe.Api.Security.DeviceAuth;

/// <summary>
/// The club's device API key: how one is minted, and how one is compared.
///
/// <para>
/// This replaces a per-device HMAC scheme — derived keys, a canonical signing string, a
/// nonce cache, a two-minute clock window and a 401 body carrying the server clock so a
/// board with no RTC could re-seed itself. Every part of that existed to protect a
/// credential per board; with one club, one box and one key an admin can read off a page
/// and paste into <c>secrets.h</c>, none of it bought anything and all of it could
/// deadlock a board in a cupboard. See <c>docs/specs/deployment.md</c>.
/// </para>
/// </summary>
public static class DeviceApiKey
{
    /// <summary>
    /// Bytes of entropy behind a key. 32 bytes base64url-encodes to 43 characters, which
    /// is what an admin copies and what the firmware compiles in.
    /// </summary>
    public const int EntropyBytes = 32;

    /// <summary>Longest key this scheme will even look at — a bound on what an unauthenticated caller can make the server hash.</summary>
    public const int MaxLength = 256;

    /// <summary>A fresh key. Base64url so it survives a header, a JSON string and a C string literal unescaped.</summary>
    public static string Generate()
    {
        var bytes = RandomNumberGenerator.GetBytes(EntropyBytes);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    /// <summary>
    /// Constant-time equality. Ordinary string comparison returns as soon as two bytes
    /// differ, which times out the length of the shared prefix and hands an attacker the
    /// key one character at a time.
    /// </summary>
    public static bool Matches(string? stored, string? presented)
    {
        if (string.IsNullOrEmpty(stored) || string.IsNullOrEmpty(presented)) return false;

        var a = Encoding.UTF8.GetBytes(stored);
        var b = Encoding.UTF8.GetBytes(presented);

        // FixedTimeEquals requires equal lengths; unequal lengths are not secret (the
        // header's length is visible on the wire anyway) so refusing early is not a leak.
        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }

    /// <summary>
    /// The bearer key on a request, or null when the header is absent or is not a bearer
    /// header at all. Over-long values are dropped rather than compared.
    /// </summary>
    public static string? FromAuthorizationHeader(string? header)
    {
        if (string.IsNullOrWhiteSpace(header)) return null;

        const string prefix = "Bearer ";
        if (!header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;

        var key = header[prefix.Length..].Trim();
        return key.Length is > 0 and <= MaxLength ? key : null;
    }
}
