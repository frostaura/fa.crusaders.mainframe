using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Crusaders.Mainframe.Api.Multitenancy;

/// <summary>
/// Resolves the current tenant from (in order) the JWT 'tenant_slug' claim and the Host header subdomain.
/// If both are present they must agree; mismatch returns 403.
/// Paths in <see cref="TenantlessPathPrefixes"/> bypass resolution entirely; those in
/// <see cref="AnonymousTenantScopedPrefixes"/> take no token but still resolve a tenant.
/// </summary>
public sealed class TenantResolutionMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<TenantResolutionMiddleware> _logger;

    // NOTE: /api/v1/court/ is deliberately NOT here.
    //
    // It used to be, with the comment "admin auth, kiosk mode resolves tenant from JWT" —
    // but this middleware IS what resolves the tenant from the JWT, so skipping it meant
    // nothing ever called Set. TenantId stayed Guid.Empty, every global query filter
    // matched nothing, and all three courtside endpoints returned 404 for a court that
    // exists. They had never once worked against a real tenant; the first HTTP-level test
    // of them found it immediately. The comment described an intention the code defeated.
    /// <summary>
    /// Paths that genuinely have no tenant, or that resolve their own.
    ///
    /// <para>
    /// These skip resolution entirely, which means <see cref="ITenantContext.TenantId"/>
    /// stays <see cref="Guid.Empty"/> for the request. That is only safe where nothing
    /// touches a tenant-scoped table, or where the handler sets the tenant itself.
    /// </para>
    /// </summary>
    private static readonly string[] TenantlessPathPrefixes =
    {
        "/healthz",
        "/api/v1/whoami",
        "/api/v1/platform/",              // platform-admin endpoints scoped above tenant
        "/api/v1/credit/topup/callback",  // PayFast ITN — resolves tenant from query
        "/uploads/",                      // static-served media
        "/api/v1/device/",                // device surface — DeviceAuthenticationHandler sets the tenant from the device row
        "/api/v1/photos/",                // a member's photo for an <img>: no token; the URL's hash is the check (PhotoEndpoints)
    };

    /// <summary>
    /// Paths that take no token but are still very much inside a tenant.
    ///
    /// <para>
    /// These used to sit in the bypass list, and the consequence was not a 404 the way a
    /// missing tenant usually shows up — it was <b>rows written outside every tenant</b>.
    /// <c>AuthService</c> stamps <c>TenantId = _tenant.TenantId</c> on the user, the
    /// membership and the audit row, so every registration landed on
    /// <c>00000000-0000-0000-0000-000000000000</c>: invisible to the club's admin screen,
    /// therefore never approvable, and invisible to the duplicate-email check, which is
    /// filtered to the same empty tenant. That last part is the sharp end — an anonymous
    /// caller could register an address that already belongs to a real member (the unique
    /// index is <c>(TenantId, Email)</c>, so it does not collide), and login's
    /// <c>IgnoreQueryFilters</c> lookup by email alone would then pick between the two rows
    /// by whatever order the database felt like.
    /// </para>
    ///
    /// <para>
    /// So they resolve a tenant like anything else — from the JWT if one is present, then
    /// the host subdomain, then <c>Tenancy:DefaultTenantSlug</c>. The configured default is
    /// read <b>only</b> here: falling back to it on an authenticated path would quietly
    /// undo the mismatch check below.
    /// </para>
    /// </summary>
    private static readonly string[] AnonymousTenantScopedPrefixes =
    {
        "/api/v1/auth/",                  // login, register, magic-link callback
        "/api/v1/uploads/",               // anonymous registration upload
        "/api/v1/invites/",               // the anonymous invite preview (a signed-in caller's JWT still wins)
    };

    public TenantResolutionMiddleware(RequestDelegate next, ILogger<TenantResolutionMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    /// <summary>
    /// How long a slug's club is remembered (perf round, 2026-09-30). The lookup ran on every
    /// tenant-scoped request — one of the two to six reads every GET paid before its handler. A
    /// club row is only ever ADDED (the bootstrap and the seeder; nothing renames a slug or deletes
    /// a club), so a remembered hit cannot go stale; a miss is never remembered, so a club being
    /// bootstrapped is found the moment it exists. Per host (<see cref="IMemoryCache"/>), never static.
    /// </summary>
    internal static readonly TimeSpan SlugCacheFor = TimeSpan.FromMinutes(5);

    private sealed record KnownTenant(Guid Id, string Slug);

    public async Task InvokeAsync(HttpContext context, ITenantContext tenantContext, MainframeDbContext db, IConfiguration config, IMemoryCache cache)
    {
        var path = context.Request.Path.Value ?? string.Empty;
        if (TenantlessPathPrefixes.Any(p => path.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
        {
            await _next(context);
            return;
        }

        var jwtSlug = context.User?.FindFirst("tenant_slug")?.Value;
        var hostSlug = ExtractHostSubdomain(context.Request.Host.Host);
        var defaultSlug = AnonymousTenantScopedPrefixes.Any(p => path.StartsWith(p, StringComparison.OrdinalIgnoreCase))
            ? config["Tenancy:DefaultTenantSlug"]
            : null;

        var resolvedSlug = jwtSlug ?? hostSlug ?? defaultSlug;
        if (string.IsNullOrWhiteSpace(resolvedSlug))
        {
            if (HasRejectedBearerToken(context))
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                await context.Response.WriteAsJsonAsync(new { error = "invalid_token", message = "Your session has expired. Sign in again." });
                return;
            }

            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await context.Response.WriteAsJsonAsync(new { error = "tenant_unresolved", message = "No tenant could be resolved from this request." });
            return;
        }

        if (jwtSlug is not null && hostSlug is not null && !string.Equals(jwtSlug, hostSlug, StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogWarning("Tenant mismatch: jwt='{Jwt}' host='{Host}'", jwtSlug, hostSlug);
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await context.Response.WriteAsJsonAsync(new { error = "tenant_mismatch" });
            return;
        }

        var tenant = await KnownAsync(db, cache, resolvedSlug);
        if (tenant is null)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            await context.Response.WriteAsJsonAsync(new { error = "tenant_not_found", slug = resolvedSlug });
            return;
        }

        tenantContext.Set(tenant.Id, tenant.Slug);
        await _next(context);
    }

    /// <summary>
    /// True when the caller presented a bearer token and authentication did not accept it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// On a host that carries no tenant subdomain — an IP literal or bare <c>localhost</c>, which
    /// per <see cref="ExtractHostSubdomain"/> is exactly how the club's own LAN addresses this API
    /// — the JWT is the only place a tenant can come from. So an expired or revoked token failed
    /// resolution rather than authentication, and every endpoint answered
    /// <c>400 tenant_unresolved</c>. A 400 is not a session signal: the browser kept the
    /// signed-in chrome up, every screen failed on its own terms, and the member was told to
    /// check their connection while their session was simply gone.
    /// </para>
    /// <para>
    /// The API should say what actually happened, rather than the client learning to read a 400
    /// on an authenticated route as a session loss. A request carrying no token at all still gets
    /// <c>tenant_unresolved</c>, because for that caller it is the truth.
    /// </para>
    /// <para>
    /// A stream's <c>?ticket=</c> is the bearer credential on the routes that accept one
    /// (<see cref="Security.TokenPurposes.AcceptsTicketInQuery"/>), so a rejected ticket is a
    /// rejected token too: an EventSource whose account was gone got <c>400</c> on the LAN where
    /// every other route of that session got <c>401</c>.
    /// </para>
    /// </remarks>
    private static async Task<KnownTenant?> KnownAsync(MainframeDbContext db, IMemoryCache cache, string slug)
    {
        // Ordinal key: the database match below is case-sensitive, and so is the memory of it.
        var key = "tenant-slug:" + slug;
        if (cache.TryGetValue(key, out KnownTenant? known) && known is not null) return known;

        known = await db.Tenants.AsNoTracking()
            .Where(t => t.Slug == slug)
            .Select(t => new KnownTenant(t.Id, t.Slug))
            .FirstOrDefaultAsync();
        if (known is not null) cache.Set(key, known, SlugCacheFor);
        return known;
    }

    private static bool HasRejectedBearerToken(HttpContext context)
    {
        if (context.User?.Identity?.IsAuthenticated == true) return false;
        var header = context.Request.Headers.Authorization.ToString();
        if (header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) && header.Length > "Bearer ".Length) return true;
        return Security.TokenPurposes.AcceptsTicketInQuery(context.Request.Path)
            && !string.IsNullOrEmpty(context.Request.Query["ticket"].ToString());
    }

    /// <summary>
    /// Derives a tenant slug from the Host header, or null when the host carries no
    /// tenant information.
    /// </summary>
    /// <remarks>
    /// IP literals must return null. The club runs the API on-prem, so devices and
    /// admins on the LAN address it as e.g. 192.168.68.10 — and taking everything
    /// before the first dot yields the "slug" 192, which resolves to no tenant. The
    /// result is a 404 for an anonymous caller, or a 403 tenant_mismatch for one
    /// holding a valid token. Neither is visible through the Cloudflare tunnel, which
    /// carries a real hostname; it only shows up on the LAN, which is exactly where
    /// the hardware lives.
    /// </remarks>
    internal static string? ExtractHostSubdomain(string host)
    {
        if (string.IsNullOrEmpty(host) || host == "localhost")
        {
            return null;
        }

        // Strip any port before inspecting the host.
        var portIndex = host.LastIndexOf(':');
        if (portIndex > 0 && !host.Contains(']') && host.IndexOf(':') == portIndex)
        {
            host = host[..portIndex];
        }

        // IPv6 literals arrive bracketed and never carry a tenant.
        if (host.StartsWith('[') || host.Contains(']'))
        {
            return null;
        }

        if (System.Net.IPAddress.TryParse(host, out _))
        {
            return null;
        }

        if (!host.Contains('.'))
        {
            return null;
        }

        var firstDot = host.IndexOf('.');
        var sub = host[..firstDot];
        return string.IsNullOrWhiteSpace(sub) || sub == "www" || sub == "admin" ? null : sub;
    }
}
