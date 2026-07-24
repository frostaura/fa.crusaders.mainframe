using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.AspNetCore.Authorization;
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
        }).RequireAuthorization();

        app.MapPost("/api/v1/court/{courtNumber:int}/qr/match", async (
            int courtNumber, QrMatchRequest req,
            MainframeDbContext db, IConfiguration config,
            CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(req.Token)) return Results.BadRequest(new { error = "token_required" });

            var secret = config["Jwt:Secret"] ?? throw new InvalidOperationException("Jwt:Secret missing");
            var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret));
            var handler = new JwtSecurityTokenHandler();

            ClaimsPrincipal principal;
            try
            {
                principal = handler.ValidateToken(req.Token, new TokenValidationParameters
                {
                    ValidateIssuer = true,
                    ValidateAudience = true,
                    ValidateLifetime = true,
                    ValidateIssuerSigningKey = true,
                    ValidIssuer = config["Jwt:Issuer"],
                    ValidAudience = config["Jwt:Audience"],
                    IssuerSigningKey = key,
                    ClockSkew = TimeSpan.FromSeconds(10),
                }, out _);
            }
            catch
            {
                return Results.Ok(new { matched = false, reason = "invalid_or_expired" });
            }

            var purpose = principal.FindFirstValue("purpose");
            if (purpose != "qr_ident") return Results.Ok(new { matched = false, reason = "wrong_purpose" });

            var sub = principal.FindFirstValue(JwtRegisteredClaimNames.Sub) ?? principal.FindFirstValue(ClaimTypes.NameIdentifier);
            if (!Guid.TryParse(sub, out var userId)) return Results.Ok(new { matched = false, reason = "no_sub" });

            // Confirm the user has an active booking on this court within the grace window.
            var court = await db.Courts.FirstOrDefaultAsync(c => c.CourtNumber == courtNumber, ct);
            if (court is null) return Results.NotFound();

            var now = DateTimeOffset.UtcNow;
            var windowStart = now.AddMinutes(-30);
            var windowEnd = now.AddHours(2);

            var hasBooking = await db.Bookings.AnyAsync(b =>
                b.CourtId == court.Id
                && b.UserId == userId
                && b.Status == BookingStatus.Booked
                && b.StartsAt < windowEnd && b.EndsAt > windowStart, ct);

            if (!hasBooking) return Results.Ok(new { matched = false, reason = "no_active_booking" });

            return Results.Ok(new { matched = true, user_id = userId });
        }).RequireAuthorization(p => p.RequireRole("admin"));

        return app;
    }
}

public sealed record QrMatchRequest(string? Token);
