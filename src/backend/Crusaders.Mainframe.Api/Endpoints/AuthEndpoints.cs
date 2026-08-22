using System.Security.Claims;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.RateLimiting;

namespace Crusaders.Mainframe.Api.Endpoints;



public static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        // Rate-limited as a group. Login and reset are password oracles; register is a
        // membership-number oracle; every one of them is anonymous by necessity.
        var g = app.MapGroup("/api/v1/auth").RequireRateLimiting(RateLimitPolicies.Auth);

        g.MapPost("/register", async (RegisterRequest req, AuthService auth, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.Email) || string.IsNullOrWhiteSpace(req.Password) || string.IsNullOrWhiteSpace(req.FullName) || string.IsNullOrWhiteSpace(req.MembershipNumber))
                return Results.BadRequest(new { error = "missing_fields" });
            if (req.Password.Length < 8)
                return Results.BadRequest(new { error = "password_too_short" });

            var result = await auth.RegisterAsync(req.Email, req.Password, req.FullName, req.MembershipNumber, req.PhotoUrl, ct);
            return result switch
            {
                RegistrationResult.Created c => Results.Ok(new { user_id = c.UserId, status = "pending_email_verification" }),
                RegistrationResult.AlreadyExists => Results.Conflict(new { error = "email_in_use" }),
                _ => Results.Problem("Unexpected"),
            };
        }).AllowAnonymous();

        g.MapPost("/verify-email/{token}", async (string token, AuthService auth, CancellationToken ct) =>
        {
            var ok = await auth.VerifyEmailAsync(token, ct);
            return ok ? Results.Ok(new { verified = true }) : Results.BadRequest(new { error = "invalid_or_expired" });
        }).AllowAnonymous();

        g.MapPost("/login", async (LoginRequest req, AuthService auth, CancellationToken ct) =>
        {
            var result = await auth.LoginAsync(req.Email, req.Password, ct);
            return result switch
            {
                LoginResult.Ok ok => Results.Ok(new { access_token = ok.AccessToken, user_id = ok.UserId, is_admin = ok.IsAdmin }),
                LoginResult.InvalidCredentials => Results.Unauthorized(),
                LoginResult.EmailNotVerified => Results.StatusCode(403),
                LoginResult.NotApproved na => Results.Json(new { error = "not_approved", status = na.Status.ToString() }, statusCode: 403),
                _ => Results.Problem("Unexpected"),
            };
        }).AllowAnonymous();

        g.MapPost("/forgot-password", async (ForgotPasswordRequest req, AuthService auth, CancellationToken ct) =>
        {
            await auth.RequestPasswordResetAsync(req.Email, ct);
            // Always return ok — don't leak whether the email exists.
            return Results.Ok(new { ok = true });
        }).AllowAnonymous();

        g.MapPost("/reset-password", async (ResetPasswordRequest req, AuthService auth, CancellationToken ct) =>
        {
            if (req.NewPassword.Length < 8) return Results.BadRequest(new { error = "password_too_short" });
            var ok = await auth.ResetPasswordAsync(req.Token, req.NewPassword, ct);
            return ok ? Results.Ok(new { reset = true }) : Results.BadRequest(new { error = "invalid_or_expired" });
        }).AllowAnonymous();

        g.MapPost("/magic-link/{token}", async (string token, AuthService auth, CancellationToken ct) =>
        {
            var result = await auth.ConsumeMagicLinkAsync(token, ct);
            return result switch
            {
                LoginResult.Ok ok => Results.Ok(new { access_token = ok.AccessToken, user_id = ok.UserId, is_admin = ok.IsAdmin }),
                _ => Results.BadRequest(new { error = "invalid_or_expired" }),
            };
        }).AllowAnonymous();

        // Refresh the access token for an already-authenticated user. Caller must present a still-valid
        // JWT; we re-mint with a fresh expiry so an active session never silently expires under the user.
        g.MapPost("/refresh", async (HttpContext ctx, AuthService auth, CancellationToken ct) =>
        {
            var sub = ctx.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
                   ?? ctx.User.FindFirst("sub")?.Value;
            if (!Guid.TryParse(sub, out var userId)) return Results.Unauthorized();
            var result = await auth.RefreshAsync(userId, ct);
            return result switch
            {
                LoginResult.Ok ok => Results.Ok(new { access_token = ok.AccessToken, user_id = ok.UserId, is_admin = ok.IsAdmin }),
                _ => Results.Unauthorized(),
            };
        }).RequireAuthorization();

        // Dev-only shortcut: force-resets the seeded admin's password and returns a session token.
        // Keeps the "Sign in as seeded admin" UI button reliable even after password drift during tests.
        g.MapPost("/dev/admin-login", async (AuthService auth, IHostEnvironment env, CancellationToken ct) =>
        {
            if (!env.IsDevelopment()) return Results.NotFound();
            var result = await auth.DevAdminLoginAsync(ct);
            return result switch
            {
                LoginResult.Ok ok => Results.Ok(new { access_token = ok.AccessToken, user_id = ok.UserId, is_admin = ok.IsAdmin }),
                _ => Results.Problem("Seeded admin not found"),
            };
        }).AllowAnonymous();

        return app;
    }
}

public sealed record RegisterRequest(string Email, string Password, string FullName, string MembershipNumber, string? PhotoUrl);
public sealed record LoginRequest(string Email, string Password);
public sealed record ForgotPasswordRequest(string Email);
public sealed record ResetPasswordRequest(string Token, string NewPassword);

public static class CurrentUser
{
    public static Guid? Id(this ClaimsPrincipal? user)
        => Guid.TryParse(user?.FindFirstValue(ClaimTypes.NameIdentifier) ?? user?.FindFirstValue("sub"), out var id) ? id : null;
    public static bool IsAdmin(this ClaimsPrincipal? user)
        => user?.IsInRole("admin") ?? false;
}
