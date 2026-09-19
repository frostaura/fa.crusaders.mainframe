using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// The rule that decides whether a configured JWT signing secret is allowed to sign anything.
///
/// <para>
/// <b>What this closes.</b> <c>appsettings.json</c> shipped
/// <c>"Secret": "DEV_ONLY_REPLACE_WITH_SECURE_JWT_SECRET_VALUE_32_CHARS_MIN"</c>, and
/// <c>Program.cs</c> asked only whether the value was null. It never was — the committed file
/// always supplied one. So a production deployment that forgot <c>Jwt__Secret</c> did not fail
/// to start and did not warn; it came up healthy and signed every session token with a string
/// that is in the repository, in the built image's layers, and in every checkout on every
/// machine that has ever cloned this. Anyone holding it can mint a token claiming
/// <c>is_admin</c> for any tenant, and the API would accept it: the signature would be valid.
/// The secret has now been removed from the base file, so the placeholder cannot be the value
/// by accident — and this guard is what makes a missing or weak one loud instead of silent.
/// </para>
///
/// <para>
/// <b>Why not just a length check.</b> HS256 keys shorter than 256 bits are refused by the JWT
/// library itself, eventually, with an exception at first use — that is a runtime 500 on the
/// first sign-in rather than a refusal to boot, and it says nothing about what to do. More to
/// the point, the placeholder is 58 characters, so a length check alone would have passed it.
/// The two failures are different and both are checked.
/// </para>
///
/// <para>
/// Development is exempt from the placeholder rule and only from that rule: a local checkout
/// has to run without ceremony, and a secret that only ever signs tokens for localhost is not
/// protecting anything. The length floor applies everywhere, because a key below it does not
/// work anywhere.
/// </para>
/// </summary>
public static class JwtSecretPolicy
{
    /// <summary>
    /// HS256's key floor, in bytes. RFC 7518 §3.2: a key for HMAC-SHA256 must be at least as
    /// long as the hash output, which is 256 bits.
    /// </summary>
    public const int MinimumBytes = 32;

    /// <summary>
    /// Markers of a value that is published in this repository rather than chosen.
    ///
    /// <para>
    /// Matched as a case-insensitive PREFIX on the trimmed secret, not by equality, and that is
    /// deliberate: <c>docker-compose.prod.yml</c> ships
    /// <c>Jwt__Secret: CHANGE-ME-random-string-of-at-least-32-characters</c>, which is 48
    /// characters and so clears the length floor comfortably. An equality list would have to
    /// anticipate every edit somebody makes to a placeholder while still leaving it a
    /// placeholder; a prefix catches the family, including the ones nobody has written yet.
    /// </para>
    ///
    /// <para>
    /// The cost is that a real secret beginning with one of these strings is refused. At 32+
    /// bytes of randomness that is not a collision anyone will have, and the failure is a
    /// startup message telling them to generate another, not a silent weakening.
    /// </para>
    /// </summary>
    private static readonly string[] PublishedPrefixes =
    {
        "DEV_ONLY_REPLACE",
        "CHANGE-ME",
        "CHANGEME",
        "REPLACE_WITH",
        "REPLACE-WITH",
    };

    /// <summary>
    /// The configured secret, or an exception naming the exact environment variable to set.
    /// </summary>
    /// <exception cref="InvalidOperationException">
    /// The secret is missing, too short for HS256, or a value published in this repository.
    /// </exception>
    public static string Resolve(IConfiguration config, IHostEnvironment environment)
        => Resolve(config["Jwt:Secret"], environment.IsDevelopment());

    /// <summary>The same rule without the hosting types, so it can be exercised directly.</summary>
    public static string Resolve(string? secret, bool isDevelopment)
    {
        var value = secret?.Trim();

        if (string.IsNullOrEmpty(value))
        {
            throw new InvalidOperationException(
                "Jwt:Secret is required and is not set. Set the Jwt__Secret environment variable to a "
                + $"random value of at least {MinimumBytes} bytes — for example `openssl rand -base64 48`. "
                + "It is deliberately absent from appsettings.json so that a deployment which forgets it "
                + "fails here rather than signing tokens with a value that is in the repository.");
        }

        // Bytes, not characters: the floor is on key material, and a secret written in anything
        // outside ASCII carries more bytes than it has characters.
        var bytes = System.Text.Encoding.UTF8.GetByteCount(value);
        if (bytes < MinimumBytes)
        {
            throw new InvalidOperationException(
                $"Jwt:Secret is {bytes} bytes and HS256 requires at least {MinimumBytes}. A shorter key is "
                + "rejected by the signing library at first use, which would surface as a 500 on somebody's "
                + "sign-in rather than here. Generate one with `openssl rand -base64 48`.");
        }

        if (!isDevelopment && PublishedPrefixes.Any(p => value.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException(
                "Jwt:Secret is a placeholder that is committed to this repository, so it is known to anyone "
                + "with the source or the image and can be used to forge an administrator token for any "
                + "tenant. Set the Jwt__Secret environment variable to a real secret — "
                + "`openssl rand -base64 48` — and restart. Refusing to start is deliberate: a service that "
                + "came up with this value would look entirely healthy.");
        }

        return value;
    }
}
