using System.IdentityModel.Tokens.Jwt;
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
        var g = app.MapGroup("/api/v1/auth").RequireRateLimiting(RateLimitPolicies.Auth).RefuseUnstorableText();

        g.MapPost("/register", RegisterAsync).AllowAnonymous();

        // Re-send the address-confirmation email. Anonymous by necessity — the member cannot sign
        // in until it is done — and deliberately incurious: it answers 200 whether or not the
        // address exists, so it is not an account-enumeration oracle. Rate-limited with the rest
        // of the group.
        g.MapPost("/resend-verification", async (ResendVerificationRequest req, AuthService auth, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.Email)) return Results.BadRequest(new { error = "missing_fields" });
            await auth.ResendVerificationAsync(req.Email, ct);
            return Results.Ok(new { ok = true });
        }).AllowAnonymous();

        // BP-18: the token in the BODY is the form clients use — a path segment is in every access
        // log in front of the API. The path form stays for a page loaded from an older build;
        // the gateway's access log blanks it (nginx/nginx.conf).
        g.MapPost("/verify-email", (OneTimeTokenRequest req, AuthService auth, CancellationToken ct) => VerifyAsync(req.Token, auth, ct)).AllowAnonymous();
        g.MapPost("/verify-email/{token}", (string token, AuthService auth, CancellationToken ct) => VerifyAsync(token, auth, ct)).AllowAnonymous();

        g.MapPost("/login", async (
            LoginRequest req, HttpContext ctx, AuthService auth, TenantSettingsAccessor settingsAccessor, CancellationToken ct) =>
        {
            // A body missing either field is a malformed request, not a wrong password: it
            // answered 500 internal_error from deep inside the sign-in (review round 6, J6-10).
            // Shape only — it says nothing about whether any account exists.
            if (string.IsNullOrWhiteSpace(req.Email) || string.IsNullOrEmpty(req.Password)) return MissingFields();
            if (AccountLimited(ctx, "login", req.Email) is { } limited) return limited;
            var result = await auth.LoginAsync(req.Email, req.Password, ct);
            return result switch
            {
                LoginResult.Ok ok => await SessionCookies.SignedInAsync(ctx, ok, ct),
                LoginResult.InvalidCredentials => Results.Unauthorized(),
                // Was a bare 403 with an empty body, indistinguishable from not_approved — so the
                // screen said "Your account isn't approved yet" to members who were approved and
                // had simply never clicked the verify link, and offered them nothing to do about it.
                LoginResult.EmailNotVerified => Results.Json(new { error = "email_not_verified" }, statusCode: 403),
                LoginResult.NotApproved na => Results.Json(
                    new
                    {
                        error = "not_approved",
                        status = na.Status.ToString(),

                        // D8. The screen tells a pending or suspended member to "speak to the
                        // club" and had nothing for them to speak to it WITH — they cannot sign
                        // in, so every other surface carrying the club's contact is behind the
                        // door they are locked out of. This is the club's own PUBLIC contact,
                        // the same two fields already printed on the door card and shown to any
                        // member on their code page.
                        //
                        // Three narrow conditions, and each is load-bearing. Only on THIS
                        // refusal: an unknown address and a wrong password answer 401 with no
                        // body, unchanged, because a contact block appearing for one of them
                        // would make this route an account oracle. Only these two fields:
                        // nothing about the membership, the club's size, or who to ask for.
                        // And tenant-scoped like every other read — the accessor resolves the
                        // club the request arrived at, not the one the member believes in.
                        contact = await ContactAsync(settingsAccessor, ct),
                    },
                    statusCode: 403),
                _ => Results.Problem("Unexpected"),
            };
        }).AllowAnonymous().RequireRateLimiting(RateLimitPolicies.SignIn);

        g.MapPost("/forgot-password", async (ForgotPasswordRequest req, HttpContext ctx, AuthService auth, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.Email)) return MissingFields();
            if (AccountLimited(ctx, "reset", req.Email) is { } limited) return limited;
            await auth.RequestPasswordResetAsync(req.Email, ct);
            // Always return ok — don't leak whether the email exists.
            return Results.Ok(new { ok = true });
        }).AllowAnonymous().RequireRateLimiting(RateLimitPolicies.SignIn);

        g.MapPost("/reset-password", async (ResetPasswordRequest req, AuthService auth, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.Token) || req.NewPassword is null) return MissingFields();
            if (req.NewPassword.Length < 8) return Results.BadRequest(new { error = "password_too_short" });
            var ok = await auth.ResetPasswordAsync(req.Token, req.NewPassword, ct);
            return ok ? Results.Ok(new { reset = true }) : Results.BadRequest(new { error = "invalid_or_expired" });
        }).AllowAnonymous().RequireRateLimiting(RateLimitPolicies.SignIn);

        g.MapPost("/magic-link", (OneTimeTokenRequest req, HttpContext ctx, AuthService auth, CancellationToken ct) =>
            MagicLinkAsync(req.Token, ctx, auth, ct)).AllowAnonymous().RequireRateLimiting(RateLimitPolicies.SignIn);
        g.MapPost("/magic-link/{token}", (string token, HttpContext ctx, AuthService auth, CancellationToken ct) =>
            MagicLinkAsync(token, ctx, auth, ct)).AllowAnonymous().RequireRateLimiting(RateLimitPolicies.SignIn);

        // Refresh the access token (B1). Either a still-valid bearer (as before) or — with no
        // usable bearer — the httpOnly refresh cookie alone, which is what keeps a phone left idle
        // past the access token's fifteen minutes signed in. See SessionCookies.RefreshAsync.
        //
        // A membership that is no longer Active comes back as `NotApproved` and falls into the 401
        // below, deliberately: 403 would be the more descriptive status, but the browser client
        // ends a session on 401 and merely reports a 403, so a suspended member's open tab would
        // keep running on the token it already holds until that token expired on its own. The
        // sentence they get is the sign-in screen's, where the reason is named properly.
        g.MapPost("/refresh", SessionCookies.RefreshAsync).AllowAnonymous().RequireRateLimiting(RateLimitPolicies.SignIn);

        // Sign out, on the server as well as in the browser.
        //
        // Clearing localStorage is not a sign-out: a JWT is a bearer credential and stays valid
        // wherever else it reached — a second tab, a proxy log, anything that captured it —
        // until it expires on its own. This puts the presented token on the revocation list, so
        // the very next request carrying it is refused.
        //
        // Answers 204 whether or not there was anything to revoke. A member signing out has
        // nothing to do differently on a failure, and an endpoint that reported which tokens it
        // recognised would be an oracle for exactly the wrong audience.
        //
        // Anonymous since B1: a member whose access token has already expired still has a refresh
        // cookie, and "sign out" on a shared phone must end THAT. The presented cookie's family is
        // revoked and the cookie cleared; a bearer, when there is one, is revoked as before.
        g.MapPost("/logout", SignOutAsync).AllowAnonymous().RequireRateLimiting(RateLimitPolicies.SignIn);

        // Dev-only shortcut: force-resets the seeded admin's password and returns a session token.
        // Keeps the "Sign in as seeded admin" UI button reliable even after password drift during tests.
        g.MapPost("/dev/admin-login", async (HttpContext ctx, AuthService auth, IHostEnvironment env, CancellationToken ct) =>
        {
            if (!env.IsDevelopment()) return Results.NotFound();
            var result = await auth.DevAdminLoginAsync(ct);
            return result switch
            {
                LoginResult.Ok ok => await SessionCookies.SignedInAsync(ctx, ok, ct),
                _ => Results.Problem("Seeded admin not found"),
            };
        }).AllowAnonymous();

        return app;
    }

    private static async Task<IResult> VerifyAsync(string? token, AuthService auth, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(token)) return Results.BadRequest(new { error = "invalid_or_expired" });
        var ok = await auth.VerifyEmailAsync(token, ct);
        return ok ? Results.Ok(new { verified = true }) : Results.BadRequest(new { error = "invalid_or_expired" });
    }

    /// <summary>
    /// The approval mail's sign-in link. A membership no longer active (suspended inside the
    /// link's life, BP-12) is told so, as the password sign-in tells it — never handed a session.
    /// </summary>
    private static async Task<IResult> MagicLinkAsync(string? token, HttpContext ctx, AuthService auth, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(token)) return Results.BadRequest(new { error = "invalid_or_expired" });
        var result = await auth.ConsumeMagicLinkAsync(token, ct);
        return result switch
        {
            LoginResult.Ok ok => await SessionCookies.SignedInAsync(ctx, ok, ct),
            LoginResult.NotApproved na => Results.Json(new { error = "not_approved", status = na.Status.ToString() }, statusCode: 403),
            _ => Results.BadRequest(new { error = "invalid_or_expired" }),
        };
    }

    /// <summary>
    /// An application. One answer for every application that is well formed (BP-14, BM-15).
    /// </summary>
    /// <remarks>
    /// <para>
    /// It used to answer <c>409 email_in_use</c> and <c>409 membership_number_in_use</c>, which
    /// told any stranger which addresses hold an account and which membership numbers the club has
    /// issued — while forgot-password and resend-verification were careful to say nothing. A
    /// well-formed application now always answers <c>200 pending_email_verification</c>, the same
    /// body with no id in it, and what actually happened is told to the mailbox the application
    /// named (<see cref="AuthService.RegisterAsync"/>): the verify link, "you already have an
    /// account", or "that membership number is already registered". A lost reply's retry is no
    /// longer turned into "email in use" for the applicant's own account, either.
    /// </para>
    /// <para>
    /// The photo is checked first (BP-06, BA-13): required, issued to this club, on disk, and not
    /// another membership's. Those refusals do say something — about the request's own photo, which
    /// the caller just uploaded, never about anybody else's account.
    /// </para>
    /// </remarks>
    private static async Task<IResult> RegisterAsync(
        RegisterRequest req, AuthService auth, MemberPhotoFiles photos, Multitenancy.ITenantContext tenant,
        Persistence.MainframeDbContext db, CancellationToken ct)
    {
        if (RegistrationRules.Refusal(req) is { } refused) return refused;
        if (await MeProfileEndpoints.PhotoRefusalAsync(db, photos, tenant.TenantSlug, req.PhotoUrl, null, ct) is { } photo)
        {
            return Results.BadRequest(new { error = photo });
        }

        await auth.RegisterAsync(req.Email, req.Password, req.FullName.Trim(), req.MembershipNumber, req.PhotoUrl!.Trim(), ct);
        return Results.Ok(new { status = "pending_email_verification" });
    }

    /// <summary>
    /// Revokes the access token the caller presented.
    /// </summary>
    /// <remarks>
    /// A named method rather than an inline lambda because <c>MapAuthEndpoints</c> is scored by
    /// lizard as one function, and three more branches inside it pushed the whole registration
    /// over the complexity gate. The handler is the thing with the branches; it can own them.
    /// </remarks>
    private static async Task<IResult> SignOutAsync(HttpContext ctx, AuthService auth, CancellationToken ct)
    {
        await SessionCookies.EndAsync(ctx, ct);
        var userId = ctx.User.Id();
        var jti = ctx.User.FindFirstValue(JwtRegisteredClaimNames.Jti) ?? ctx.User.FindFirstValue("jti");
        if (userId is null || jti is null) return Results.NoContent();

        // A token with an unreadable `exp` is held for an hour rather than trusted: the ceiling
        // only bounds how long the revocation is remembered, and remembering one too long costs
        // a row, while remembering one too briefly un-revokes a live credential.
        var expiresAt = long.TryParse(ctx.User.FindFirstValue(JwtRegisteredClaimNames.Exp), out var unix)
            ? DateTimeOffset.FromUnixTimeSeconds(unix)
            : DateTimeOffset.UtcNow.AddHours(1);

        await auth.RevokeAccessTokenAsync(userId.Value, jti, expiresAt, ct);
        return Results.NoContent();
    }

    /// <summary>
    /// The per-account sign-in limit (B14): null to go ahead, else the 429. The per-address
    /// ceiling is the <see cref="RateLimitPolicies.SignIn"/> policy on the route.
    /// </summary>
    /// <summary>The 400 a body missing a required field gets — the resend route's existing answer.</summary>
    private static IResult MissingFields()
    {
        return Results.BadRequest(new { error = "missing_fields" });
    }

    private static IResult? AccountLimited(HttpContext ctx, string purpose, string? email)
    {
        var tenant = ctx.RequestServices.GetRequiredService<Multitenancy.ITenantContext>();
        var attempts = ctx.RequestServices.GetRequiredService<SignInAttempts>();
        return attempts.TryAcquire(purpose, tenant.IsResolved ? tenant.TenantId : Guid.Empty, email) ? null : SignInAttempts.Refused(ctx);
    }

    /// <summary>
    /// The club's public contact, for the one refusal that has nothing else to offer (D8).
    ///
    /// <para>
    /// The same two tenant settings the door card prints and the member's code page shows, read
    /// through <see cref="DoorSettings"/> so they are trimmed, bounded and blank-means-null
    /// here exactly as they are there. A club that has set neither gets two nulls and the
    /// screen says what it can — which is the honest state of most clubs on their first day,
    /// and is not the same as the read having failed. Block body for the lizard reason in
    /// <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static async Task<object> ContactAsync(TenantSettingsAccessor accessor, CancellationToken ct)
    {
        var settings = await accessor.GetAsync(ct);
        return new
        {
            phone = DoorSettings.ContactPhone(settings),
            email = DoorSettings.ContactEmail(settings),
        };
    }
}

