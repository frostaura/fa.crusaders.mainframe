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

    private static readonly string[] AnonymousPathPrefixes =
    {
        "/healthz",
        "/api/v1/whoami",
        "/api/v1/auth/",                  // login, register, magic-link callback
        "/api/v1/platform/",              // platform-admin endpoints scoped above tenant
        "/api/v1/credit/topup/callback",  // PeachPayments webhook — resolves tenant from query
        "/api/v1/uploads/",               // anonymous registration upload
        "/uploads/",                      // static-served media
        "/api/v1/court/",                 // court-side endpoints — admin auth, kiosk mode resolves tenant from JWT
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

    private static string? ExtractHostSubdomain(string host)
    {
        // localhost or bare hostnames — no subdomain.
        if (string.IsNullOrEmpty(host) || host == "localhost" || !host.Contains('.'))
            return null;
        var firstDot = host.IndexOf('.');
        var sub = host[..firstDot];
        return string.IsNullOrWhiteSpace(sub) || sub == "www" || sub == "admin" ? null : sub;
    }
}
