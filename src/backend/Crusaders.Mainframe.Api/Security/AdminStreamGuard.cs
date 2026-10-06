using Crusaders.Mainframe.Api.Services.Realtime;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// The <see cref="SseGuard"/> every admin-only stream runs under: the live admin role, re-asked
/// before each frame (<see cref="LiveAdminRole.StillHoldsAsync"/>), and the session's epoch with it
/// (<see cref="SessionEpochs.StillCurrentAsync"/>).
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
        var epochs = ctx.RequestServices.GetRequiredService<SessionEpochs>();
        var services = ctx.RequestServices;
        var principal = ctx.User;

        // The role AND the session: a rotation (member-code §10) ends every session, and a stream
        // opened before it is one of them — it must close, not run until the connection drops.
        // R18: under the stream gate, like the wallet stream's — see StreamDbGate.
        return ctx.RequestServices.GetRequiredService<StreamDbGate>().Guard(keepAlive, async ct =>
            await live.StillHoldsAsync(principal, services, ct) && await epochs.StillCurrentAsync(principal, services, ct));
    }
}
