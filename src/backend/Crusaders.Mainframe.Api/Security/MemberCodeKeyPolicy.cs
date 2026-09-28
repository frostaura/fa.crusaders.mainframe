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
/// or a known placeholder: a server that came up with a guessable master key would look entirely
/// healthy while every phone in the club showed codes anybody could compute. Development and the
/// test host get a key derived from a sentence that says it is a development key, so a local run
/// works with nothing configured and can never be mistaken for a deployment.
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

    /// <summary>
    /// The published development key: SHA-256 of a sentence saying so. It authenticates nothing
    /// anywhere, and it is refused outside Development and Testing whatever the configuration says.
    /// </summary>
    public static readonly MemberCodeMasterKey Development = new(
        SHA256.HashData(Encoding.ASCII.GetBytes("crusaders-mainframe DEVELOPMENT member-code master key - never deploy")),
        IsDevelopmentKey: true);

    /// <summary>Resolves from configuration and environment. Throws — refusing to start — where §3.1 says to.</summary>
    public static MemberCodeMasterKey Resolve(IConfiguration config, IHostEnvironment environment) =>
        Resolve(config[ConfigKey], environment.IsDevelopment() || environment.IsEnvironment("Testing"));

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

        return new MemberCodeMasterKey(bytes, IsDevelopmentKey: false);
    }
}
