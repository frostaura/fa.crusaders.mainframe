using System.Net;
using System.Net.Sockets;

namespace Crusaders.Mainframe.Api.Security.Outbound;

/// <summary>
/// Decides whether this deployment may open an outbound connection to an address.
///
/// <para>
/// <b>This did not exist.</b> <c>CLAUDE.md</c> and <c>docs/specs/webhooks.md</c> both
/// describe an SSRF guard with a deliberate LAN carve-out for the lights controller,
/// and the code had neither: <c>ValidateUrl</c> checked the scheme and nothing else,
/// with <c>allowLan: true</c> hardcoded at both call sites. Any authenticated
/// <i>member</i> could register a webhook pointing at any address the server can
/// reach, and then read the first 512 bytes of the response back through
/// <c>GET /api/v1/admin/webhooks/{id}/deliveries</c>. That is not blind SSRF; it is
/// SSRF with readback.
/// </para>
///
/// <para>
/// It matters more here than in a cloud deployment, not less. The API is designed to
/// run <i>on-prem, on the club LAN</i>, alongside the router, the court boxes and
/// whatever else is plugged in — so "internal network" is the same network a member
/// with a login is already asking the server to reach.
/// </para>
/// </summary>
public interface IOutboundAddressGuard
{
    /// <summary>Null when the address may be dialled; a machine-readable reason when it may not.</summary>
    ///
    /// <param name="honourAllowList">
    /// <c>true</c> — the default and the behaviour the lights controller depends on —
    /// applies <c>Webhooks:PrivateNetworkAllowList</c>, so an operator can name the board's
    /// LAN address and have the API reach it.
    ///
    /// <para>
    /// <c>false</c> refuses every restricted address regardless of the allow-list. That is
    /// for destinations chosen by somebody who is not an administrator. The carve-out exists
    /// so the club can drive its own hardware; it is not a general licence to aim the API at
    /// its own network, and a member-owned webhook endpoint pointed at the relay controller
    /// is a member switching court lights on by creating a booking. Admin-owned endpoints
    /// keep the carve-out; member-owned ones do not get to use it.
    /// </para>
    /// </param>
    string? Check(IPAddress address, bool honourAllowList = true);

    /// <summary>Registration-time check of a host that has not been resolved yet.</summary>
    string? CheckHostLiteral(string host, bool honourAllowList = true);
}

public sealed class OutboundAddressGuard : IOutboundAddressGuard
{
    private readonly bool _allowPrivate;
    private readonly List<(IPAddress Network, int Prefix)> _allowList;
    private readonly ILogger<OutboundAddressGuard> _logger;

    public OutboundAddressGuard(IConfiguration config, IHostEnvironment env, ILogger<OutboundAddressGuard> logger)
    {
        _logger = logger;

        // Development runs against MailHog, a local API and a simulator on localhost, so
        // blocking private space by default there would block the whole dev loop. Outside
        // Development it is denied unless an operator opts in.
        _allowPrivate = config.GetValue("Webhooks:AllowPrivateNetworks", env.IsDevelopment());

        _allowList = ParseAllowList(config.GetSection("Webhooks:PrivateNetworkAllowList").Get<string[]>() ?? []);
    }

    /// <summary>
    /// The carve-out. <c>CLAUDE.md</c> is explicit that it exists for the lights
    /// controller and must not be closed — a court box lives at a fixed RFC1918
    /// address on the club LAN and there is nowhere else for it to be. So the guard is
    /// an allow-list of specific CIDRs rather than a global on/off: "192.168.68.150/32"
    /// admits one board, not the entire private internet.
    /// </summary>
    private List<(IPAddress, int)> ParseAllowList(string[] entries)
    {
        var parsed = new List<(IPAddress, int)>();

        foreach (var entry in entries)
        {
            var slash = entry.IndexOf('/');
            var addressPart = slash < 0 ? entry : entry[..slash];

            if (!IPAddress.TryParse(addressPart.Trim(), out var address))
            {
                _logger.LogWarning("Ignoring unparseable webhook allow-list entry '{Entry}'", entry);
                continue;
            }

            var defaultPrefix = address.AddressFamily == AddressFamily.InterNetworkV6 ? 128 : 32;
            var prefix = defaultPrefix;

            if (slash >= 0 && (!int.TryParse(entry[(slash + 1)..], out prefix) || prefix < 0 || prefix > defaultPrefix))
            {
                _logger.LogWarning("Ignoring webhook allow-list entry '{Entry}': bad prefix length", entry);
                continue;
            }

            parsed.Add((address, prefix));
        }

        return parsed;
    }

    public string? Check(IPAddress address, bool honourAllowList = true)
    {
        // Unwrap ::ffff:10.0.0.1 before classifying. An IPv4-mapped IPv6 literal is the
        // standard way past a guard that only knows how to read IPv4.
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        // BP-19: and the other IPv6 spellings of an IPv4 address — NAT64, 6to4 and the
        // deprecated IPv4-compatible form — which a host with that routing delivers to the
        // embedded IPv4 address. Judged as that address, allow-list included.
        else if (EmbeddedIPv4(address) is { } embedded) address = embedded;

        if (!IsRestricted(address)) return null;
        if (honourAllowList && IsAllowListed(address)) return null;

        // The development escape hatch is deliberately still honoured here: a developer
        // running the whole stack on one machine has every destination restricted, and a
        // guard that cannot be switched off locally is one somebody removes instead.
        if (_allowPrivate) return null;

        return "destination_not_permitted";
    }

