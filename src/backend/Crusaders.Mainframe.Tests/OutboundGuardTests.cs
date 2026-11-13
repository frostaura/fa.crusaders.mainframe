using System.Net;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Security.Outbound;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Regression tests for a guard that <b>did not exist</b>.
///
/// <para>
/// Two documents described it — <c>CLAUDE.md</c> and <c>docs/specs/webhooks.md</c>,
/// both promising an SSRF guard with a LAN carve-out for the lights controller — and
/// the code had neither. <c>ValidateUrl</c> checked the scheme, and <c>allowLan: true</c>
/// was hardcoded at both call sites. Any authenticated <i>member</i> could register a
/// webhook at any address the server could reach and read 512 bytes of the response
/// back through the deliveries endpoint.
/// </para>
///
/// <para>
/// The deployment target makes it worse rather than better: the API runs on-prem on
/// the club LAN, next to the router and the court boxes.
/// </para>
/// </summary>
public class OutboundGuardTests
{
    private sealed class Env : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Production";
        public string ApplicationName { get; set; } = "tests";
        public string ContentRootPath { get; set; } = ".";
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } =
            new Microsoft.Extensions.FileProviders.NullFileProvider();
    }

    /// <summary>
    /// <paramref name="allowPrivate"/> is nullable on purpose: passing it always-set
    /// would mask the environment default, which is the behaviour most likely to be
    /// got backwards and therefore the one most worth testing.
    /// </summary>
    private static OutboundAddressGuard Guard(
        bool? allowPrivate = false, string[]? allowList = null, string environment = "Production")
    {
        var settings = new Dictionary<string, string?>();

        if (allowPrivate is not null)
        {
            settings["Webhooks:AllowPrivateNetworks"] = allowPrivate.Value ? "true" : "false";
        }

        for (var i = 0; i < (allowList?.Length ?? 0); i++)
        {
            settings[$"Webhooks:PrivateNetworkAllowList:{i}"] = allowList![i];
        }

        return new OutboundAddressGuard(
            new ConfigurationBuilder().AddInMemoryCollection(settings).Build(),
            new Env { EnvironmentName = environment },
            NullLogger<OutboundAddressGuard>.Instance);
    }

    /// <summary>
    /// The addresses that must never be reachable from a member-supplied URL.
    /// 169.254.169.254 is the one that matters most and is the one an RFC1918-only
    /// guard misses: it is link-local, not private, and it hands out cloud credentials.
    /// </summary>
    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("127.0.0.53")]
    [InlineData("0.0.0.0")]
    [InlineData("10.0.0.1")]
    [InlineData("10.255.255.255")]
    [InlineData("172.16.0.1")]
    [InlineData("172.31.255.254")]
    [InlineData("192.168.68.1")]
    [InlineData("192.168.68.150")]
    [InlineData("169.254.169.254")]
    [InlineData("169.254.0.1")]
    [InlineData("100.64.0.1")]
    [InlineData("224.0.0.1")]
    [InlineData("255.255.255.255")]
    [InlineData("::1")]
    [InlineData("fe80::1")]
    [InlineData("fc00::1")]
    [InlineData("fd00::1")]
    [InlineData("::ffff:10.0.0.1")]      // IPv4-mapped: the standard way past a v4-only guard
    [InlineData("::ffff:169.254.169.254")]
    public void Restricted_addresses_are_refused(string address)
    {
        Assert.NotNull(Guard().Check(IPAddress.Parse(address)));
    }

    /// <summary>
    /// BP-19: the IPv6 spellings of an IPv4 address that a host with NAT64 or 6to4 routing
    /// delivers to that address. Only IPv4-mapped was unwrapped, so <c>64:ff9b::a9fe:a9fe</c>
    /// reached the metadata endpoint on such a host. Teredo and NAT64's local-use prefix cannot be
    /// judged by what they carry and are refused outright.
    /// </summary>
    [Theory]
    [InlineData("64:ff9b::a9fe:a9fe")]     // NAT64 of 169.254.169.254
    [InlineData("64:ff9b::10.0.0.1")]
    [InlineData("64:ff9b::127.0.0.1")]
    [InlineData("2002:0a00:0001::1")]      // 6to4 of 10.0.0.1
    [InlineData("2002:c0a8:4401::")]       // 6to4 of 192.168.68.1
    [InlineData("::10.0.0.1")]             // IPv4-compatible
    [InlineData("::169.254.169.254")]
    [InlineData("2001:0:4136:e378:8000:63bf:3fff:fdd2")]  // Teredo
    [InlineData("64:ff9b:1::808:808")]     // NAT64 local-use, even of a public address
    public void IPv6_forms_of_a_restricted_IPv4_address_are_refused(string address)
    {
        Assert.NotNull(Guard().Check(IPAddress.Parse(address)));
    }

    /// <summary>
    /// The same forms carrying a PUBLIC IPv4 address are that address, and permitted — a guard that
    /// refused every NAT64 destination would break webhooks on an IPv6-only host.
    /// </summary>
    [Theory]
    [InlineData("64:ff9b::808:808")]       // NAT64 of 8.8.8.8
    [InlineData("2002:0808:0808::1")]      // 6to4 of 8.8.8.8
    [InlineData("::8.8.8.8")]
    public void IPv6_forms_of_a_public_IPv4_address_are_that_address(string address)
    {
        Assert.Null(Guard().Check(IPAddress.Parse(address)));
    }

    /// <summary>The allow-list judges the embedded address too: a listed board is reachable however it is spelled.</summary>
    [Fact]
    public void An_allow_listed_board_reached_through_NAT64_is_still_allowed()
    {
        var guard = Guard(allowList: ["192.168.68.150/32"]);
        Assert.Null(guard.Check(IPAddress.Parse("64:ff9b::192.168.68.150")));
        Assert.NotNull(guard.Check(IPAddress.Parse("64:ff9b::192.168.68.151")));
        Assert.Null(OutboundAddressGuard.EmbeddedIPv4(IPAddress.Parse("::1")));
        Assert.Null(OutboundAddressGuard.EmbeddedIPv4(IPAddress.Parse("::")));
    }

    /// <summary>
    /// The other half. A guard that blocks everything is not a guard, it is an outage —
    /// and the webhook feature exists to reach real receivers.
    /// </summary>
    [Theory]
    [InlineData("8.8.8.8")]
    [InlineData("1.1.1.1")]
    [InlineData("172.32.0.1")]           // just outside 172.16.0.0/12
    [InlineData("172.15.255.255")]       // just below it
    [InlineData("192.169.0.1")]          // just outside 192.168.0.0/16
    [InlineData("100.128.0.1")]          // just outside 100.64.0.0/10
    [InlineData("100.63.255.255")]       // just below it
    [InlineData("2606:4700:4700::1111")]
    public void Public_addresses_are_permitted(string address)
    {
        Assert.Null(Guard().Check(IPAddress.Parse(address)));
    }

    /// <summary>
    /// The carve-out CLAUDE.md requires and forbids closing. A court box lives at a
    /// fixed RFC1918 address on the club LAN and there is nowhere else for it to be.
    /// A /32 admits one board, not the private internet.
    /// </summary>
    [Fact]
    public void The_lights_controller_carve_out_admits_exactly_what_it_names()
    {
        var guard = Guard(allowList: ["192.168.68.150/32"]);

        Assert.Null(guard.Check(IPAddress.Parse("192.168.68.150")));

        // The neighbour is not admitted, and neither is the router.
        Assert.NotNull(guard.Check(IPAddress.Parse("192.168.68.151")));
        Assert.NotNull(guard.Check(IPAddress.Parse("192.168.68.1")));
        Assert.NotNull(guard.Check(IPAddress.Parse("10.0.0.1")));
        Assert.NotNull(guard.Check(IPAddress.Parse("169.254.169.254")));
    }


    /// <summary>
    /// The carve-out belongs to the club, not to whoever registered the endpoint.
    ///
    /// <para>
    /// <c>POST /api/v1/webhooks</c> is authenticated but not admin-gated, and the only
    /// destination check was the guard — which admits anything on the allow-list. So once
    /// the operator names the board's LAN address, as the deployment requires, any member
    /// could register a webhook aimed at <c>http://192.168.68.150/relay/on</c> and then
    /// trigger delivery by making a booking of their own: <c>booking.created</c> carries
    /// their own subject id, which is exactly what the owner filter matches on. The owner
    /// filter restricts which events reach an endpoint, never where it points.
    /// </para>
    ///
    /// <para>
    /// Closing the carve-out is not an option — it exists so the API can reach the lights
    /// controller, and <c>CLAUDE.md</c> says so outright. Scoping it is: admin-registered
    /// endpoints keep it, member-registered ones do not.
    /// </para>
    /// </summary>
    [Fact]
    public void The_carve_out_applies_to_the_clubs_own_endpoints_and_not_to_a_members()
    {
        var guard = Guard(allowList: ["192.168.68.150/32"]);
        var board = IPAddress.Parse("192.168.68.150");

        // The club's own endpoint reaches its own hardware.
        Assert.Null(guard.Check(board, honourAllowList: true));
        Assert.Null(guard.CheckHostLiteral("192.168.68.150", honourAllowList: true));

        // A member's does not, even though the address is allow-listed.
        Assert.NotNull(guard.Check(board, honourAllowList: false));
        Assert.NotNull(guard.CheckHostLiteral("192.168.68.150", honourAllowList: false));

        // And the public internet is unaffected either way — this narrows one carve-out,
        // it does not make the guard stricter about anything else. (Not a 203.0.113.x
        // documentation address: those are restricted in their own right, which is correct
        // and would make this assert for the wrong reason.)
        Assert.Null(guard.Check(IPAddress.Parse("8.8.8.8"), honourAllowList: false));
    }

    [Fact]
    public void A_carve_out_subnet_admits_its_whole_range_and_no_more()
    {
        var guard = Guard(allowList: ["192.168.68.0/24"]);

        Assert.Null(guard.Check(IPAddress.Parse("192.168.68.1")));
        Assert.Null(guard.Check(IPAddress.Parse("192.168.68.255")));
        Assert.NotNull(guard.Check(IPAddress.Parse("192.168.69.1")));
        Assert.NotNull(guard.Check(IPAddress.Parse("192.168.67.255")));
    }

    /// <summary>A prefix that is not on a byte boundary must still be honoured exactly.</summary>
    [Fact]
    public void A_non_byte_aligned_prefix_is_computed_correctly()
    {
        var guard = Guard(allowList: ["10.0.0.0/12"]);

        Assert.Null(guard.Check(IPAddress.Parse("10.0.0.1")));
        Assert.Null(guard.Check(IPAddress.Parse("10.15.255.255")));
        Assert.NotNull(guard.Check(IPAddress.Parse("10.16.0.1")));
    }

    [Fact]
    public void A_malformed_allow_list_entry_is_ignored_rather_than_opening_everything()
    {
        var guard = Guard(allowList: ["not-an-address", "10.0.0.0/99", "192.168.68.150/32"]);

        Assert.Null(guard.Check(IPAddress.Parse("192.168.68.150")));
        Assert.NotNull(guard.Check(IPAddress.Parse("10.0.0.1")));
        Assert.NotNull(guard.Check(IPAddress.Parse("192.168.68.151")));
    }

    /// <summary>
    /// Development runs against MailHog, a local API and a simulator on localhost, so
    /// the default there is permissive. Everywhere else it is not — and that difference
    /// is the one most likely to be got backwards.
    /// </summary>
    [Fact]
    public void Development_is_permissive_and_production_is_not()
    {
        Assert.Null(Guard(allowPrivate: null, environment: "Development").Check(IPAddress.Loopback));
        Assert.NotNull(Guard(allowPrivate: null, environment: "Production").Check(IPAddress.Loopback));
        Assert.NotNull(Guard(allowPrivate: null, environment: "Staging").Check(IPAddress.Loopback));

        // ...and an explicit false still wins in Development, so an operator who wants
        // the guard on locally can have it.
        Assert.NotNull(Guard(allowPrivate: false, environment: "Development").Check(IPAddress.Loopback));
    }

    [Fact]
    public void An_explicit_opt_in_overrides_the_production_default()
    {
        Assert.Null(Guard(allowPrivate: true).Check(IPAddress.Parse("10.0.0.1")));
    }

    // ---- Registration-time validation --------------------------------------

    [Theory]
    [InlineData("http://169.254.169.254/latest/meta-data/")]
    [InlineData("http://192.168.68.1/cgi-bin/admin")]
    [InlineData("http://127.0.0.1:5432/")]
    [InlineData("http://[::1]:8080/")]
    [InlineData("https://10.0.0.5/hook")]
    public void An_address_literal_pointing_inward_is_refused_at_registration(string url)
    {
        Assert.NotNull(WebhookEndpoints.ValidateUrl(url, Guard()));
    }

    [Theory]
    [InlineData("https://hooks.example.com/crusaders")]
    [InlineData("https://example.com/hook?booking={booking_id}")]
    public void A_legitimate_url_is_accepted_at_registration(string url)
    {
        Assert.Null(WebhookEndpoints.ValidateUrl(url, Guard()));
    }

    [Theory]
    [InlineData(null, "url_required")]
    [InlineData("", "url_required")]
    [InlineData("   ", "url_required")]
    [InlineData("not a url", "url_invalid")]
    [InlineData("ftp://example.com/x", "scheme_must_be_http_or_https")]
    [InlineData("file:///etc/passwd", "scheme_must_be_http_or_https")]
    [InlineData("gopher://example.com/", "scheme_must_be_http_or_https")]
    [InlineData("https://{tenant}.example.com/hook", "template_variable_not_allowed_in_host")]
    [InlineData("https://{host}/hook", "template_variable_not_allowed_in_host")]
    [InlineData("https://example.com:{port}/hook", "template_variable_not_allowed_in_host")]
    public void A_malformed_url_is_refused_with_a_specific_reason(string? url, string expected)
    {
        Assert.Equal(expected, WebhookEndpoints.ValidateUrl(url, Guard()));
    }

    /// <summary>
    /// Registration-time validation is a courtesy, not the boundary. A hostname that
    /// resolves inward passes here on purpose — it is judged again, on the address it
    /// actually resolves to, in the connect callback. Asserting that explicitly stops
    /// someone reading this file and concluding the check is complete.
    /// </summary>
    [Fact]
    public void A_hostname_is_deferred_to_connect_time_rather_than_resolved_here()
    {
        Assert.Null(WebhookEndpoints.ValidateUrl("http://localhost.evil.example.com/x", Guard()));
    }

    /// <summary>
    /// Template variables outside the host stay legal — they are the feature. Only the
    /// destination is fixed at registration.
    /// </summary>
    [Theory]
    [InlineData("https://example.com/hook/{booking_id}")]
    [InlineData("https://example.com/hook?user={user_id}&t={type}")]
    public void Template_variables_outside_the_host_are_still_allowed(string url)
    {
        Assert.Null(WebhookEndpoints.ValidateUrl(url, Guard()));
    }
}
