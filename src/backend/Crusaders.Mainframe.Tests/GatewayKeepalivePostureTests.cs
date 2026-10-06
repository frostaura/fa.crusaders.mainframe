using System.Text.RegularExpressions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 18, scalability lane (BE18s): the gateway reuses its connections to the backend.
///
/// <para>
/// Without it every proxied request opened a fresh TCP connection and parked its port in TIME_WAIT
/// for 60 s. One court box flooding <c>/device/events</c> spent the container's ~28,000 ports in
/// seconds — <c>connect() failed (99: Address not available)</c> — and every member request was a
/// 502 until the flood stopped (live: 89,991 502s in eight minutes, members' logins among them).
/// Measured in isolation through the shipped image: before, 2.95 M 502s in a 90 s flood and member
/// reads 151 of 169 failed; after, 0 502s, the flood answered 429 by the API, member reads 153/153.
/// </para>
///
/// <para>
/// Read where it ships, like the compression and header postures: the baked gateway config. A
/// keepalive pool works only when all three parts are present, so each is pinned per location.
/// </para>
/// </summary>
public sealed class GatewayKeepalivePostureTests
{
    private static string Directives()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "nginx", "nginx.conf")))
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        var text = File.ReadAllText(Path.Combine(dir!.FullName, "nginx", "nginx.conf"));
        var directives = string.Join('\n', text.Split('\n').Where(line => !line.TrimStart().StartsWith('#')));

        // The image's envsubst placeholders carry braces of their own; a block is read up to ITS brace.
        return Regex.Replace(directives, @"\$\{\w+\}", "ENV");
    }

    [Fact]
    public void Every_upstream_keeps_a_pool_of_open_connections()
    {
        var upstreams = Regex.Matches(Directives(), @"upstream\s+(?<name>\w+)\s*\{(?<body>[^}]*)\}");

        Assert.Contains(upstreams, u => u.Groups["name"].Value == "backend_api");
        Assert.All(upstreams, u => Assert.Matches(new Regex(@"(?m)^\s*keepalive\s+\d+\s*;"), u.Groups["body"].Value));
    }

    [Fact]
    public void Every_proxied_location_goes_through_a_pooled_upstream_over_http11_without_connection_close()
    {
        var directives = Directives();
        var upstreams = Regex.Matches(directives, @"upstream\s+(?<name>\w+)\s*\{").Select(m => m.Groups["name"].Value).ToHashSet();
        var locations = Regex.Matches(directives, @"location\s+(?<path>[^{]+)\{(?<body>[^}]*)\}")
            .Where(l => l.Groups["body"].Value.Contains("proxy_pass", StringComparison.Ordinal))
            .ToList();

        Assert.NotEmpty(locations);
        foreach (var location in locations)
        {
            var path = location.Groups["path"].Value.Trim();
            var body = location.Groups["body"].Value;
            var target = Regex.Match(body, @"proxy_pass\s+http://(?<host>[^/;:\s]+)");
            Assert.True(upstreams.Contains(target.Groups["host"].Value), $"location {path} proxies past the keepalive pool");
            Assert.True(Regex.IsMatch(body, @"proxy_http_version\s+1\.1\s*;"), $"location {path} speaks HTTP/1.0 upstream");
            Assert.True(Regex.IsMatch(body, @"proxy_set_header\s+Connection\s+""""\s*;"), $"location {path} still sends Connection: close");
        }
    }
}
