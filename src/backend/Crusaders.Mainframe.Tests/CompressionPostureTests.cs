using System.Text.RegularExpressions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Perf round (2026-09-30), backend item 5: nothing on either nginx hop compressed — the 801 KB
/// entry chunk and a 275 KB ledger page went out raw. Read where it is served: the two shipped
/// configs. The one thing compression must never touch is the SSE stream, which stops streaming
/// the moment a gzip buffer holds it back.
/// </summary>
public sealed class CompressionPostureTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "docker-compose.yml"))
                && Directory.Exists(Path.Combine(dir.FullName, "nginx")))
            {
                return dir.FullName;
            }
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException("The repository root was not found above the test binary.");
    }

    /// <summary>Directives only: a comment naming a type must not satisfy (or trip) an assertion about it.</summary>
    private static string Directives(string relativePath)
    {
        var text = File.ReadAllText(Path.Combine(RepoRoot(), Path.Combine([.. relativePath.Split('/')])));
        return string.Join('\n', text.Split('\n').Where(line => !line.TrimStart().StartsWith('#')));
    }

    private static string[] GzipTypes(string directives)
    {
        var match = Regex.Match(directives, @"gzip_types\s+(?<types>[^;]*);");
        Assert.True(match.Success, "no gzip_types directive");
        return match.Groups["types"].Value.Split((char[])[' ', '\n', '\r', '\t'], StringSplitOptions.RemoveEmptyEntries);
    }

    [Theory]
    [InlineData("nginx/nginx.conf", "application/json")]
    [InlineData("src/frontend/nginx.conf", "application/javascript")]
    public void Every_shipped_nginx_config_compresses_text_but_never_the_event_stream(string relativePath, string mustCompress)
    {
        var directives = Directives(relativePath);

        Assert.Matches(new Regex(@"(?m)^\s*gzip\s+on\s*;"), directives);
        Assert.Matches(new Regex(@"(?m)^\s*gzip_proxied\s+any\s*;"), directives);
        var types = GzipTypes(directives);
        Assert.Contains(mustCompress, types);
        Assert.Contains("text/css", types);
        Assert.Contains("image/svg+xml", types);

        // A compressed SSE stream is a stream that has stopped: the wallet, the control board and
        // the monitoring feed would each arrive in lumps, or not until the connection closed.
        Assert.DoesNotContain("text/event-stream", types);
        Assert.DoesNotContain("*", types);
    }

    /// <summary>
    /// The sign-in responses carry the access token beside an address the caller typed — the
    /// BREACH shape — and are a few hundred bytes, so the gateway serves them uncompressed.
    /// </summary>
    [Fact]
    public void The_gateway_does_not_compress_the_sign_in_responses()
    {
        var directives = Directives("nginx/nginx.conf");
        var block = Regex.Match(directives, @"location\s+/api/v1/auth/\s*\{(?<body>[^}]*)\}");

        Assert.True(block.Success, "no /api/v1/auth/ location in the gateway");
        Assert.Matches(new Regex(@"gzip\s+off\s*;"), block.Groups["body"].Value);
        Assert.Contains("proxy_pass", block.Groups["body"].Value, StringComparison.Ordinal);
    }
}
