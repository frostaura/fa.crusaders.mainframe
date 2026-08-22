using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Crusaders.Mainframe.Api.Security.DeviceAuth;

/// <summary>The signed request a device presented, lifted out of the HTTP headers.</summary>
public sealed record DeviceCredential(
    Guid DeviceId,
    long UnixSeconds,
    string Nonce,
    string Signature,
    string Method,
    string PathAndQuery,
    byte[] Body);

/// <summary>
/// The outcome of verifying one device request. A failure carries the reason for the
/// log and never for the response — telling a caller <i>why</i> a signature failed is
/// how a probe maps the fleet.
/// </summary>
public sealed record DeviceVerification(Device? Device, Tenant? Tenant, string? Failure)
{
    public bool Succeeded => Failure is null;

    public static DeviceVerification Fail(string reason) => new(null, null, reason);
    public static DeviceVerification Ok(Device device, Tenant tenant) => new(device, tenant, null);
}

/// <summary>
/// Verifies a device credential: clock, replay, existence, status, signature, tenant.
///
/// <para>
/// Separate from the authentication handler on purpose. The handler's job is to read
/// headers and shape an <c>AuthenticateResult</c>; this is where the security decision
/// is actually made, and keeping it here means it can be exercised directly rather
/// than only through a web host.
/// </para>
/// </summary>
public sealed class DeviceVerifier
{
    /// <summary>How far a device's clock may drift before its requests are rejected.</summary>
    public static readonly TimeSpan ClockSkew = TimeSpan.FromMinutes(2);

    /// <summary>How long a nonce is remembered. Must exceed <see cref="ClockSkew"/> in both directions.</summary>
    public static readonly TimeSpan NonceLifetime = TimeSpan.FromMinutes(5);

    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly IDeviceKeyDeriver _keys;
    private readonly IMemoryCache _nonces;

    public DeviceVerifier(MainframeDbContext db, ITenantContext tenant, IDeviceKeyDeriver keys, IMemoryCache nonces)
    {
        _db = db;
        _tenant = tenant;
        _keys = keys;
        _nonces = nonces;
    }

    public async Task<DeviceVerification> VerifyAsync(DeviceCredential credential, CancellationToken ct = default)
    {
        var clockFailure = CheckClock(credential.UnixSeconds);
        if (clockFailure is not null) return DeviceVerification.Fail(clockFailure);

        // Replay is checked before the HMAC so a replayed request is cheap to reject.
        var nonceKey = $"devnonce:{credential.DeviceId:N}:{credential.Nonce}";
        if (_nonces.TryGetValue(nonceKey, out _))
        {
            return DeviceVerification.Fail("Device nonce has already been used.");
        }

        // IgnoreQueryFilters: the tenant is not known until this row is read — it is
        // what tells us the tenant. This is the one legitimate cross-tenant read here,
        // and it is a lookup by primary key.
        var device = await _db.Devices.IgnoreQueryFilters().FirstOrDefaultAsync(d => d.Id == credential.DeviceId, ct);
        if (device is null) return DeviceVerification.Fail("Unknown device.");
        if (!device.IsActive) return DeviceVerification.Fail("Device is disabled or revoked.");

        var canonical = DeviceRequestSigner.CanonicalString(
            credential.Method, credential.PathAndQuery, credential.UnixSeconds, credential.Nonce, credential.Body);

        var key = _keys.Derive(device.TenantId, device.Id, device.KeyVersion);
        if (!DeviceRequestSigner.Verify(key, canonical, credential.Signature))
        {
            return DeviceVerification.Fail("Device signature does not verify.");
        }

        var tenant = await _db.Tenants.IgnoreQueryFilters().FirstOrDefaultAsync(t => t.Id == device.TenantId, ct);
        if (tenant is null) return DeviceVerification.Fail("Device belongs to a tenant that no longer exists.");

        // Burned only once everything else has passed, so a device that fails for an
        // unrelated reason can retry with the same nonce rather than being locked out
        // of its own retry.
        _nonces.Set(nonceKey, true, NonceLifetime);

        // The load-bearing line. Without it every query filter downstream evaluates
        // against Guid.Empty and the endpoints silently see nothing.
        _tenant.Set(tenant.Id, tenant.Slug);

        return DeviceVerification.Ok(device, tenant);
    }

    private static string? CheckClock(long unixSeconds)
    {
        var drift = DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeSeconds(unixSeconds);

        // A box that has just lost power has no RTC and may present a wildly wrong
        // clock. It re-syncs from the heartbeat response; until then it cannot call.
        return drift.Duration() > ClockSkew ? "Device timestamp outside the accepted window." : null;
    }
}
