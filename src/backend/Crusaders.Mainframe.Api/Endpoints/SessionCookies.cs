using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The refresh cookie at the HTTP edge (review round 1, B1): set on every successful sign-in,
/// exchanged at <c>POST /auth/refresh</c>, ended at <c>POST /auth/logout</c>. The rules — hashing,
/// single use, replay, epoch, tenant, cookie attributes and the CSRF argument — are on
/// <see cref="RefreshSessions"/>.
/// </summary>
public static class SessionCookies
{
    /// <summary>The body every sign-in and refresh answers with.</summary>
    public static object Body(LoginResult.Ok ok)
    {
        return new { access_token = ok.AccessToken, user_id = ok.UserId, is_admin = ok.IsAdmin, must_change_password = ok.MustChangePassword };
    }

    /// <summary>A successful sign-in: starts a new refresh family, sets its cookie, answers the login body.</summary>
    public static async Task<IResult> SignedInAsync(HttpContext ctx, LoginResult.Ok ok, CancellationToken ct)
    {
        await StartAsync(ctx, ok.UserId, ok.SessionEpoch, ct);
        return Results.Ok(Body(ok));
    }

    /// <summary>Starts a new refresh family for a session just minted under <paramref name="sessionEpoch"/> and sets its cookie.</summary>
    public static async Task StartAsync(HttpContext ctx, Guid userId, int sessionEpoch, CancellationToken ct)
    {
        var tenant = ctx.RequestServices.GetRequiredService<ITenantContext>();
        var refresh = ctx.RequestServices.GetRequiredService<RefreshSessions>();
        var issued = await refresh.IssueAsync(tenant.TenantId, userId, sessionEpoch, familyId: null, ct);
        refresh.WriteCookie(ctx.Response, issued);
    }

    /// <summary>
    /// <c>POST /api/v1/auth/refresh</c>. A valid bearer refreshes as it always has (and, when the
    /// browser holds no cookie yet — a session from before B1 — starts a family so the next idle
    /// spell survives). Without a usable bearer the cookie alone is exchanged: 200 with the login
    /// body and the rotated cookie, or 401 with the cookie cleared — except when a concurrent
    /// request spent the same link a moment ago (<c>refresh_superseded</c>), where clearing would
    /// delete the successor that request just set.
    /// </summary>
    public static async Task<IResult> RefreshAsync(HttpContext ctx, AuthService auth, RefreshSessions refresh, CancellationToken ct)
    {
        var cookie = RefreshSessions.CookieOf(ctx.Request);
        if (ctx.User.Identity?.IsAuthenticated == true && ctx.User.Id() is { } userId)
        {
            var result = await auth.RefreshAsync(userId, SessionEpochs.EpochOf(ctx.User), ct);
            if (result is not LoginResult.Ok ok) return Results.Unauthorized();
            if (cookie is null) await StartAsync(ctx, ok.UserId, ok.SessionEpoch, ct);
            return Results.Ok(Body(ok));
        }

        if (cookie is null) return Results.Json(new { error = "session_ended" }, statusCode: StatusCodes.Status401Unauthorized);

        var outcome = await auth.RefreshWithCookieAsync(cookie, ct);
        if (outcome is { Result: LoginResult.Ok refreshed, Successor: { } successor })
        {
            refresh.WriteCookie(ctx.Response, successor);
            return Results.Ok(Body(refreshed));
        }

        if (outcome.Superseded)
        {
            return Results.Json(new { error = "refresh_superseded" }, statusCode: StatusCodes.Status401Unauthorized);
        }
        refresh.ClearCookie(ctx.Response);
        return Results.Json(new { error = "session_ended" }, statusCode: StatusCodes.Status401Unauthorized);
    }

    /// <summary>Sign-out's cookie half: revokes the presented cookie's family in this club and clears it.</summary>
    public static async Task EndAsync(HttpContext ctx, CancellationToken ct)
    {
        var refresh = ctx.RequestServices.GetRequiredService<RefreshSessions>();
        var cookie = RefreshSessions.CookieOf(ctx.Request);
        if (cookie is not null)
        {
            var tenant = ctx.RequestServices.GetRequiredService<ITenantContext>();
            if (tenant.IsResolved && await refresh.FamilyOfAsync(cookie, tenant.TenantId, ct) is { } family)
            {
                await refresh.RevokeFamilyAsync(tenant.TenantId, family, ct);
            }
        }
        refresh.ClearCookie(ctx.Response);
    }
}
