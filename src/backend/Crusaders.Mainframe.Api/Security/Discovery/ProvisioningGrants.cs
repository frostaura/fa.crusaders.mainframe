using System.Security.Cryptography;
using System.Text;

namespace Crusaders.Mainframe.Api.Security.Discovery;

/// <summary>
/// A short-lived permission for one board to fetch its own device key, once.
///
/// <para>
/// <b>This exists to invert the direction of provisioning.</b> The obvious design is for
/// the API to POST the derived key to the board at the address it announced from — and
/// that address arrived in an unauthenticated UDP datagram from the club LAN. Dialling it
/// is precisely what <c>OutboundAddressGuard</c> was written to prevent, and a discovered
/// RFC1918 address is by definition not on its allow-list. Adding it would have carved a
/// member-reachable hole through the SSRF guard three commits after building it.
/// </para>
///
/// <para>
/// So the board fetches instead of being pushed to. The claim code is what authenticates
/// it: the board generated it and is displaying it, the admin read it off the LCD and
/// typed it into the API, and it has never been on the wire. Nothing dials anything, and
/// the API's outbound posture is unchanged.
/// </para>
///
/// <para>
/// Nothing secret is stored. The grant holds the tenant, the device and the key version,
/// which is all <c>IDeviceKeyDeriver</c> needs — so the key is re-derived on collection
/// rather than sat in memory waiting to be read. The claim code is held as a SHA-256
/// hash for the same reason.
/// </para>
/// </summary>
public sealed record ProvisioningGrant
{
    public required string Mac { get; init; }
    public required byte[] ClaimCodeHash { get; init; }
    public required Guid DeviceId { get; init; }
    public required Guid TenantId { get; init; }
    public required string TenantSlug { get; init; }
    public required int KeyVersion { get; init; }
    public required DateTimeOffset ExpiresAt { get; init; }
}

public sealed class ProvisioningGrants
{
    /// <summary>
    /// How long an admin has between clicking "connect" and the board collecting its key.
    /// A board announces every 5 seconds, so this is generous by three orders of
    /// magnitude — it is sized for someone being interrupted, not for the protocol.
    /// </summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(10);

    /// <summary>A ceiling, so a flood of claims cannot grow this without bound.</summary>
    private const int MaxGrants = 64;

    private readonly Dictionary<string, ProvisioningGrant> _grants = new(StringComparer.OrdinalIgnoreCase);
    private readonly Lock _gate = new();
    private readonly TimeProvider _clock;

    public ProvisioningGrants(TimeProvider? clock = null) => _clock = clock ?? TimeProvider.System;

    public static byte[] HashCode(string claimCode) =>
        SHA256.HashData(Encoding.UTF8.GetBytes(claimCode.Trim().ToUpperInvariant()));

    public void Issue(ProvisioningGrant grant)
    {
        lock (_gate)
        {
            Prune();

            // At capacity, a new grant still displaces the oldest: refusing would let an
            // attacker who can spam claims lock out the admin standing at the cupboard,
            // and unlike the announcer store there is no unauthenticated path here — every
            // grant came from an authenticated admin action.
            if (_grants.Count >= MaxGrants)
            {
                var oldest = _grants.OrderBy(g => g.Value.ExpiresAt).First().Key;
                _grants.Remove(oldest);
            }

            _grants[grant.Mac] = grant;
        }
    }

    /// <summary>
    /// Redeems a grant. Single-use: it is removed whether or not the code matched, so a
    /// wrong guess costs the attacker the grant rather than giving them another turn.
    /// </summary>
    public ProvisioningGrant? Redeem(string mac, string claimCode)
    {
        lock (_gate)
        {
            Prune();

            if (!_grants.TryGetValue(mac, out var grant)) return null;
            _grants.Remove(mac);

            var presented = HashCode(claimCode);

            // Constant-time: the hashes are fixed-length, and a length-varying or
            // short-circuiting compare here leaks the code a byte at a time.
            return CryptographicOperations.FixedTimeEquals(presented, grant.ClaimCodeHash) ? grant : null;
        }
    }

    public int Count
    {
        get { lock (_gate) { Prune(); return _grants.Count; } }
    }

    private void Prune()
    {
        var now = _clock.GetUtcNow();
        foreach (var mac in _grants.Where(g => g.Value.ExpiresAt <= now).Select(g => g.Key).ToList())
        {
            _grants.Remove(mac);
        }
    }
}
