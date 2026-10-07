namespace Crusaders.Mainframe.Api.Multitenancy;

/// <summary>
/// Per-request tenant resolution. Populated by <see cref="TenantResolutionMiddleware"/>.
/// Never null — if no tenant resolves, <see cref="TenantId"/> is <see cref="Guid.Empty"/>
/// and the middleware short-circuits the response.
/// </summary>
public interface ITenantContext
{
    Guid TenantId { get; }
    string TenantSlug { get; }
    bool IsResolved { get; }
    void Set(Guid tenantId, string tenantSlug);
}

public sealed class TenantContext : ITenantContext
{
    public Guid TenantId { get; private set; }
    public string TenantSlug { get; private set; } = string.Empty;
    public bool IsResolved => TenantId != Guid.Empty;

    public void Set(Guid tenantId, string tenantSlug)
    {
        TenantId = tenantId;
        TenantSlug = tenantSlug;
        // Demo mode: the flag that silences mail, payments and webhooks for a demo club follows
        // the tenant, so it is raised (or lowered) wherever a tenant is chosen. See DemoTenants.
        Services.Demo.DemoTenants.Enter(tenantId);
        AmbientTenant.Enter(tenantId);
    }
}
