using System.Security.Cryptography;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Fido2NetLib;
using Fido2NetLib.Objects;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

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
/// Challenge state is stashed in <see cref="IMemoryCache"/> against an opaque flow id, with
/// a 5 minute TTL. This avoids needing a session cookie and keeps the API stateless.
/// </summary>
public static class WebAuthnEndpoints
{
    private static readonly TimeSpan FlowTtl = TimeSpan.FromMinutes(5);

    public static IEndpointRouteBuilder MapWebAuthnEndpoints(this IEndpointRouteBuilder app)
    {
        var anon = app.MapGroup("/api/v1/auth/webauthn");

        // ---- Login flow ----------------------------------------------------------------

        anon.MapPost("/login/options", (IFido2 fido2, IMemoryCache cache) =>
        {
            // Empty allowCredentials → discoverable-credential ("usernameless") flow.
            var options = fido2.GetAssertionOptions(
                Array.Empty<PublicKeyCredentialDescriptor>(),
                UserVerificationRequirement.Required);

            var flowId = NewFlowId();
            cache.Set($"wa:login:{flowId}", options.ToJson(), FlowTtl);
            return Results.Ok(new { flowId, options = JsonDocument.Parse(options.ToJson()).RootElement });
        });

        anon.MapPost("/login", async (
            WebAuthnLoginRequest req,
            IFido2 fido2,
            IMemoryCache cache,
            MainframeDbContext db,
            ITenantContext tenant,
            IJwtIssuer jwt,
            CancellationToken ct) =>
        {
            if (!cache.TryGetValue<string>($"wa:login:{req.FlowId}", out var optionsJson) || optionsJson is null)
                return Results.BadRequest(new { error = "session_expired" });
            cache.Remove($"wa:login:{req.FlowId}");

            var options = AssertionOptions.FromJson(optionsJson);
            var clientResponse = req.Response;

            // Find the credential globally — the authenticator picked it for us.
            var rawId = clientResponse.Id;
            var cred = await db.WebAuthnCredentials
                .IgnoreQueryFilters()
                .FirstOrDefaultAsync(c => c.CredentialId == rawId, ct);
            if (cred is null) return Results.Unauthorized();

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

            await db.SaveChangesAsync(ct);

            var roles = new List<string> { "user" };
            if (user.IsAdmin) roles.Add("admin");
            var token = jwt.IssueAccess(user.Id, tenantRow.Id, tenantRow.Slug, roles);

            return Results.Ok(new { access_token = token, user_id = user.Id, is_admin = user.IsAdmin });
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
            IMemoryCache cache,
            MainframeDbContext db,
            CancellationToken ct) =>
        {
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
            cache.Set($"wa:reg:{userId}:{flowId}", stash, FlowTtl);

            return Results.Ok(new { flowId, options = JsonDocument.Parse(options.ToJson()).RootElement });
        });

        me.MapPost("/register", async (
            WebAuthnRegisterRequest req,
            HttpContext ctx,
            IFido2 fido2,
            IMemoryCache cache,
            MainframeDbContext db,
            ITenantContext tenant,
            CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var key = $"wa:reg:{userId}:{req.FlowId}";
            if (!cache.TryGetValue<string>(key, out var stashJson) || stashJson is null)
                return Results.BadRequest(new { error = "session_expired" });
            cache.Remove(key);

            var stash = JsonSerializer.Deserialize<RegistrationStash>(stashJson)!;
            var options = CredentialCreateOptions.FromJson(stash.OptionsJson);

            object resultBox;
            try
            {
                resultBox = await fido2.MakeNewCredentialAsync(
                    req.Response,
                    options,
                    (args, ct2) => Task.FromResult(true),  // CredentialId is unique by DB constraint
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
            await db.SaveChangesAsync(ct);

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
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        return app;
    }

    private static string NewFlowId() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
    private static byte[] NewUserHandle() => RandomNumberGenerator.GetBytes(16);

    private sealed record RegistrationStash(string Label, byte[] UserHandle, string OptionsJson);
}

public sealed record WebAuthnLoginRequest(string FlowId, AuthenticatorAssertionRawResponse Response);
public sealed record WebAuthnRegisterOptionsRequest(string Label);
public sealed record WebAuthnRegisterRequest(string FlowId, AuthenticatorAttestationRawResponse Response, string[]? Transports);
