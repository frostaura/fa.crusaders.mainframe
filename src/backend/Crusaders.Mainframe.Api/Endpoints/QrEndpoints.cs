using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Api.Endpoints;



/// <summary>
/// Phase 8.6 — QR identification (third leg of blueprint B.1's triple-stack alongside biometric + PIN).
///
/// Flow:
///   1. Player's PWA calls <c>POST /api/v1/me/qr/generate</c> → returns a JWT with purpose=qr_ident,
///      sub=user_id, tenant_id, exp=60s. The PWA renders this JWT as a QR code on screen.
///   2. Courtside camera scans the QR → frontend posts <c>POST /api/v1/court/{n}/qr/match</c> with
///      the token. Backend verifies signature + purpose + expiry + that the user has an active
///      booking on this court within the grace window.
///
/// JWT signing reuses the existing <c>Jwt:Secret</c> — the qr_ident purpose claim prevents cross-use
/// with login JWTs (and the 60s expiry keeps replay risk tiny).
/// </summary>
public static class QrEndpoints
{
    public static IEndpointRouteBuilder MapQrEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/v1/me/qr/generate", (HttpContext ctx, IConfiguration config, Crusaders.Mainframe.Api.Multitenancy.ITenantContext tenant) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            if (userId == Guid.Empty) return Results.Unauthorized();

            var secret = config["Jwt:Secret"] ?? throw new InvalidOperationException("Jwt:Secret missing");
            var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret));
            var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

            var claims = new List<Claim>
            {
                new(JwtRegisteredClaimNames.Sub, userId.ToString()),
                new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
                new("tenant_id", tenant.TenantId.ToString()),
                new("tenant_slug", tenant.TenantSlug),
                new("purpose", "qr_ident"),
            };

            var token = new JwtSecurityToken(
                issuer: config["Jwt:Issuer"],
                audience: config["Jwt:Audience"],
                claims: claims,
                notBefore: DateTime.UtcNow,
                expires: DateTime.UtcNow.AddSeconds(60),
                signingCredentials: creds);
            var jwt = new JwtSecurityTokenHandler().WriteToken(token);

            return Results.Ok(new { token = jwt, expires_in_seconds = 60 });
        }).RequireAuthorization()
          .RequireRateLimiting(RateLimitPolicies.Auth);

        app.MapPost("/api/v1/court/{courtNumber:int}/qr/match", async (
            int courtNumber, QrMatchRequest req,
            MainframeDbContext db,
            IdentificationResolver identities,
            CourtActivationService activation,
            CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(req.Token)) return Results.BadRequest(new { error = "token_required" });

            // Verified through the shared resolver rather than inline here. There were two
            // copies of this — one for the courtside camera and one that would have been
            // written for the court box's walk-up path — and two implementations of "is this
            // token real" is one implementation more than a security check should ever have.
            var resolved = identities.VerifyQrToken(req.Token);
            if (resolved is null) return Results.Ok(new { matched = false, reason = "invalid_or_expired" });
            var userId = resolved.Value;

            // Identify AND activate. This used to confirm a booking existed and return a
            // user_id — no ledger post, no CheckedInAt, no event, no audit row. So a
            // member who identified by QR played free and was swept as a no-show, since
            // attendance is CheckedInAt and nothing here set it.
            var court = await db.Courts.FirstOrDefaultAsync(c => c.CourtNumber == courtNumber, ct);
            if (court is null) return Results.NotFound();

            var now = DateTimeOffset.UtcNow;

            // Shared window: was hardcoded at -30 minutes here while the no-show sweep used
            // the tenant's grace setting, so the two disagreed about the same booking.
            var booking = await activation.FindForUserAsync(court.Id, userId, now, ct);
            if (booking is null) return Results.Ok(new { matched = false, reason = "no_active_booking" });

            var result = await activation.ActivateAsync(
                court, booking, identifiedUserId: userId, payerOverrideUserId: null, method: "qr", ct);

            return CourtActivationResponse.For(result, userId);
        }).RequireAuthorization(p => p.RequireRole("admin"))
          .RequireRateLimiting(RateLimitPolicies.Auth);

        return app;
    }
}

public sealed record QrMatchRequest(string? Token);
