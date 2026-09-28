using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Api.Security;

public interface IJwtIssuer
{
    string IssueAccess(Guid userId, Guid tenantId, string tenantSlug, IEnumerable<string> roles);

    /// <summary>A purpose-scoped ticket carrying no roles — the wallet stream's, where the subject is the holder and there is nothing to be a role about.</summary>
    string IssueOneTime(Guid userId, Guid tenantId, string tenantSlug, string purpose, TimeSpan ttl);

    /// <summary>
    /// A purpose-scoped ticket that still says what the holder IS.
    ///
    /// <para>
    /// <b>An admin stream needs this and the roleless overload cannot give it.</b> The ticket is
    /// the only credential on a stream route — <c>EventSource</c> cannot set an
    /// <c>Authorization</c> header — so the role policy cannot be what admits the request, and
    /// the handler has to check the role itself. A ticket minted without roles makes that check
    /// fail for everyone, including the admin who minted it, and the route is then 403 for its
    /// entire audience with nothing logged anywhere.
    /// </para>
    ///
    /// <para>
    /// It carries no more authority than the roleless one: the purpose is accepted on exactly
    /// one path (<see cref="TokenPurposes.IsValidFor"/>), so the role inside it cannot be spent
    /// anywhere else.
    /// </para>
    /// </summary>
    string IssueOneTime(
        Guid userId, Guid tenantId, string tenantSlug, string purpose, TimeSpan ttl, IEnumerable<string> roles);
}

public sealed class JwtIssuer : IJwtIssuer
{
    /// <summary>
    /// The issuer and audience a token carries when nothing configures them.
    /// </summary>
    /// <remarks>
    /// <para>
    /// These have to be the same two strings the bearer middleware validates against, and they
    /// were not: <c>Program.cs</c> fell back to these values while this class read the config key
    /// and accepted <c>null</c>. An API booted without <c>appsettings.json</c> — which happens for
    /// real, because a checkout under a dot-directory on macOS is excluded by
    /// <c>PhysicalFileProvider</c>'s Sensitive filter — therefore minted tokens with no
    /// <c>iss</c>/<c>aud</c> at all and then refused every one of them on the next request. The
    /// symptom is a login that succeeds and a session that is anonymous a moment later, with
    /// nothing logged anywhere. One pair of constants, used by both halves, is the fix.
    /// </para>
    /// </remarks>
    public const string DefaultIssuer = "crusaders.mainframe";

    /// <inheritdoc cref="DefaultIssuer"/>
    public const string DefaultAudience = "crusaders.mainframe.app";

    private readonly IConfiguration _config;
    public JwtIssuer(IConfiguration config) => _config = config;

    public string IssueAccess(Guid userId, Guid tenantId, string tenantSlug, IEnumerable<string> roles)
    {
        var ttl = TimeSpan.FromMinutes(_config.GetValue("Jwt:AccessTokenExpiryMinutes", 15));
        return Issue(userId, tenantId, tenantSlug, "access", ttl, roles);
    }

    public string IssueOneTime(Guid userId, Guid tenantId, string tenantSlug, string purpose, TimeSpan ttl)
        => Issue(userId, tenantId, tenantSlug, purpose, ttl, Array.Empty<string>());

    public string IssueOneTime(
        Guid userId, Guid tenantId, string tenantSlug, string purpose, TimeSpan ttl, IEnumerable<string> roles)
        => Issue(userId, tenantId, tenantSlug, purpose, ttl, roles);

    private string Issue(Guid userId, Guid tenantId, string tenantSlug, string purpose, TimeSpan ttl, IEnumerable<string> roles)
    {
        var secret = _config["Jwt:Secret"] ?? throw new InvalidOperationException("Jwt:Secret missing");
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, userId.ToString()),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
            new("tenant_id", tenantId.ToString()),
            new("tenant_slug", tenantSlug),
            new("purpose", purpose),
            // Milliseconds, so a rotation's cut-off can tell a token re-issued in the same
            // second from one minted before it — see SessionCutoff.
            new(SessionCutoff.IssuedAtMsClaim, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(System.Globalization.CultureInfo.InvariantCulture)),
        };
        foreach (var role in roles) claims.Add(new Claim(ClaimTypes.Role, role));

        var token = new JwtSecurityToken(
            issuer: _config["Jwt:Issuer"] ?? DefaultIssuer,
            audience: _config["Jwt:Audience"] ?? DefaultAudience,
            claims: claims,
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.Add(ttl),
            signingCredentials: creds);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}

public static class TokenHashing
{
    /// <summary>SHA-256 hash of a token, hex-encoded — used to store one-time tokens at rest without the plaintext.</summary>
    public static string Hash(string token)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        return Convert.ToHexString(bytes);
    }

    /// <summary>Cryptographically random URL-safe token, ~32 bytes of entropy.</summary>
    public static string Generate()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToBase64String(bytes).Replace("+", "-").Replace("/", "_").TrimEnd('=');
    }
}
