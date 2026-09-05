using System.Net;
using Crusaders.Mainframe.Api.Security;
using Microsoft.Extensions.Configuration;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The two halves of <see cref="GatewayTrust"/> that cannot be reached from an HTTP test:
/// how configuration is READ (the array-merge trap that made the default unnarrowable) and
/// what the startup audit says about a configuration that is syntactically fine and
/// operationally dangerous.
///
/// <para>
/// The audit is a pure function precisely so the combination behind round-3 finding 15 —
/// a trusted network containing this host's own address while Kestrel is bound to every
/// interface — is pinned here rather than discovered at a club. No sockets, no host.
/// </para>
/// </summary>
public sealed class GatewayTrustTests
{
    private static IConfiguration Config(params (string Key, string? Value)[] pairs)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(pairs.Select(p => new KeyValuePair<string, string?>(p.Key, p.Value)))
            .Build();

    // ---- reading the setting -------------------------------------------------------------

    [Fact]
    public void An_absent_setting_falls_back_to_loopback_only()
        => Assert.Equal(GatewayTrust.LoopbackOnly, GatewayTrust.Parse(Config()));

    /// <summary>The shipped shape: one delimited scalar, so an override replaces it whole.</summary>
    [Theory]
    [InlineData("127.0.0.1,::1,172.29.83.0/24")]
    [InlineData("127.0.0.1 ::1 172.29.83.0/24")]
    [InlineData("127.0.0.1; ::1; 172.29.83.0/24")]
    public void A_delimited_scalar_is_split_on_commas_semicolons_and_whitespace(string value)
    {
        var parsed = GatewayTrust.Parse(Config(("Gateway:TrustedProxies", value)));
        Assert.Equal(["127.0.0.1", "::1", "172.29.83.0/24"], parsed);
    }

    /// <summary>
    /// The dropped lead, made a test. Configuration merges arrays by index: with a
    /// three-entry array in appsettings.json, setting index 0 replaced one entry and left
    /// the other two — so a club could add a proxy but never remove the /12 underneath. A
    /// scalar default has no children to merge with, so the indexed form narrows correctly.
    /// </summary>
    [Fact]
    public void The_indexed_form_replaces_the_scalar_default_rather_than_merging_into_it()
    {
        var parsed = GatewayTrust.Parse(Config(
            ("Gateway:TrustedProxies", "127.0.0.1,::1,172.29.83.0/24"),
            ("Gateway:TrustedProxies:0", "10.4.4.4")));

        Assert.Equal(["10.4.4.4"], parsed);
    }

    /// <summary>An explicitly emptied setting is loopback, not "trust nothing that was there before, plus everything".</summary>
    [Fact]
    public void An_empty_setting_falls_back_to_loopback_rather_than_the_shipped_range()
        => Assert.Equal(GatewayTrust.LoopbackOnly, GatewayTrust.Parse(Config(("Gateway:TrustedProxies", "   "))));

    // ---- parsing one entry ---------------------------------------------------------------

    [Theory]
    [InlineData("172.29.83.0/24", "172.29.83.4", true)]
    [InlineData("172.29.83.0/24", "172.29.84.4", false)]
    [InlineData("172.16.0.0/12", "172.16.40.7", true)]
    [InlineData("172.16.0.0/12", "192.168.68.5", false)]
    [InlineData("127.0.0.1", "127.0.0.1", true)]
    [InlineData("127.0.0.1", "127.0.0.2", false)]
    [InlineData("10.0.0.0/8", "10.255.255.255", true)]
    public void Containment_follows_the_prefix(string entry, string candidate, bool expected)
    {
        var parsed = GatewayTrust.TryParseEntry(entry);
        Assert.NotNull(parsed);
        Assert.Equal(expected, GatewayTrust.Contains(parsed, IPAddress.Parse(candidate)));
    }

    [Theory]
    [InlineData("not-an-address")]
    [InlineData("172.29.83.0/33")]
    [InlineData("172.29.83.0/abc")]
    [InlineData("")]
    public void A_malformed_entry_is_reported_rather_than_thrown_on(string entry)
        => Assert.Null(GatewayTrust.TryParseEntry(entry));

    // ---- the startup audit ---------------------------------------------------------------

    /// <summary>The shipped default, bound as the base compose file binds it: nothing to say.</summary>
    [Fact]
    public void The_shipped_default_produces_no_warning()
    {
        var warnings = GatewayTrust.Warnings(
            ["127.0.0.1", "::1", GatewayTrust.ComposeBridgeNetwork],
            ["http://+:5000"],
            [IPAddress.Loopback, IPAddress.Parse("192.168.68.20")],
            auditBinding: true);

        Assert.Empty(warnings);
    }

