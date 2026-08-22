using Crusaders.Mainframe.Api.Multitenancy;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Host-to-tenant-slug derivation.
///
/// <para>
/// The club runs this API on-prem, on the same LAN as the court hardware, and
/// exposes it publicly through a Cloudflare tunnel. So the same deployment is
/// reached two ways: by hostname through the tunnel, and by bare IP from a device
/// in an electrical cupboard.
/// </para>
///
/// <para>
/// The original implementation took everything before the first dot, which turns
/// <c>192.168.68.10</c> into the slug <c>192</c> — resolving to no tenant, and
/// producing a 404 for an anonymous caller or a 403 tenant_mismatch for one with a
/// valid token. The tunnel path carries a real hostname and is unaffected, so the
/// failure is invisible everywhere except the LAN, which is precisely where the
/// devices are.
/// </para>
/// </summary>
public class TenantHostResolutionTests
{
    [Theory]
    // IPv4 literals — the on-prem LAN case that motivated this.
    [InlineData("192.168.68.10")]
    [InlineData("192.168.68.150")]
    [InlineData("10.0.0.1")]
    [InlineData("127.0.0.1")]
    // With a port, as a device would send it.
    [InlineData("192.168.68.10:8088")]
    [InlineData("127.0.0.1:5000")]
    // IPv6, bracketed per RFC 3986.
    [InlineData("[::1]")]
    [InlineData("[::1]:8088")]
    [InlineData("[fe80::1]")]
    // Hosts that carry no tenant.
    [InlineData("localhost")]
    [InlineData("localhost:5238")]
    [InlineData("")]
    [InlineData("www.example.com")]
    [InlineData("admin.example.com")]
    public void Hosts_without_a_tenant_resolve_to_null(string host)
    {
        Assert.Null(TenantResolutionMiddleware.ExtractHostSubdomain(host));
    }

    [Theory]
    [InlineData("crusaders.example.com", "crusaders")]
    [InlineData("crusaders.example.com:8088", "crusaders")]
    [InlineData("another-club.mainframe.co.za", "another-club")]
    // A two-label host resolves its first label too, which is what makes a
    // per-tenant custom domain work: crusaders.co.za -> "crusaders".
    [InlineData("crusaders.co.za", "crusaders")]
    [InlineData("example.com", "example")]
    public void Subdomain_hosts_resolve_to_their_slug(string host, string expected)
    {
        Assert.Equal(expected, TenantResolutionMiddleware.ExtractHostSubdomain(host));
    }

    /// <summary>
    /// The specific regression: this returned "192" and broke every LAN call.
    /// </summary>
    [Fact]
    public void A_lan_ip_is_never_mistaken_for_a_tenant_slug()
    {
        var result = TenantResolutionMiddleware.ExtractHostSubdomain("192.168.68.150");

        Assert.NotEqual("192", result);
        Assert.Null(result);
    }
}