    public string? CheckHostLiteral(string host, bool honourAllowList = true)
    {
        // Only a literal can be judged here. A name is judged at connect time, on the
        // address it actually resolves to — see GuardedHttpClient.
        return IPAddress.TryParse(host.Trim('[', ']'), out var address)
            ? Check(address, honourAllowList)
            : null;
    }

    private bool IsAllowListed(IPAddress address) =>
        _allowList.Any(entry => InNetwork(address, entry.Network, entry.Prefix));

    private static bool InNetwork(IPAddress address, IPAddress network, int prefixLength)
    {
        if (address.AddressFamily != network.AddressFamily) return false;

        var a = address.GetAddressBytes();
        var n = network.GetAddressBytes();

        var fullBytes = prefixLength / 8;
        for (var i = 0; i < fullBytes; i++)
        {
            if (a[i] != n[i]) return false;
        }

        var remainingBits = prefixLength % 8;
        if (remainingBits == 0) return true;

        var mask = (byte)(0xFF << (8 - remainingBits));
        return (a[fullBytes] & mask) == (n[fullBytes] & mask);
    }

    /// <summary>
    /// Everything that is not the public internet, as data rather than as a chain of
    /// conditions.
    ///
    /// <para>
    /// Deliberately broader than RFC1918. <c>169.254.169.254</c> is the cloud metadata
    /// endpoint and is link-local, not private — a guard that knows only RFC1918 hands
    /// out instance credentials.
    /// </para>
    ///
    /// <para>
    /// A table because the same <see cref="InNetwork"/> matcher then serves both this
    /// and the operator's allow-list. Two matchers for two lists is how a range ends up
    /// classified one way when blocking and another way when allowing.
    /// </para>
    /// </summary>
    private static readonly (string Cidr, string Why)[] RestrictedRanges =
    [
        ("0.0.0.0/8", "this network"),
        ("10.0.0.0/8", "RFC1918 private"),
        ("100.64.0.0/10", "carrier-grade NAT"),
        ("127.0.0.0/8", "loopback"),
        ("169.254.0.0/16", "link-local, and the cloud metadata endpoint"),
        ("172.16.0.0/12", "RFC1918 private"),
        ("192.0.0.0/24", "IETF protocol assignments"),
        ("192.0.2.0/24", "TEST-NET-1"),
        ("192.168.0.0/16", "RFC1918 private"),
        ("198.18.0.0/15", "benchmarking"),
        ("198.51.100.0/24", "TEST-NET-2"),
        ("203.0.113.0/24", "TEST-NET-3"),
        ("224.0.0.0/4", "multicast"),
        ("240.0.0.0/4", "reserved, and the broadcast address"),
    ];

    private static readonly (IPAddress Network, int Prefix)[] RestrictedNetworks =
        RestrictedRanges.Select(r =>
        {
            var slash = r.Cidr.IndexOf('/');
            return (IPAddress.Parse(r.Cidr[..slash]), int.Parse(r.Cidr[(slash + 1)..]));
        }).ToArray();

    /// <summary>
    /// The IPv4 address an IPv6 address carries inside it, for the three forms that are routed
    /// to it: NAT64's well-known prefix <c>64:ff9b::/96</c> (RFC 6052), 6to4 <c>2002::/16</c>
    /// (RFC 3056, the IPv4 in bytes 2-5) and IPv4-compatible <c>::a.b.c.d</c> (RFC 4291 §2.5.5.1,
    /// deprecated but still parsed). Null for every other address, <c>::</c> and <c>::1</c> included.
    /// </summary>
    internal static IPAddress? EmbeddedIPv4(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetworkV6) return null;
        var b = address.GetAddressBytes();

        if (b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b && b.AsSpan(4, 8).IndexOfAnyExcept((byte)0) < 0)
        {
            return new IPAddress(b.AsSpan(12, 4));
        }

        if (b[0] == 0x20 && b[1] == 0x02) return new IPAddress(b.AsSpan(2, 4));

        // ::a.b.c.d — but :: and ::1 are their own things (any, loopback) and handled as such.
        if (b.AsSpan(0, 12).IndexOfAnyExcept((byte)0) < 0 && (b[12] | b[13]) != 0)
        {
            return new IPAddress(b.AsSpan(12, 4));
        }

        return null;
    }

    private static bool IsRestricted(IPAddress address)
    {
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            var b = address.GetAddressBytes();
            return IPAddress.IsLoopback(address)
                   || address.Equals(IPAddress.IPv6Any)
                   || address.IsIPv6LinkLocal
                   || address.IsIPv6SiteLocal
                   || address.IsIPv6Multicast
                   || address.IsIPv6UniqueLocal
                   // Teredo (2001::/32) hides its client's IPv4 address, and NAT64's local-use
                   // prefix (64:ff9b:1::/48, RFC 8215) is translated by the operator's own gateway:
                   // neither can be judged by what it carries, so neither is a webhook destination.
                   || address.IsIPv6Teredo
                   || (b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b && b[4] == 0x00 && b[5] == 0x01);
        }

        return RestrictedNetworks.Any(n => InNetwork(address, n.Network, n.Prefix));
    }
}
