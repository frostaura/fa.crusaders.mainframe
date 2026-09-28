using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The member's own code (<c>docs/specs/member-code.md</c> §10): enrolment, which hands the phone
/// its secret once, and status, which never does.
///
/// <para>
/// <b>These are the only two routes that ever emit S</b>, and only the first does: over the
/// member's own authenticated session, rate-limited per member, audited, and never cached. The
/// phone imports it as a non-extractable WebCrypto key and drops the bytes. Nothing a member
/// endpoint takes is a code — codes are presented at devices only.
/// </para>
/// </summary>
public static class MeCodeEndpoints
{
    public static IEndpointRouteBuilder MapMeCodeEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/me/code").RequireAuthorization();

        // Rate-limited per member with the auth policy: enrolment is a secret leaving the server,
        // and a phone needs it once per generation, not once a second.
        g.MapPost("/enrol", EnrolAsync).RequireRateLimiting(RateLimitPolicies.Auth);
        g.MapGet("/", StatusAsync);

        // Sign out everywhere (§10): a rotation, so every session ends — this one included — and
        // every code every phone can compute stops working. The member signs in again.
        app.MapPost("/api/v1/me/sessions/revoke-all", RevokeAllAsync)
            .RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.Auth);

        return app;
    }

    /// <summary>
    /// Ends every session of the caller, including the one asking, and rotates their code. 204;
    /// the next request on any of their tokens is 401.
    /// </summary>
    private static async Task<IResult> RevokeAllAsync(
        HttpContext ctx, MainframeDbContext db, MemberCodeService codes, CancellationToken ct)
    {
        var userId = ctx.User.Id() ?? Guid.Empty;
        if (userId == Guid.Empty) return Results.Unauthorized();

        await codes.StageRotationAsync(userId, userId, "sign_out_everywhere", ct);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> EnrolAsync(
        HttpContext ctx, MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settings,
        MemberCodeService codes, CancellationToken ct)
    {
        var userId = ctx.User.Id() ?? Guid.Empty;
        if (userId == Guid.Empty) return Results.Unauthorized();
        NoStore(ctx);

        // A session a rotation ended gets no secret — read from the row, not the fifteen-second
        // cache the middleware answers from, because this is the one route whose whole purpose
        // is handing out the credential the rotation just replaced (the lost-phone case).
        if (await SessionCutoff.IsCutOffNowAsync(db, ctx.User, ct)) return Results.Unauthorized();

        // A member the club has barred gets no secret, with the same two codes the booking and
        // QR routes answer — one refusal, one sentence, wherever it surfaces.
        if (await BookingMembershipGate.RefuseIfBarredAsync(db, userId, ct) is { } barred) return barred;

        var row = await codes.EnsureAsync(userId, ct);
        row.EnrolledAt = DateTimeOffset.UtcNow;
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = tenant.TenantId,
            ActorUserId = userId,
            SubjectUserId = userId,
            Action = MemberCodeService.EnrolledAction,
            DetailsJson = JsonSerializer.Serialize(new { generation = row.Generation }),
        });
        await db.SaveChangesAsync(ct);

        var s = await settings.GetAsync(ct);
        return Results.Ok(new MemberCodeEnrolment(
            1, MemberCodeMath.RefText(row.Ref), row.Generation, MemberCodeMath.Base64Url(codes.SecretOf(row)),
            MemberCodeMath.ZoneIdFor(s.Timezone), MemberCodeMath.StepSeconds, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            MemberCodeSettings.Phase(s)));
    }

    private static async Task<IResult> StatusAsync(
        HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settings, MemberCodeService codes, CancellationToken ct)
    {
        var userId = ctx.User.Id() ?? Guid.Empty;
        if (userId == Guid.Empty) return Results.Unauthorized();
        NoStore(ctx);

        // The same refusal as enrolment, so the phone learns it from whichever it asks first
        // and stops showing a code no door will accept.
        if (await BookingMembershipGate.RefuseIfBarredAsync(db, userId, ct) is { } barred) return barred;

        var row = await codes.EnsureAsync(userId, ct);
        var s = await settings.GetAsync(ct);
        return Results.Ok(new MemberCodeStatus(
            1, MemberCodeMath.RefText(row.Ref), row.Generation, MemberCodeMath.ZoneIdFor(s.Timezone),
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), MemberCodeSettings.Phase(s)));
    }

    private static void NoStore(HttpContext ctx)
    {
        ctx.Response.Headers.CacheControl = "no-store";
        ctx.Response.Headers.Pragma = "no-cache";
    }
}

/// <summary>
/// <c>POST /api/v1/me/code/enrol</c> (§10). <c>secret</c> is S, 32 bytes, base64url unpadded
/// (43 characters). <c>phase</c> is additive beyond the spec: the club's rollout phase, so the
/// phone knows whether to show a v1 code yet.
/// </summary>
public sealed record MemberCodeEnrolment(
    [property: System.Text.Json.Serialization.JsonPropertyName("v")] int V,
    [property: System.Text.Json.Serialization.JsonPropertyName("ref")] string Ref,
    [property: System.Text.Json.Serialization.JsonPropertyName("generation")] int Generation,
    [property: System.Text.Json.Serialization.JsonPropertyName("secret")] string Secret,
    [property: System.Text.Json.Serialization.JsonPropertyName("tz")] string Tz,
    [property: System.Text.Json.Serialization.JsonPropertyName("step_seconds")] int StepSeconds,
    [property: System.Text.Json.Serialization.JsonPropertyName("server_time_ms")] long ServerTimeMs,
    [property: System.Text.Json.Serialization.JsonPropertyName("phase")] string Phase);

/// <summary><c>GET /api/v1/me/code</c> (§10) — no secret, ever.</summary>
public sealed record MemberCodeStatus(
    [property: System.Text.Json.Serialization.JsonPropertyName("v")] int V,
    [property: System.Text.Json.Serialization.JsonPropertyName("ref")] string Ref,
    [property: System.Text.Json.Serialization.JsonPropertyName("generation")] int Generation,
    [property: System.Text.Json.Serialization.JsonPropertyName("tz")] string Tz,
    [property: System.Text.Json.Serialization.JsonPropertyName("server_time_ms")] long ServerTimeMs,
    [property: System.Text.Json.Serialization.JsonPropertyName("phase")] string Phase);