/// <summary>
/// Every refusal an application can be given before a row is written, or null.
///
/// <para>
/// Extracted from the handler rather than inlined, for the reason
/// <c>memory/gotchas.md</c> records about the complexity gate: <c>MapAuthEndpoints</c> is one
/// lizard function containing eleven route lambdas, so a branch added to any of them is a
/// branch added to all of them, and the gate is failed by whichever one happens to be last.
/// </para>
///
/// <para>
/// <b>The full name's bound is the one that was missing (D-L4 / R3-37).</b>
/// <c>PUT /me/profile</c> has held it since it shipped; this route, which creates every
/// membership row in the product, checked only that the string was not whitespace and handed
/// it to a <c>varchar(255)</c>. See <see cref="PersonNames.MaxFullNameLength"/>. Trimmed before
/// the check so the value validated and the value stored are one value — <c>RegisterAsync</c>
/// stored the string exactly as sent, spaces and all.
/// </para>
/// </summary>
internal static class RegistrationRules
{
    /// <summary><c>users.email</c> is <c>varchar(320)</c>; <c>memberships.membership_number</c> <c>varchar(64)</c>.</summary>
    internal const int MaxEmailLength = 320, MaxMembershipNumberLength = 64;

    internal static IResult? Refusal(RegisterRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Email) || string.IsNullOrWhiteSpace(req.Password)
            || string.IsNullOrWhiteSpace(req.FullName) || string.IsNullOrWhiteSpace(req.MembershipNumber))
        {
            return Results.BadRequest(new { error = "missing_fields" });
        }

        if (req.Password.Length < 8) return Results.BadRequest(new { error = "password_too_short" });

        // R16 D16-1: the two columns that answered 500 for a value past their size.
        if (req.Email.Trim().Length > MaxEmailLength) return Results.BadRequest(new { error = "email_too_long", max_length = MaxEmailLength });
        if (req.MembershipNumber.Trim().Length > MaxMembershipNumberLength)
        {
            return Results.BadRequest(new { error = "membership_number_too_long", max_length = MaxMembershipNumberLength });
        }

        if (!PersonNames.IsAcceptable(req.FullName.Trim()))
        {
            return Results.BadRequest(new { error = PersonNames.FullNameInvalid, max = PersonNames.MaxFullNameLength });
        }

        return null;
    }
}

public sealed record RegisterRequest(string Email, string Password, string FullName, string MembershipNumber, string? PhotoUrl);
public sealed record LoginRequest(string Email, string Password);
public sealed record ForgotPasswordRequest(string Email);
public sealed record ResendVerificationRequest(string Email);
public sealed record ResetPasswordRequest(string Token, string NewPassword);

/// <summary>A one-time link's token, in the body where no access log records it (BP-18).</summary>
public sealed record OneTimeTokenRequest(string? Token);

public static class CurrentUser
{
    public static Guid? Id(this ClaimsPrincipal? user)
        => Guid.TryParse(user?.FindFirstValue(ClaimTypes.NameIdentifier) ?? user?.FindFirstValue("sub"), out var id) ? id : null;
}
