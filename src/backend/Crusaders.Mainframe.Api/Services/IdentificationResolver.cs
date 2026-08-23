using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Turns what a member presented at a court into a user, when there is no booking to
/// narrow the search down.
///
/// <para>
/// <b>This is deliberately not the same question the courtside match endpoints ask.</b>
/// Those resolve an identification <i>against a candidate set</i> — the handful of members
/// with a booking on that court in the grace window — which is what makes a four-digit PIN
/// usable at all. Here there is no booking yet, because the member is buying court time
/// they have not reserved.
/// </para>
///
/// <para>
/// So the methods that work here are the ones that identify a member <b>globally</b>, and
/// PIN is not one of them. A PIN checked against every member in the club is a 10,000-space
/// oracle over the whole roll, not over four people — and the club has far fewer than 10,000
/// members, so a random four digits would frequently match <i>somebody</i>. Refusing is the
/// only correct answer, and it is refused with a reason rather than silently returning null.
/// </para>
/// </summary>
public sealed class IdentificationResolver
{
    private readonly IConfiguration _config;

    public IdentificationResolver(IConfiguration config) => _config = config;

    /// <summary>Methods that can identify a member without a booking to check against.</summary>
    public static bool CanIdentifyGlobally(string? method)
        => string.Equals(method, "qr", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// The user this token identifies, or null. Null covers every failure — expired,
    /// tampered, wrong purpose, unsupported method — on purpose: telling them apart at a
    /// court box turns it into an oracle for which tokens are real.
    /// </summary>
    public Task<Guid?> ResolveAsync(string? method, string? token, CancellationToken ct)
    {
        if (!CanIdentifyGlobally(method) || string.IsNullOrWhiteSpace(token))
        {
            return Task.FromResult<Guid?>(null);
        }
        return Task.FromResult(VerifyQrToken(token));
    }

    /// <summary>
    /// Verifies a <c>qr_ident</c> token and returns its subject.
    ///
    /// <para>
    /// The lifetime check is the point: these are minted with a 60-second expiry, which is
    /// also why a QR token can never be cached on a court box for offline use. A box holding
    /// a stable copy of somebody's identity is a box that opens a court for them forever.
    /// </para>
    /// </summary>
    public Guid? VerifyQrToken(string token)
    {
        var secret = _config["Jwt:Secret"];
        if (string.IsNullOrWhiteSpace(secret)) return null;

        var handler = new JwtSecurityTokenHandler();
        ClaimsPrincipal principal;
        try
        {
            principal = handler.ValidateToken(token, new TokenValidationParameters
            {
                ValidateIssuer = true,
                ValidateAudience = true,
                ValidateLifetime = true,
                ValidateIssuerSigningKey = true,
                ValidIssuer = _config["Jwt:Issuer"],
                ValidAudience = _config["Jwt:Audience"],
                IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret)),
                ClockSkew = TimeSpan.FromSeconds(10),
            }, out _);
        }
        catch
        {
            return null;
        }

        // The purpose claim is what stops a login JWT — same key, same issuer, much longer
        // life — being held up to a camera.
        if (principal.FindFirstValue("purpose") != "qr_ident") return null;

        var sub = principal.FindFirstValue(JwtRegisteredClaimNames.Sub)
                  ?? principal.FindFirstValue(ClaimTypes.NameIdentifier);

        return Guid.TryParse(sub, out var userId) ? userId : null;
    }
}
