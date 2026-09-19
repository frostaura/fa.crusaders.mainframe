using System.Globalization;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using Microsoft.Extensions.Configuration;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// Which proxies the API believes <c>X-Forwarded-For</c> / <c>-Proto</c> / <c>-Host</c> from,
/// read out of configuration and audited against how the server is actually bound.
///
/// <para>
/// This is a separate type rather than eight lines in <c>Program.cs</c> for two reasons. The
/// first is that <see cref="Parse"/> has a shape rule that is easy to get wrong and impossible
/// to see: <b>.NET configuration merges arrays by index</b>, so an <c>appsettings.json</c> array
/// of three entries and an environment override of one leaves the other two standing. A club
/// that set <c>Gateway__TrustedProxies__0</c> to its own load balancer was still trusting
/// <c>172.16.0.0/12</c> underneath, which is not narrowing — it is adding. The default is
/// therefore a single delimited <b>string</b> in <c>appsettings.json</c>, which an environment
/// variable replaces whole, and the indexed form is still honoured when a deployment prefers it.
/// </para>
///
/// <para>
/// The second is <see cref="Warnings"/>. Trusting a network is only safe while nothing on that
/// network can reach Kestrel directly, and the on-prem overlay puts the backend on host
/// networking where that stops being true by default. The audit is pure — addresses and URLs in,
/// strings out — so the dangerous combination is pinned by a unit test rather than discovered at
/// a club.
/// </para>
/// </summary>
public static class GatewayTrust
{
    /// <summary>Loopback only. What is left when a deployment clears the setting entirely.</summary>
    public static readonly string[] LoopbackOnly = ["127.0.0.1", "::1"];

    /// <summary>
    /// The compose bridge the gateway container stands on, pinned in <c>docker-compose.yml</c>
    /// so this default names a network that is actually the gateway's rather than the whole
    /// docker pool. Changing one without the other is what this constant exists to make loud.
    /// </summary>
    public const string ComposeBridgeNetwork = "172.29.83.0/24";

    /// <summary>
    /// Hops of <c>X-Forwarded-For</c> the middleware may walk back.
    ///
    /// <para>
    /// Two, not one. The documented internet path is Cloudflare → cloudflared on the club's own
    /// host → the published gateway port, so a member's request reaches nginx already carrying
    /// <c>X-Forwarded-For: &lt;visitor&gt;</c> and leaves it as
    /// <c>&lt;visitor&gt;, &lt;cloudflared&gt;</c> once <c>$proxy_add_x_forwarded_for</c> has
    /// appended nginx's own peer. At the default limit of one the API stopped at cloudflared's
    /// address and put the entire remote membership in a single 10/min auth bucket.
    /// </para>
    ///
    /// <para>
    /// Raising it is safe because the middleware re-checks trust at every hop: it consumes an
    /// entry only when the address it has resolved <i>so far</i> is itself a trusted proxy. A
    /// LAN client forging a header still gets its own address, because nginx's peer for that
    /// request is the LAN client and the LAN is not trusted. That property is why
    /// <see cref="ComposeBridgeNetwork"/> had to replace <c>172.16.0.0/12</c> first: with a /12
    /// covering a club LAN, the second hop would have been consumed from a forger.
    /// </para>
    ///
    /// <para>
    /// A deployment with a third hop in front (a corporate proxy, a second CDN) sets
    /// <c>Gateway:ForwardLimit</c>.
    /// </para>
    /// </summary>
    public const int DefaultForwardLimit = 2;

    private static readonly char[] Separators = [',', ';', ' ', '\t', '\r', '\n'];

