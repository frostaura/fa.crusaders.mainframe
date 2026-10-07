using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Demo;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Demo mode at the HTTP edge — the admin's switch between the club and its demo club
/// (<see cref="DemoModeService"/>), and the demo's reset. Admins only; a member is refused by the
/// role policy before any of this runs.
///
/// <para>
/// <b>The switch is a session swap.</b> It answers a new sign-in — access token and refresh cookie
/// — for the other club, exactly as signing in does, so every route afterwards is simply in the
/// club the token names and needs no idea of a "mode". Each crossing is written into the REAL
/// club's change record by the real admin (<see cref="AdminChangeActions.DemoEntered"/>,
/// <see cref="AdminChangeActions.DemoLeft"/>, <see cref="AdminChangeActions.DemoReset"/>).
/// </para>
///
/// <para>
/// <b>Member view</b> (<see cref="MemberView"/>) is a third session in the same swap: the admin's
/// persona in the demo club, a plain member. It is entered here (an admin, from the demo) and left
/// through <see cref="DemoMemberViewEndpoints"/>, because the persona is not an admin and this group
/// refuses it by role.
/// </para>
/// </summary>
public static class AdminModeEndpoints
{
    public const string Demo = "demo";
    public const string Live = "live";

    /// <summary>The demo club as a plain member — the admin's member-view persona (<see cref="DemoMirrors"/>).</summary>
    public const string MemberView = "demo_member";

