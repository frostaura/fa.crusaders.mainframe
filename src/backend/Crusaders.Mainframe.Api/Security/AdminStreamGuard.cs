using Crusaders.Mainframe.Api.Services.Realtime;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// The <see cref="SseGuard"/> every admin-only stream runs under: the live admin role, re-asked
/// before each frame (<see cref="LiveAdminRole.StillHoldsAsync"/>).
///
/// <para>
/// One place, so a third admin stream cannot be written with the check forgotten by copying the
/// shape of a route that predates it. The request's own services are handed over rather than
/// captured scoped instances: the stream outlives nothing it needs, and the role read opens a
/// scope of its own each time the cache misses.
/// </para>
/// </summary>
public static class AdminStreamGuard
{
    public static SseGuard For(HttpContext ctx, TimeSpan keepAlive)
    {
        var live = ctx.RequestServices.GetRequiredService<LiveAdminRole>();
        var services = ctx.RequestServices;
        var principal = ctx.User;
        return new SseGuard(keepAlive, ct => live.StillHoldsAsync(principal, services, ct));
    }
}
