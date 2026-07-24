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
    }
}
