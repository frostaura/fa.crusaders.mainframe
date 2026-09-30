using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Api.Security;

public interface IJwtIssuer
{
    /// <param name="sessionEpoch">The account's <c>SessionEpoch</c> the token is minted under — see <see cref="SessionEpochs"/>.</param>
    string IssueAccess(Guid userId, Guid tenantId, string tenantSlug, IEnumerable<string> roles, int sessionEpoch);

    /// <summary>A purpose-scoped ticket carrying no roles — the wallet stream's, where the subject is the holder and there is nothing to be a role about.</summary>
    string IssueOneTime(Guid userId, Guid tenantId, string tenantSlug, TicketScope scope, int sessionEpoch);

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
        Guid userId, Guid tenantId, string tenantSlug, TicketScope scope, IEnumerable<string> roles, int sessionEpoch);

    /// <summary>
    /// The same access token, re-signed with the refresh family it belongs to
    /// (<see cref="RefreshSessions.FamilyClaim"/>, review round 2, C1) — every token a sign-in or
    /// a refresh hands out is bound, so a bearer refresh can be refused once that family is ended.
    /// Only ever given a token this issuer has just minted; its claims and expiry are kept.
    /// </summary>
    string BindToFamily(string accessToken, Guid familyId);
}

/// <summary>What a one-time ticket is for, and for how long: its purpose (the one path it opens) and its lifetime.</summary>
public sealed record TicketScope(string Purpose, TimeSpan Ttl);

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

    public string IssueAccess(Guid userId, Guid tenantId, string tenantSlug, IEnumerable<string> roles, int sessionEpoch)
    {
        var ttl = TimeSpan.FromMinutes(_config.GetValue("Jwt:AccessTokenExpiryMinutes", 15));
        return Issue(new TokenSubject(userId, tenantId, tenantSlug, sessionEpoch), "access", ttl, roles);
    }

    public string IssueOneTime(Guid userId, Guid tenantId, string tenantSlug, TicketScope scope, int sessionEpoch)
        => Issue(new TokenSubject(userId, tenantId, tenantSlug, sessionEpoch), scope.Purpose, scope.Ttl, Array.Empty<string>());

    public string IssueOneTime(
        Guid userId, Guid tenantId, string tenantSlug, TicketScope scope, IEnumerable<string> roles, int sessionEpoch)
        => Issue(new TokenSubject(userId, tenantId, tenantSlug, sessionEpoch), scope.Purpose, scope.Ttl, roles);

    public string BindToFamily(string accessToken, Guid familyId)
    {
        var minted = new JwtSecurityTokenHandler().ReadJwtToken(accessToken);
        var claims = minted.Claims
            .Where(c => !RegisteredOnReissue.Contains(c.Type))
            .Append(new Claim(RefreshSessions.FamilyClaim, familyId.ToString()));
        var secret = _config["Jwt:Secret"] ?? throw new InvalidOperationException("Jwt:Secret missing");
        var creds = new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret)), SecurityAlgorithms.HmacSha256);
        var token = new JwtSecurityToken(
            issuer: _config["Jwt:Issuer"] ?? DefaultIssuer,
            audience: _config["Jwt:Audience"] ?? DefaultAudience,
            claims: claims,
            notBefore: minted.ValidFrom,
            expires: minted.ValidTo,
            signingCredentials: creds);
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    /// <summary>Claims the token constructor writes itself, and the family claim being replaced.</summary>
    private static readonly HashSet<string> RegisteredOnReissue = new(StringComparer.Ordinal)
    {
        JwtRegisteredClaimNames.Iss, JwtRegisteredClaimNames.Aud, JwtRegisteredClaimNames.Exp,
        JwtRegisteredClaimNames.Nbf, JwtRegisteredClaimNames.Iat, RefreshSessions.FamilyClaim,
    };

    /// <summary>Whose token it is, where, and under which session epoch.</summary>
    private sealed record TokenSubject(Guid UserId, Guid TenantId, string TenantSlug, int SessionEpoch);

    private string Issue(TokenSubject subject, string purpose, TimeSpan ttl, IEnumerable<string> roles)
    {
        var (userId, tenantId, tenantSlug, sessionEpoch) = subject;
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
            // The session epoch it was minted under: a rotation raises the account's, and
            // every token below it is refused — see SessionEpochs.
            new(SessionEpochs.EpochClaim, SessionEpochs.Format(sessionEpoch)),
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
