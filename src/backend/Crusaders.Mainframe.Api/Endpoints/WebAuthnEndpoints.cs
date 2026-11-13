using System.Security.Cryptography;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Fido2NetLib;
using Fido2NetLib.Objects;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// WebAuthn / passkey endpoints. Two flows:
///
/// <para><b>Login</b> — anonymous discoverable-credential flow. The client requests options
/// (no email needed), the authenticator picks a credential, and we look up the user via
/// the returned <c>userHandle</c>.</para>
///
/// <para><b>Register / list / delete</b> — authenticated. Add or remove passkeys for the
/// signed-in user.</para>
///
/// Challenge state is stashed in <see cref="WebAuthnFlows"/> — a bounded store of its own —
/// against an opaque flow id, with a 5 minute TTL. This avoids needing a session cookie.
///
/// <para>
/// BP-10: the anonymous half is under the sign-in rate limit like every other way in (it was its
/// own group, outside the auth limiter, so 60 option calls and 30 failed assertions a minute from
/// one address were never 429), a passkey sign-in takes the same last steps a password sign-in
/// does (the deployment's inherent admins, <c>last_login_at</c>), and adding or removing a passkey
/// mails the member and writes an audit row — a passkey quietly added to a hijacked account was
/// never announced to its owner.
/// </para>
/// </summary>
public static class WebAuthnEndpoints
{
    public static IEndpointRouteBuilder MapWebAuthnEndpoints(this IEndpointRouteBuilder app)
    {
        var anon = app.MapGroup("/api/v1/auth/webauthn").RequireRateLimiting(RateLimitPolicies.SignIn);

        // ---- Login flow ----------------------------------------------------------------

        anon.MapPost("/login/options", (IFido2 fido2, WebAuthnFlows flows) =>
        {
            // Empty allowCredentials → discoverable-credential ("usernameless") flow.
            var options = fido2.GetAssertionOptions(
                Array.Empty<PublicKeyCredentialDescriptor>(),
                UserVerificationRequirement.Required);

            var flowId = NewFlowId();
            if (!flows.TryStore($"wa:login:{flowId}", options.ToJson())) return Busy();
            return Results.Ok(new { flowId, options = JsonDocument.Parse(options.ToJson()).RootElement });
        });

        anon.MapPost("/login", async (
            WebAuthnLoginRequest req,
            IFido2 fido2,
            WebAuthnFlows flows,
            MainframeDbContext db,
            ITenantContext tenant,
            IJwtIssuer jwt,
            HttpContext ctx,
            CancellationToken ct) =>
        {
            if (flows.Take($"wa:login:{req.FlowId}") is not { } optionsJson)
                return Results.BadRequest(new { error = "session_expired" });

            var options = AssertionOptions.FromJson(optionsJson);
            var clientResponse = req.Response;

            // Find the credential globally — the authenticator picked it for us.
            var rawId = clientResponse.Id;
            var cred = await db.WebAuthnCredentials
                .IgnoreQueryFilters()
                .FirstOrDefaultAsync(c => c.CredentialId == rawId, ct);
            // A demo club is reachable only through the admin's mode switch, never by a passkey.
            if (cred is null || Services.Demo.DemoTenants.IsDemo(cred.TenantId)) return Results.Unauthorized();

            AssertionVerificationResult result;
            try
            {
                result = await fido2.MakeAssertionAsync(
                    clientResponse,
                    options,
                    cred.PublicKey,
                    (uint)cred.SignCount,
                    (args, ct2) => Task.FromResult(cred.UserHandle.AsSpan().SequenceEqual(args.UserHandle)),
                    cancellationToken: ct);
            }
            catch (Fido2VerificationException ex)
            {
                return Results.BadRequest(new { error = "verification_failed", detail = ex.Message });
            }

            cred.SignCount = result.Counter;
            cred.LastUsedAt = DateTimeOffset.UtcNow;

            // Hydrate tenant + user before issuing the JWT.
            var tenantRow = await db.Tenants.IgnoreQueryFilters().FirstAsync(t => t.Id == cred.TenantId, ct);
            tenant.Set(tenantRow.Id, tenantRow.Slug);
            var user = await db.Users.IgnoreQueryFilters().FirstAsync(u => u.Id == cred.UserId, ct);

            // Same gate as password login — refuse non-active members (admins exempt).
            var membership = await db.Memberships.IgnoreQueryFilters().FirstOrDefaultAsync(m => m.UserId == user.Id, ct);
            if (membership is not null && membership.Status != MembershipStatus.Active && !user.IsAdmin)
                return Results.StatusCode(403);

            // The password sign-in's last two steps, in its order: every refusal has run, so the
            // deployment's inherent-admin list can only add the flag to a sign-in that was going to
            // succeed (see AuthService.LoginAsync for why the position is the safety argument).
            user.LastLoginAt = DateTimeOffset.UtcNow;
            await ctx.RequestServices.GetRequiredService<InherentAdminService>().ApplyAsync(user, ct);
            await db.SaveChangesAsync(ct);

            var roles = new List<string> { "user" };
            if (user.IsAdmin) roles.Add("admin");
            var token = jwt.IssueAccess(user.Id, tenantRow.Id, tenantRow.Slug, roles, user.SessionEpoch);

            // The long-lived half of the session (B1), in the club the passkey belongs to.
            var family = await SessionCookies.StartAsync(ctx, user.Id, user.SessionEpoch, ct);
            return Results.Ok(new { access_token = SessionCookies.Bind(ctx, token, family), user_id = user.Id, is_admin = user.IsAdmin });
        });

        // ---- Authenticated registration + management ------------------------------------

        var me = app.MapGroup("/api/v1/me/webauthn").RequireAuthorization();

        me.MapGet("/credentials", async (
            HttpContext ctx,
            MainframeDbContext db,
            CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var rows = await db.WebAuthnCredentials
                .Where(c => c.UserId == userId)
                .OrderByDescending(c => c.CreatedAt)
                .Select(c => new
                {
                    id = c.Id,
                    label = c.Label,
                    transports = c.Transports,
                    created_at = c.CreatedAt,
                    last_used_at = c.LastUsedAt,
                })
                .ToListAsync(ct);
            return Results.Ok(rows);
        });

        me.MapPost("/register/options", async (
            WebAuthnRegisterOptionsRequest req,
            HttpContext ctx,
            IFido2 fido2,
            WebAuthnFlows flows,
            MainframeDbContext db,
            CancellationToken ct) =>
        {
            // The demo's mirror admin is reachable only through the mode switch (demo mode).
            if (Services.Demo.DemoTenants.IsDemo(ctx.RequestServices.GetRequiredService<ITenantContext>().TenantId))
                return Services.Demo.DemoTenants.Refusal();
            var userId = ctx.User.Id() ?? Guid.Empty;
            var user = await db.Users.FirstAsync(u => u.Id == userId, ct);
            var membership = await db.Memberships.FirstOrDefaultAsync(m => m.UserId == userId, ct);
            var displayName = membership?.FullName ?? user.Email;

            // Stable per-user handle so a single user with multiple authenticators is consistent
            // to the browser. Store with the credential row.
            var handle = NewUserHandle();

            var fidoUser = new Fido2User
            {
                DisplayName = displayName,
                Name = user.Email,
                Id = handle,
            };

            // Exclude already-registered credentials so the authenticator won't double up.
            var existing = await db.WebAuthnCredentials
                .Where(c => c.UserId == userId)
                .Select(c => c.CredentialId)
                .ToListAsync(ct);
            var exclude = existing
                .Select(id => new PublicKeyCredentialDescriptor(id))
                .ToList();

            var authenticatorSelection = new AuthenticatorSelection
            {
                RequireResidentKey = true,
                UserVerification = UserVerificationRequirement.Required,
            };

            var options = fido2.RequestNewCredential(
                fidoUser,
                exclude,
                authenticatorSelection,
                AttestationConveyancePreference.None);

            var flowId = NewFlowId();
            var stash = JsonSerializer.Serialize(new RegistrationStash(req.Label, handle, options.ToJson()));
            if (!flows.TryStore($"wa:reg:{userId}:{flowId}", stash)) return Busy();

            return Results.Ok(new { flowId, options = JsonDocument.Parse(options.ToJson()).RootElement });
        });

        me.MapPost("/register", async (
            WebAuthnRegisterRequest req,
            HttpContext ctx,
            IFido2 fido2,
            WebAuthnFlows flows,
            MainframeDbContext db,
            ITenantContext tenant,
            CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            if (flows.Take($"wa:reg:{userId}:{req.FlowId}") is not { } stashJson)
                return Results.BadRequest(new { error = "session_expired" });

            var stash = JsonSerializer.Deserialize<RegistrationStash>(stashJson)!;
            var options = CredentialCreateOptions.FromJson(stash.OptionsJson);

            object resultBox;
            try
            {
                resultBox = await fido2.MakeNewCredentialAsync(
                    req.Response,
                    options,
                    // BP-16: a credential already registered anywhere is refused here, as a refusal —
                    // left to the unique index it surfaced as "busy, retry", which can never succeed.
                    (args, ct2) => CredentialIdIsFreeAsync(db, args.CredentialId, ct2),
                    cancellationToken: ct);
            }
            catch (Fido2VerificationException ex)
            {
                return Results.BadRequest(new { error = "verification_failed", detail = ex.Message });
            }

            // CredentialMakeResult is internal in 3.0.1 — reach for its `Result` property reflectively
            // to grab the AttestationVerificationSuccess payload (PublicKey/CredentialId/Counter).
            var resultProp = resultBox.GetType().GetProperty("Result")
                ?? throw new InvalidOperationException("fido2_result_shape_unknown");
            var data = resultProp.GetValue(resultBox)
                ?? throw new InvalidOperationException("attestation_succeeded_without_result");
            byte[] credentialId = (byte[])data.GetType().GetProperty("CredentialId")!.GetValue(data)!;
            byte[] publicKey = (byte[])data.GetType().GetProperty("PublicKey")!.GetValue(data)!;
            uint counter = (uint)data.GetType().GetProperty("Counter")!.GetValue(data)!;
            Guid aaguid = (Guid)(data.GetType().GetProperty("Aaguid")?.GetValue(data) ?? Guid.Empty);

            var label = string.IsNullOrWhiteSpace(stash.Label) ? "Passkey" : stash.Label.Trim();

            var transports = req.Transports is { Length: > 0 }
                ? string.Join(",", req.Transports)
                : null;

            var entity = new WebAuthnCredential
            {
                TenantId = tenant.TenantId,
                UserId = userId,
                CredentialId = credentialId,
                PublicKey = publicKey,
                UserHandle = stash.UserHandle,
                SignCount = counter,
                AaGuid = aaguid,
                Transports = transports,
                Label = label,
            };
            db.WebAuthnCredentials.Add(entity);
            await PasskeyChangedAsync(ctx, db, userId, entity.Label, added: true, ct);

            return Results.Ok(new { id = entity.Id, label = entity.Label });
        });

        me.MapDelete("/credentials/{id:guid}", async (
            Guid id,
            HttpContext ctx,
            MainframeDbContext db,
            CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var row = await db.WebAuthnCredentials.FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId, ct);
            if (row is null) return Results.NotFound();
            db.WebAuthnCredentials.Remove(row);
            await PasskeyChangedAsync(ctx, db, userId, row.Label, added: false, ct);
            return Results.NoContent();
        });

