using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Security.Discovery;

/// <summary>A claimed device, resolved far enough to check what it signed with.</summary>
public sealed record DiscoveryDeviceIdentity(Guid DeviceId, Guid TenantId, string TenantSlug, byte[] Key);

/// <summary>
/// Looks up the device a claimed <c>ANNOUNCE</c> says it is, and derives its key.
///
/// <para>
/// An interface rather than a direct <c>DbContext</c> dependency so the listener can be
/// driven over a real UDP socket in a test without a database standing behind it. The
/// listener is the piece with the socket; whether a device exists is a different
/// concern with a different lifetime.
/// </para>
/// </summary>
public interface IDiscoveryDeviceResolver
{
    Task<DiscoveryDeviceIdentity?> ResolveAsync(Guid deviceId, CancellationToken ct);
}

/// <summary>
/// The database-backed resolver.
///
/// <para>
/// Singleton over a scope factory, because the listener is a singleton
/// <c>BackgroundService</c> and there is no request scope to borrow. The lookup is
/// <c>IgnoreQueryFilters</c> by primary key for the same reason <c>DeviceVerifier</c>
/// does it: the tenant is not known until this row is read — the row is what says which
/// tenant it is. It is the one legitimate cross-tenant read on this path, and its result
/// is only ever used to <i>narrow</i> what an admin may see.
/// </para>
/// </summary>
public sealed class DiscoveryDeviceResolver : IDiscoveryDeviceResolver
{
    private readonly IServiceScopeFactory _scopes;

    public DiscoveryDeviceResolver(IServiceScopeFactory scopes) => _scopes = scopes;

    public async Task<DiscoveryDeviceIdentity?> ResolveAsync(Guid deviceId, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var device = await db.Devices.IgnoreQueryFilters()
            .FirstOrDefaultAsync(d => d.Id == deviceId, ct);

        if (device is null || !device.IsActive) return null;

        var tenant = await db.Tenants.IgnoreQueryFilters()
            .FirstOrDefaultAsync(t => t.Id == device.TenantId, ct);

        if (tenant is null) return null;

        var keys = scope.ServiceProvider.GetRequiredService<IDeviceKeyDeriver>();
        return new DiscoveryDeviceIdentity(
            device.Id, device.TenantId, tenant.Slug, keys.Derive(device.TenantId, device.Id, device.KeyVersion));
    }
}
