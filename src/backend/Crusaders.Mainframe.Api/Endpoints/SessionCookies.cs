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

    /// <summary>
    /// A successful sign-in: starts a new refresh family, sets its cookie, and answers the login
    /// body with the access token bound to that family (C1).
    /// </summary>
    public static async Task<IResult> SignedInAsync(HttpContext ctx, LoginResult.Ok ok, CancellationToken ct)
    {
        var family = await StartAsync(ctx, ok.UserId, ok.SessionEpoch, ct);
        return Results.Ok(Body(Bound(ctx, ok, family)));
    }

    /// <summary>
    /// Starts a new refresh family for a session just minted under <paramref name="sessionEpoch"/>,
    /// sets its cookie, and answers the family — which the caller binds its access token to
    /// (<see cref="Bind"/>).
    /// </summary>
    public static async Task<Guid> StartAsync(HttpContext ctx, Guid userId, int sessionEpoch, CancellationToken ct)
    {
        var tenant = ctx.RequestServices.GetRequiredService<ITenantContext>();
        var refresh = ctx.RequestServices.GetRequiredService<RefreshSessions>();
        var issued = await refresh.IssueAsync(tenant.TenantId, userId, sessionEpoch, familyId: null, ct);
        refresh.WriteCookie(ctx.Response, issued);
        return issued.FamilyId;
    }

    /// <summary><paramref name="accessToken"/>, re-signed with the refresh family it belongs to (C1).</summary>
    public static string Bind(HttpContext ctx, string accessToken, Guid familyId) =>
        ctx.RequestServices.GetRequiredService<IJwtIssuer>().BindToFamily(accessToken, familyId);

    private static LoginResult.Ok Bound(HttpContext ctx, LoginResult.Ok ok, Guid familyId) =>
        ok with { AccessToken = Bind(ctx, ok.AccessToken, familyId) };

    private static IResult SessionEnded() =>
        Results.Json(new { error = "session_ended" }, statusCode: StatusCodes.Status401Unauthorized);

    /// <summary>
    /// <c>POST /api/v1/auth/refresh</c>. A valid bearer refreshes as it always has — unless it was
    /// minted from a refresh family that has since been ended (C1: a sign-out in another tab, sign
    /// out everywhere, a replay), which is <c>401 session_ended</c> with the cookie left alone (it
    /// may be a NEWER family's). When the browser holds no cookie yet (a session from before B1)
    /// the bearer path starts a family so the next idle spell survives. Without a usable bearer
    /// the cookie alone is exchanged: 200 with the login body and the rotated cookie, or 401 with
    /// the cookie cleared — except when a concurrent request spent the same link a moment ago
    /// (<c>refresh_superseded</c>), where clearing would delete the successor that request just
    /// set. Every token answered is bound to its family.
    /// </summary>
    public static async Task<IResult> RefreshAsync(HttpContext ctx, AuthService auth, RefreshSessions refresh, CancellationToken ct)
    {
        var cookie = RefreshSessions.CookieOf(ctx.Request);
        if (ctx.User.Identity?.IsAuthenticated == true && ctx.User.Id() is { } userId)
        {
            return await BearerRefreshAsync(ctx, new BearerRefresh(auth, refresh, userId, cookie), ct);
        }

        if (cookie is null) return SessionEnded();

        // Demo mode: the cookie may be the club's DEMO session, presented on the club's address.
        await Services.Demo.DemoSessions.AdoptCookieTenantAsync(ctx, cookie, ct);
        var outcome = await auth.RefreshWithCookieAsync(cookie, ct);
        if (outcome is { Result: LoginResult.Ok refreshed, Successor: { } successor })
        {
            refresh.WriteCookie(ctx.Response, successor);
            return Results.Ok(Body(Bound(ctx, refreshed, successor.FamilyId)));
        }

        if (outcome.Superseded)
        {
            return Results.Json(new { error = "refresh_superseded" }, statusCode: StatusCodes.Status401Unauthorized);
        }
        refresh.ClearCookie(ctx.Response);
        return SessionEnded();
    }

    private sealed record BearerRefresh(AuthService Auth, RefreshSessions Refresh, Guid UserId, string? Cookie);

    private static async Task<IResult> BearerRefreshAsync(HttpContext ctx, BearerRefresh r, CancellationToken ct)
    {
        var tenant = ctx.RequestServices.GetRequiredService<ITenantContext>();
        var family = RefreshSessions.FamilyOf(ctx.User);
        if (family is { } f && (!tenant.IsResolved || !await r.Refresh.IsFamilyLiveAsync(tenant.TenantId, f, ct))) return SessionEnded();

        var result = await r.Auth.RefreshAsync(r.UserId, SessionEpochs.EpochOf(ctx.User), ct);
        if (result is not LoginResult.Ok ok) return Results.Unauthorized();

        // The family the new token belongs to: the bearer's own; else (a token from before C1)
        // the cookie's; else a new one, started here with its cookie (a session from before B1).
        family ??= r.Cookie is null ? null : await r.Refresh.FamilyOfAsync(r.Cookie, tenant.TenantId, ct);
        if (r.Cookie is null) family = await StartAsync(ctx, ok.UserId, ok.SessionEpoch, ct);
        return Results.Ok(Body(family is { } bound ? Bound(ctx, ok, bound) : ok));
    }

    /// <summary>
    /// Sign-out's session half: revokes the presented cookie's family in this club, AND the family
    /// the presented bearer was minted from (C1 — a browser that never kept the cookie, e.g.
    /// Safari over plain http, still ends its session), and clears the cookie.
    /// </summary>
    public static async Task EndAsync(HttpContext ctx, CancellationToken ct)
    {
        var refresh = ctx.RequestServices.GetRequiredService<RefreshSessions>();
        var tenant = ctx.RequestServices.GetRequiredService<ITenantContext>();
        var cookie = RefreshSessions.CookieOf(ctx.Request);
        if (cookie is not null && RefreshSessions.FamilyOf(ctx.User) is null)
        {
            await Services.Demo.DemoSessions.AdoptCookieTenantAsync(ctx, cookie, ct);
        }
        if (tenant.IsResolved)
        {
            var families = new HashSet<Guid>();
            if (cookie is not null && await refresh.FamilyOfAsync(cookie, tenant.TenantId, ct) is { } fromCookie) families.Add(fromCookie);
            if (RefreshSessions.FamilyOf(ctx.User) is { } fromBearer) families.Add(fromBearer);
            foreach (var family in families) await refresh.RevokeFamilyAsync(tenant.TenantId, family, ct);
        }
        refresh.ClearCookie(ctx.Response);
    }
}