    /// <summary>
    /// The trusted-proxy entries, in the order configuration gives them.
    ///
    /// <para>
    /// Three shapes are accepted, in this precedence: indexed children
    /// (<c>Gateway__TrustedProxies__0</c>…), a single delimited scalar
    /// (<c>Gateway__TrustedProxies=127.0.0.1,10.0.0.0/24</c>), and finally
    /// <see cref="LoopbackOnly"/> when the key is absent or empty. Both configured shapes
    /// REPLACE rather than extend, which is the whole point — see the type remarks.
    /// </para>
    /// </summary>
    public static IReadOnlyList<string> Parse(IConfiguration configuration)
    {
        var section = configuration.GetSection("Gateway:TrustedProxies");

        var indexed = section.GetChildren()
            .Select(c => c.Value?.Trim() ?? "")
            .Where(v => v.Length > 0)
            .ToList();
        if (indexed.Count > 0) return indexed;

        var scalar = section.Value;
        if (!string.IsNullOrWhiteSpace(scalar))
        {
            var split = scalar.Split(Separators, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (split.Length > 0) return split;
        }

        return LoopbackOnly;
    }

    /// <summary>A parsed entry: a single address, or a network with its prefix length.</summary>
    public sealed record Entry(string Text, IPAddress Address, int PrefixLength, bool IsNetwork);

    /// <summary>
    /// Parses one entry, or returns null when it is not an address or CIDR at all. Malformed
    /// entries are reported rather than thrown on: a typo in one proxy address must not take
    /// the whole club's API down at boot, and <see cref="Warnings"/> says so out loud.
    /// </summary>
    public static Entry? TryParseEntry(string text)
    {
        var trimmed = text.Trim();
        if (trimmed.Length == 0) return null;

        var slash = trimmed.IndexOf('/');
        if (slash < 0)
        {
            return IPAddress.TryParse(trimmed, out var single)
                ? new Entry(trimmed, single, single.AddressFamily == AddressFamily.InterNetwork ? 32 : 128, false)
                : null;
        }

        if (!IPAddress.TryParse(trimmed[..slash], out var network)) return null;
        if (!int.TryParse(trimmed[(slash + 1)..], NumberStyles.Integer, CultureInfo.InvariantCulture, out var prefix)) return null;

        var maximum = network.AddressFamily == AddressFamily.InterNetwork ? 32 : 128;
        if (prefix < 0 || prefix > maximum) return null;

        return new Entry(trimmed, network, prefix, true);
    }

    /// <summary>True when <paramref name="candidate"/> falls inside this entry.</summary>
    public static bool Contains(Entry entry, IPAddress candidate)
    {
        if (entry.Address.AddressFamily != candidate.AddressFamily) return false;

        var network = entry.Address.GetAddressBytes();
        var probe = candidate.GetAddressBytes();
        if (network.Length != probe.Length) return false;

        var whole = entry.PrefixLength / 8;
        var bits = entry.PrefixLength % 8;

        for (var i = 0; i < whole; i++)
        {
            if (network[i] != probe[i]) return false;
        }
        if (bits == 0) return true;

        var mask = (byte)(0xFF << (8 - bits));
        return (network[whole] & mask) == (probe[whole] & mask);
    }

    /// <summary>
    /// Anything about this trust configuration a club would want shouted at boot rather than
    /// discovered by an audit. Pure, so the combination that produced review finding 15 is a
    /// unit test and not a deployment.
    /// </summary>
    /// <param name="entries">The configured entries, as <see cref="Parse"/> returned them.</param>
    /// <param name="listenUrls">
    /// What the server was told to bind — <c>ASPNETCORE_URLS</c> or <c>Urls</c>. A host in
    /// <c>+</c>, <c>*</c>, <c>0.0.0.0</c> or <c>[::]</c> means every interface on the machine,
    /// which on the host-networked on-prem overlay is every interface on the club LAN.
    /// </param>
    /// <param name="hostAddresses">This machine's own unicast addresses.</param>
    /// <param name="auditBinding">
    /// False in Development, where the bind is a developer's laptop and the overlap is noise.
    /// </param>
    public static IReadOnlyList<string> Warnings(
        IReadOnlyList<string> entries,
        IReadOnlyList<string> listenUrls,
        IReadOnlyList<IPAddress> hostAddresses,
        bool auditBinding)
    {
        var warnings = new List<string>();
        var parsed = new List<Entry>();

        foreach (var text in entries)
        {
            var entry = TryParseEntry(text);
            if (entry is null)
            {
                warnings.Add($"Gateway:TrustedProxies entry '{text}' is neither an IP address nor a CIDR network and is ignored. " +
                             "Every X-Forwarded-* header from that proxy will be disbelieved.");
                continue;
            }
            parsed.Add(entry);

            // A /12 is a million addresses. The default used to be exactly that, and on a club
            // whose LAN happened to be 172.16.x.x it made every laptop a trusted proxy.
            if (entry.IsNetwork && entry.Address.AddressFamily == AddressFamily.InterNetwork && entry.PrefixLength < 16)
            {
                warnings.Add($"Gateway:TrustedProxies trusts {entry.Text}, which is broader than a single site network. " +
                             "Any client inside it can forge X-Forwarded-For and escape every rate limit. " +
                             $"Name the gateway's own network instead (the compose default is {ComposeBridgeNetwork}).");
            }
        }

        if (!auditBinding || !ListensOnEveryInterface(listenUrls)) return warnings;

        foreach (var entry in parsed)
        {
            foreach (var address in hostAddresses)
            {
                if (IPAddress.IsLoopback(address) || !Contains(entry, address)) continue;

                warnings.Add(
                    $"Gateway:TrustedProxies trusts {entry.Text}, which contains this host's own address {address}, " +
                    $"and the server is bound to every interface ({string.Join(", ", listenUrls)}). " +
                    "Anything that can reach that address directly can forge X-Forwarded-For. " +
                    "Bind Kestrel to loopback plus the bridge gateway address (see docker-compose.onprem.yml), or narrow the trusted range.");
                break;
            }
        }

        return warnings;
    }

    /// <summary>This machine's unicast addresses, for <see cref="Warnings"/>.</summary>
    public static IReadOnlyList<IPAddress> HostAddresses()
    {
        try
        {
            return NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.OperationalStatus == OperationalStatus.Up)
                .SelectMany(n => n.GetIPProperties().UnicastAddresses)
                .Select(u => u.Address)
                .ToList();
        }
        catch (NetworkInformationException)
        {
            // A container with no permission to enumerate interfaces must still boot. The
            // audit is advice, not a gate.
            return [];
        }
    }

    private static bool ListensOnEveryInterface(IReadOnlyList<string> listenUrls)
    {
        foreach (var url in listenUrls)
        {
            foreach (var part in url.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var host = HostOf(part);
                if (host is "+" or "*" or "0.0.0.0" or "[::]" or "::") return true;
            }
        }
        return false;
    }

    /// <summary>The host portion of a binding URL, without parsing it as a Uri — "+" is not one.</summary>
    private static string HostOf(string url)
    {
        var afterScheme = url.IndexOf("//", StringComparison.Ordinal) is var i and >= 0 ? url[(i + 2)..] : url;
        var end = afterScheme.IndexOfAny(['/']);
        var authority = end < 0 ? afterScheme : afterScheme[..end];

        // "[::]:5000" — the port separator is the last colon outside the brackets.
        if (authority.StartsWith('['))
        {
            var close = authority.IndexOf(']');
            return close < 0 ? authority : authority[..(close + 1)];
        }

        var colon = authority.LastIndexOf(':');
        return colon < 0 ? authority : authority[..colon];
    }
}