    /// <summary>
    /// A /12 is a million addresses and is warned about on its own merits, whatever the
    /// bind — it is what the default used to be, and what made finding 15 reachable.
    /// </summary>
    [Fact]
    public void A_range_broader_than_a_site_network_is_warned_about_regardless_of_binding()
    {
        var warnings = GatewayTrust.Warnings(
            ["127.0.0.1", "172.16.0.0/12"],
            ["http://127.0.0.1:5000"],
            [IPAddress.Loopback],
            auditBinding: true);

        Assert.Contains(warnings, w => w.Contains("172.16.0.0/12") && w.Contains("broader than a single site network"));
    }

    /// <summary>
    /// Finding 15 exactly: host networking, Kestrel on every interface, and a trusted range
    /// that happens to contain the club LAN this host is on.
    /// </summary>
    [Fact]
    public void A_trusted_range_containing_this_hosts_own_address_is_warned_about_when_bound_to_every_interface()
    {
        var warnings = GatewayTrust.Warnings(
            ["127.0.0.1", "172.16.0.0/12"],
            ["http://+:5000"],
            [IPAddress.Loopback, IPAddress.Parse("172.16.40.7")],
            auditBinding: true);

        Assert.Contains(warnings, w => w.Contains("172.16.40.7") && w.Contains("bound to every interface"));
    }

    /// <summary>
    /// The same range once the on-prem overlay binds explicitly. Nothing on the LAN can
    /// reach Kestrel, so the overlap is no longer a way in — only the breadth warning stands.
    /// </summary>
    [Fact]
    public void An_explicit_binding_silences_the_overlap_warning()
    {
        var warnings = GatewayTrust.Warnings(
            ["127.0.0.1", "172.16.0.0/12"],
            ["http://127.0.0.1:5000;http://172.17.0.1:5000"],
            [IPAddress.Loopback, IPAddress.Parse("172.16.40.7")],
            auditBinding: true);

        Assert.DoesNotContain(warnings, w => w.Contains("bound to every interface"));
    }

    [Theory]
    [InlineData("http://*:5000")]
    [InlineData("http://0.0.0.0:5000")]
    [InlineData("http://[::]:5000")]
    public void Every_spelling_of_a_wildcard_binding_counts_as_one(string url)
    {
        var warnings = GatewayTrust.Warnings(
            ["10.0.0.0/24"],
            [url],
            [IPAddress.Parse("10.0.0.9")],
            auditBinding: true);

        Assert.Contains(warnings, w => w.Contains("bound to every interface"));
    }

    /// <summary>Development is a laptop, where the overlap is noise rather than exposure.</summary>
    [Fact]
    public void The_binding_audit_is_skipped_in_development()
    {
        var warnings = GatewayTrust.Warnings(
            ["10.0.0.0/24"],
            ["http://+:5000"],
            [IPAddress.Parse("10.0.0.9")],
            auditBinding: false);

        Assert.Empty(warnings);
    }

    /// <summary>
    /// An entry that is not an address at all is silently ignored by the middleware, which
    /// means a typo turns a trusted gateway into an untrusted one and every member back
    /// into one bucket. Named out loud instead.
    /// </summary>
    [Fact]
    public void A_malformed_entry_is_named_in_the_warnings()
    {
        var warnings = GatewayTrust.Warnings(
            ["127.0.0.1", "172.29.83.0/24 "],
            ["http://127.0.0.1:5000"],
            [],
            auditBinding: true);
        Assert.Empty(warnings);

        var bad = GatewayTrust.Warnings(
            ["127.0.0.1", "gateway.local"],
            ["http://127.0.0.1:5000"],
            [],
            auditBinding: true);
        Assert.Contains(bad, w => w.Contains("gateway.local") && w.Contains("ignored"));
    }

    // Drift between appsettings.json's shipped default and the constants above is checked
    // by RateLimitTests, not here — deliberately. A test that read appsettings.json off
    // disk would be the obvious version of it and is unrunnable on this repository's own
    // checkout: under an iCloud-synced `.claude/` the BSD `hidden` flag reappears on the
    // file mid-run and .NET's PhysicalFileProvider excludes it (see memory/gotchas.md).
    // The_pinned_compose_bridge_is_still_trusted and
    // Two_forwarded_hops_through_cloudflared_are_distinct_partitions boot the real
    // Program.cs reading the real appsettings.json with no override, so they fail if the
    // shipped network or the shipped forward limit moves — which is the stronger check
    // anyway: they prove what the running application trusts, not what a file says.
}
