using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>
/// The refresh cookie of a demo session, presented on the real club's address.
///
/// <para>
/// A cookie-only refresh carries no token to name a club, so the request resolves the club from
/// its host (or the configured default) — the REAL club, since a demo club is never resolved that
/// way (<see cref="TenantResolutionMiddleware"/>). A demo session's link was issued in the demo
/// club, so the refresh found nothing and an admin who left a tab in demo mode for a quarter of an
/// hour was signed out. Here the link's own club is adopted — only when it is the demo OF the club
/// the request resolved, so a link can never carry a request into some other club.
/// </para>
/// </summary>
public static class DemoSessions
{
    public static async Task AdoptCookieTenantAsync(HttpContext ctx, string cookie, CancellationToken ct)
    {
        var tenant = ctx.RequestServices.GetRequiredService<ITenantContext>();
        if (!tenant.IsResolved || string.IsNullOrWhiteSpace(cookie) || cookie.Length > 256) return;

        var db = ctx.RequestServices.GetRequiredService<MainframeDbContext>();
        var hash = TokenHashing.Hash(cookie);
        var owner = await db.RefreshTokens.IgnoreQueryFilters().AsNoTracking()
            .Where(t => t.TokenHash == hash).Select(t => (Guid?)t.TenantId).FirstOrDefaultAsync(ct);
        if (owner is not { } ownerId || ownerId == tenant.TenantId) return;

        var source = tenant.TenantId;
        var demo = await db.Tenants.AsNoTracking()
            .Where(t => t.Id == ownerId && t.DemoOfTenantId == source)
            .Select(t => new { t.Id, t.Slug })
            .FirstOrDefaultAsync(ct);
        if (demo is null) return;

        DemoTenants.Register(demo.Id);
        tenant.Set(demo.Id, demo.Slug);
    }
}
