using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Multitenancy;

/// <summary>
/// Resolves the current tenant from (in order) the JWT 'tenant_slug' claim and the Host header subdomain.
/// If both are present they must agree; mismatch returns 403.
/// Endpoints under /healthz, /api/v1/whoami, and /api/v1/platform/** bypass tenant resolution.
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
    private static readonly string[] AnonymousPathPrefixes =
    {
        "/healthz",
        "/api/v1/whoami",
        "/api/v1/auth/",                  // login, register, magic-link callback
        "/api/v1/platform/",              // platform-admin endpoints scoped above tenant
        "/api/v1/credit/topup/callback",  // PeachPayments webhook — resolves tenant from query
        "/api/v1/uploads/",               // anonymous registration upload
        "/uploads/",                      // static-served media
        "/api/v1/device/",                // device surface — DeviceAuthenticationHandler sets the tenant from the device row
    };

    public TenantResolutionMiddleware(RequestDelegate next, ILogger<TenantResolutionMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context, ITenantContext tenantContext, MainframeDbContext db)
    {
        var path = context.Request.Path.Value ?? string.Empty;
        if (AnonymousPathPrefixes.Any(p => path.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
        {
            await _next(context);
            return;
        }

        var jwtSlug = context.User?.FindFirst("tenant_slug")?.Value;
        var hostSlug = ExtractHostSubdomain(context.Request.Host.Host);

        var resolvedSlug = jwtSlug ?? hostSlug;
        if (string.IsNullOrWhiteSpace(resolvedSlug))
        {
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

        var tenant = await db.Tenants.AsNoTracking().FirstOrDefaultAsync(t => t.Slug == resolvedSlug);
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
