using System.Security.Cryptography;
using System.Text;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// The deployment's member-code master key (<c>MemberCodes:MasterKey</c>,
/// <c>docs/specs/member-code.md</c> §3.1), resolved once at startup. Every member's secret is
/// HKDF of this, so it is worth more than every code in the club put together.
/// </summary>
/// <param name="Bytes">32 to 64 bytes of key material.</param>
/// <param name="IsDevelopmentKey">True when this is the published development key, never a real one.</param>
public sealed record MemberCodeMasterKey(byte[] Bytes, bool IsDevelopmentKey);

/// <summary>
/// The startup rule for <see cref="MemberCodeMasterKey"/> — <see cref="JwtSecretPolicy"/>'s rule,
/// applied to the second secret this server holds.
///
/// <para>
/// <b>Production refuses to start</b> when the key is absent, shorter than 32 bytes, not base64,
/// a known placeholder, a key published in this repository, or a key too regular to be random: a
/// server that came up with a guessable master key would look entirely healthy while every phone
/// in the club showed codes anybody could compute. Development gets a key derived from a sentence
/// that says it is a development key, so a local run works with nothing configured and can never
/// be mistaken for a deployment. Everything else — Production, and the test host, which injects
/// a random key of its own — is held to the full rule.
/// </para>
///
/// <para>
/// Changing the key changes every member's secret at once and every phone re-enrols; there is no
/// key identifier and no dual-key window in v1 (§3.1).
/// </para>
/// </summary>
public static class MemberCodeKeyPolicy
{
    public const string ConfigKey = "MemberCodes:MasterKey";
    public const int MinimumBytes = 32;
    public const int MaximumBytes = 64;

    private static readonly string[] PublishedPrefixes =
    [
        "DEV_ONLY", "CHANGE-ME", "CHANGEME", "REPLACE_WITH", "REPLACE-WITH",
    ];

    /// <summary>A key must hold at least this many distinct byte values — 32 random bytes hold about 29.</summary>
    public const int MinimumDistinctBytes = 16;

    /// <summary>
    /// The published development key: SHA-256 of a sentence saying so. It authenticates nothing
    /// anywhere, and it is refused outside Development whatever the configuration says.
    /// </summary>
    public static readonly MemberCodeMasterKey Development = new(
        SHA256.HashData(Encoding.ASCII.GetBytes("crusaders-mainframe DEVELOPMENT member-code master key - never deploy")),
        IsDevelopmentKey: true);

    /// <summary>
    /// Keys that are PUBLISHED — in this repository, byte for byte — and so compute every
    /// member's code for anybody who reads the source: the development key, the fixed key the
    /// test host once ran with, and the corpus's own fixture master key (<c>derivation.json</c>
    /// <c>fixture_master_key_hex</c>, pinned by a test so the two cannot drift). Base64 of any
    /// of them passes every length rule, which is exactly why they are refused by value.
    /// </summary>
    private static readonly byte[][] PublishedKeys =
    [
        Development.Bytes,
        Encoding.ASCII.GetBytes("test-only member-code master key, 48 bytes long!"),
        Convert.FromHexString("37ca19aed84cf9a6d932662805392b786b94110ed6324c676deb3f2e619baceb"),
    ];

    /// <summary>
    /// Resolves from configuration and environment. Throws — refusing to start — where §3.1 says
    /// to. <b>Lenient only in Development</b>: the test host is not a deployment, but a rule it is
    /// exempt from is a rule no test ever proves, so it injects a random key of its own and runs
    /// under the same policy Production does.
    /// </summary>
    public static MemberCodeMasterKey Resolve(IConfiguration config, IHostEnvironment environment) =>
        Resolve(config[ConfigKey], environment.IsDevelopment());

    public static MemberCodeMasterKey Resolve(string? configured, bool lenient)
    {
        var value = configured?.Trim();

        if (string.IsNullOrEmpty(value))
        {
            if (lenient) return Development;
            throw new InvalidOperationException(
                "MemberCodes:MasterKey is required and is not set. Set MemberCodes__MasterKey to 32–64 random "
                + "bytes, base64 — `openssl rand -base64 48`. Every member's rotating code is derived from it, "
                + "so a deployment without one must not start.");
        }

        if (PublishedPrefixes.Any(p => value.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
        {
            if (lenient) return Development;
            throw new InvalidOperationException(
                "MemberCodes:MasterKey is a placeholder committed to this repository. Anybody with the source "
                + "could compute every member's code. Set MemberCodes__MasterKey to `openssl rand -base64 48`.");
        }

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(value);
        }
        catch (FormatException)
        {
            throw new InvalidOperationException(
                "MemberCodes:MasterKey is not base64. Generate it with `openssl rand -base64 48`.");
        }

        if (bytes.Length is < MinimumBytes or > MaximumBytes)
        {
            throw new InvalidOperationException(
                $"MemberCodes:MasterKey is {bytes.Length} bytes; it must be {MinimumBytes} to {MaximumBytes}. "
                + "Generate it with `openssl rand -base64 48`.");
        }

        if (PublishedKeys.Any(k => CryptographicOperations.FixedTimeEquals(k, bytes)))
        {
            if (lenient) return Development;
            throw new InvalidOperationException(
                "MemberCodes:MasterKey is a key published in this repository (the development, test or corpus "
                + "fixture key). Anybody with the source could compute every member's code. Set "
                + "MemberCodes__MasterKey to `openssl rand -base64 48`.");
        }

        if (bytes.Distinct().Count() < MinimumDistinctBytes)
        {
            if (lenient) return Development;
            throw new InvalidOperationException(
                $"MemberCodes:MasterKey holds fewer than {MinimumDistinctBytes} distinct byte values — it is not "
                + "random (a repeated byte, a counter, a short phrase padded out). Set MemberCodes__MasterKey to "
                + "`openssl rand -base64 48`.");
        }

        return new MemberCodeMasterKey(bytes, IsDevelopmentKey: false);
    }
}