        return app;
    }

    /// <summary>
    /// Whether no account in any club holds this credential id yet. The ids are globally unique
    /// by index; asked first so a duplicate is the ceremony's refusal, not a lost race.
    /// </summary>
    internal static async Task<bool> CredentialIdIsFreeAsync(MainframeDbContext db, byte[] credentialId, CancellationToken ct)
    {
        // Block body: lizard mis-scopes an expression body into a file-long *global* (memory/gotchas-gates.md).
        var taken = await db.WebAuthnCredentials.IgnoreQueryFilters().AnyAsync(c => c.CredentialId == credentialId, ct);
        return !taken;
    }

    /// <summary>The 503 a full ceremony store answers — the stable busy code every client already words.</summary>
    private static IResult Busy()
    {
        return Results.Json(new { error = "service_busy", message = "Too many sign-ins are in progress. Try again in a moment." }, statusCode: 503);
    }

    /// <summary>
    /// Saves a passkey added or removed with its audit row, then queues the member's mail. A mail
    /// that cannot be queued is logged: the change has committed (the email-outbox rule).
    /// </summary>
    private static async Task PasskeyChangedAsync(HttpContext ctx, MainframeDbContext db, Guid userId, string label, bool added, CancellationToken ct)
    {
        var user = await db.Users.FirstAsync(u => u.Id == userId, ct);
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = user.TenantId,
            ActorUserId = userId,
            SubjectUserId = userId,
            Action = added ? "user.passkey_added" : "user.passkey_removed",
            DetailsJson = JsonSerializer.Serialize(new { label }),
        });
        await db.SaveChangesAsync(ct);

        var services = ctx.RequestServices;
        var club = await services.GetRequiredService<Email.ClubIdentityResolver>().GetAsync(ct);
        var message = added ? Email.EmailTemplates.PasskeyAdded(club, user.Email, label) : Email.EmailTemplates.PasskeyRemoved(club, user.Email, label);
        await Email.EmailDispatch.QueueAsync(
            services.GetRequiredService<Email.IEmailService>(), services.GetRequiredService<ILoggerFactory>().CreateLogger("Passkeys"),
            message, $"passkey {(added ? "added" : "removed")} notice for {user.Email}");
    }

    private static string NewFlowId() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
    private static byte[] NewUserHandle() => RandomNumberGenerator.GetBytes(16);

    private sealed record RegistrationStash(string Label, byte[] UserHandle, string OptionsJson);
}

public sealed record WebAuthnLoginRequest(string FlowId, AuthenticatorAssertionRawResponse Response);
public sealed record WebAuthnRegisterOptionsRequest(string Label);
public sealed record WebAuthnRegisterRequest(string FlowId, AuthenticatorAttestationRawResponse Response, string[]? Transports);