    public static IEndpointRouteBuilder MapAdminModeEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin").RequireAuthorization(p => p.RequireRole("admin"));
        g.MapGet("/mode", ReadAsync);
        g.MapPost("/mode", SwitchAsync).RequireRateLimiting(RateLimitPolicies.Writes);
        g.MapPost("/demo/reset", ResetAsync).RequireRateLimiting(RateLimitPolicies.Writes);
        return app;
    }

    /// <summary><c>GET /api/v1/admin/mode</c> — which club this session is in, and how fresh the demo is.</summary>
    private static async Task<IResult> ReadAsync(DemoModeService demo, CancellationToken ct)
    {
        var current = await demo.CurrentAsync(ct);
        var club = current.IsDemo ? await demo.ClubAsync(current.DemoOfTenantId!.Value, ct) : current;
        var demoClub = current.IsDemo ? current : await demo.DemoOfCurrentAsync(ct);
        return Results.Ok(new
        {
            mode = current.IsDemo ? Demo : Live,
            club_name = club.DisplayName,
            demo = demoClub?.DemoGeneratedAt is { } at
                ? new { generated_at = at, stale_after_hours = (int)DemoModeService.StaleAfter.TotalHours }
                : null,
        });
    }

    /// <summary>
    /// <c>POST /api/v1/admin/mode</c> <c>{"mode":"demo"|"live"}</c> — a new session in that club.
    /// The mode already in force answers a fresh session for it (a lost reply retried is not an error).
    /// </summary>
    private static async Task<IResult> SwitchAsync(ModeRequest req, HttpContext ctx, DemoModeService demo, CancellationToken ct)
    {
        var mode = req.Mode?.Trim().ToLowerInvariant();
        if (mode is not (Demo or Live or MemberView)) return Results.BadRequest(new { error = "mode_invalid" });
        if (ctx.User.Id() is not { } userId) return Results.Unauthorized();

        var current = await demo.CurrentAsync(ct);
        if (mode == MemberView) return await EnterMemberViewAsync(ctx, demo, current, userId, ct);
        if (current.IsDemo == (mode == Demo)) return await SessionAsync(ctx, userId, mode, current.DemoGeneratedAt, ct);
        return mode == Demo ? await EnterAsync(ctx, demo, userId, ct) : await LeaveAsync(ctx, demo, userId, ct);
    }

    private static async Task<IResult> EnterAsync(HttpContext ctx, DemoModeService demo, Guid userId, CancellationToken ct)
    {
        var entry = await demo.EnterAsync(userId, ct);
        await ctx.RequestServices.GetRequiredService<AdminChangeRecorder>()
            .RecordAsync(new AdminChange(AdminChangeActions.DemoEntered, userId), ct);
        ctx.RequestServices.GetRequiredService<ITenantContext>().Set(entry.Club.Id, entry.Club.Slug);
        return await SessionAsync(ctx, entry.Mirror.Id, Demo, entry.Club.DemoGeneratedAt, ct);
    }

    /// <summary>
    /// <c>demo_member</c>: from the admin's demo session to their member-view persona. Only from
    /// the demo — the live club has no such view, and nothing here reaches it.
    /// </summary>
    private static async Task<IResult> EnterMemberViewAsync(HttpContext ctx, DemoModeService demo, Tenant current, Guid userId, CancellationToken ct)
    {
        if (!current.IsDemo) return Results.Json(new { error = "member_view_needs_demo" }, statusCode: StatusCodes.Status409Conflict);
        if (await demo.ReturnForAsync(userId, ct) is not DemoReturn.To to) return SessionEnded();

        var entry = await demo.EnterMemberViewAsync(to, ct);
        await RecordInRealClubAsync(ctx, to, AdminChangeActions.DemoMemberViewEntered, ct);
        return await SessionAsync(ctx, entry.Mirror.Id, MemberView, entry.Club.DemoGeneratedAt, ct);
    }

    private static async Task<IResult> LeaveAsync(HttpContext ctx, DemoModeService demo, Guid mirrorId, CancellationToken ct)
    {
        if (await demo.ReturnForAsync(mirrorId, ct) is not DemoReturn.To to) return SessionEnded();
        ctx.RequestServices.GetRequiredService<ITenantContext>().Set(to.RealClub.Id, to.RealClub.Slug);
        await ctx.RequestServices.GetRequiredService<AdminChangeRecorder>()
            .RecordAsync(new AdminChange(AdminChangeActions.DemoLeft, to.RealUser.Id), ct);
        return await SessionAsync(ctx, to.RealUser.Id, Live, null, ct);
    }

    /// <summary>
    /// <c>POST /api/v1/admin/demo/reset</c> — the demo's made-up data wiped and drawn again. Only in
    /// a demo session; the admin stays signed in to the demo through it.
    /// </summary>
    private static async Task<IResult> ResetAsync(HttpContext ctx, DemoModeService demo, CancellationToken ct)
    {
        if (ctx.User.Id() is not { } mirrorId) return Results.Unauthorized();
        var current = await demo.CurrentAsync(ct);
        if (!current.IsDemo) return Results.Json(new { error = "not_in_demo" }, statusCode: StatusCodes.Status409Conflict);
        if (await demo.ReturnForAsync(mirrorId, ct) is not DemoReturn.To to) return SessionEnded();

        var generatedAt = await demo.RegenerateAsync(current.Id, force: true, ct);
        await RecordInRealClubAsync(ctx, to, AdminChangeActions.DemoReset, ct);
        return Results.Ok(new { generated_at = generatedAt });
    }

    /// <summary>The real admin's own act, on the real club's record, from a request that is in the demo.</summary>
    internal static async Task RecordInRealClubAsync(HttpContext ctx, DemoReturn.To to, string action, CancellationToken ct)
    {
        using var scope = ctx.RequestServices.GetRequiredService<IServiceScopeFactory>().CreateScope();
        scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(to.RealClub.Id, to.RealClub.Slug);
        await scope.ServiceProvider.GetRequiredService<AdminChangeRecorder>().RecordAsync(new AdminChange(action, to.RealUser.Id), ct);
    }

    /// <summary>A sign-in's answer for <paramref name="userId"/> in the club the request is now in, plus the mode.</summary>
    internal static async Task<IResult> SessionAsync(HttpContext ctx, Guid userId, string mode, DateTimeOffset? generatedAt, CancellationToken ct)
    {
        var auth = ctx.RequestServices.GetRequiredService<AuthService>();
        var epoch = await ctx.RequestServices.GetRequiredService<DemoModeService>().EpochOfAsync(userId, ct);
        if (await auth.RefreshAsync(userId, epoch, ct) is not LoginResult.Ok ok) return SessionEnded();

        var family = await SessionCookies.StartAsync(ctx, ok.UserId, ok.SessionEpoch, ct);
        return Results.Ok(new
        {
            access_token = SessionCookies.Bind(ctx, ok.AccessToken, family),
            user_id = ok.UserId,
            is_admin = ok.IsAdmin,
            must_change_password = ok.MustChangePassword,
            mode,
            generated_at = generatedAt,
        });
    }

    internal static IResult SessionEnded() =>
        Results.Json(new { error = "session_ended" }, statusCode: StatusCodes.Status401Unauthorized);
}

/// <summary><c>POST /api/v1/admin/mode</c>. Nullable so a missing field is a named 400.</summary>
public sealed record ModeRequest(string? Mode);
