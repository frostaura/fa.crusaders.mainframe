using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Demo;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The way out of the demo club's member view. The persona is a plain member, so the admin mode
/// switch (<see cref="AdminModeEndpoints"/>, admins only) cannot be where it leaves from; this is
/// the one route a non-admin session may use to leave, and it works only for a session that IS a
/// member-view persona — and only toward the one real admin the persona names, and only while that
/// admin's sessions have not been ended since (<see cref="DemoModeService.ReturnForAsync"/>).
///
/// <para>
/// Nothing here grants anything: a persona that is not what it says it is, or that is in any real
/// club, is refused <c>409 not_member_view</c>. Each crossing is on the REAL club's change record
/// by the real admin, as the admin switch's are.
/// </para>
/// </summary>
public static class DemoMemberViewEndpoints
{
    public static IEndpointRouteBuilder MapDemoMemberViewEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/me/demo").RequireAuthorization();
        g.MapPost("/mode", LeaveAsync).RequireRateLimiting(RateLimitPolicies.Writes);
        return app;
    }

    /// <summary>
    /// <c>POST /api/v1/me/demo/mode</c> <c>{"mode":"demo"|"live"}</c> — back to the admin's demo
    /// session, or all the way to the live club. The reply is a sign-in's, as the admin switch's is.
    /// </summary>
    private static async Task<IResult> LeaveAsync(ModeRequest req, HttpContext ctx, DemoModeService demo, CancellationToken ct)
    {
        var mode = req.Mode?.Trim().ToLowerInvariant();
        if (mode is not (AdminModeEndpoints.Demo or AdminModeEndpoints.Live)) return Results.BadRequest(new { error = "mode_invalid" });
        if (ctx.User.Id() is not { } userId) return Results.Unauthorized();

        var club = await demo.CurrentAsync(ct);
        if (club.DemoOfTenantId is null) return NotMemberView();
        switch (await demo.ReturnForAsync(userId, ct))
        {
            case DemoReturn.To { MemberView: true } to:
                return mode == AdminModeEndpoints.Demo ? await ToAdminAsync(ctx, demo, club, to, ct) : await ToLiveAsync(ctx, to, ct);
            case DemoReturn.SessionEnded:
                return AdminModeEndpoints.SessionEnded();
            default:
                return NotMemberView();
        }
    }

    private static async Task<IResult> ToAdminAsync(HttpContext ctx, DemoModeService demo, Domain.Tenant club, DemoReturn.To to, CancellationToken ct)
    {
        var admin = await demo.BackToAdminAsync(to, ct);
        await AdminModeEndpoints.RecordInRealClubAsync(ctx, to, AdminChangeActions.DemoMemberViewLeft, ct);
        return await AdminModeEndpoints.SessionAsync(ctx, admin.Id, AdminModeEndpoints.Demo, club.DemoGeneratedAt, ct);
    }

    private static async Task<IResult> ToLiveAsync(HttpContext ctx, DemoReturn.To to, CancellationToken ct)
    {
        ctx.RequestServices.GetRequiredService<ITenantContext>().Set(to.RealClub.Id, to.RealClub.Slug);
        await ctx.RequestServices.GetRequiredService<AdminChangeRecorder>()
            .RecordAsync(new AdminChange(AdminChangeActions.DemoLeft, to.RealUser.Id), ct);
        return await AdminModeEndpoints.SessionAsync(ctx, to.RealUser.Id, AdminModeEndpoints.Live, null, ct);
    }

    private static IResult NotMemberView() =>
        Results.Json(new { error = "not_member_view" }, statusCode: StatusCodes.Status409Conflict);
}
