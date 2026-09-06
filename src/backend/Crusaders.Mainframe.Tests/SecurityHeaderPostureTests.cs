using System.Text.RegularExpressions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The framing refusal, read where it is actually served: the two shipped nginx configs and the
/// API's own responses.
/// </summary>
/// <remarks>
/// <para>
/// A headed pass over the production build behind the real gateway config loaded the signed-in
/// app inside an <c>&lt;iframe&gt;</c> from a different origin and got all of it — header, live
/// booking grid, the member's balance chip. No <c>X-Frame-Options</c>, no CSP
/// <c>frame-ancestors</c>, no <c>nosniff</c>, no <c>Referrer-Policy</c>, on either hop. Overlaying
/// that frame with a transparent decoy is a member pressing <i>Book for 50.00 cr</i> or
/// <i>Confirm cancellation</i>, and an admin pressing <i>Adjust credit</i>, <i>Suspend member</i>
/// or <i>Regenerate key</i> — one click each.
/// </para>
/// <para>
/// These tests read the shipped files rather than a copy, for the reason
/// <see cref="DeploymentPostureTests"/> gives: a copy is a second thing to keep in step, and the
/// point is to assert on what is baked into the image. The API half boots the real
/// <c>Program</c> over HTTP, because a header set by a middleware that is registered in the wrong
/// place is a header that does not exist.
/// </para>
/// <para>
/// The nginx assertion is structural, not a substring count, because of the trap that made this
/// worth a test at all: nginx does not merge <c>add_header</c> across levels. One
/// <c>add_header</c> inside a location silently discards every inherited one — so a file can
/// carry a perfect server-level block and still serve the document bare.
/// </para>
/// <para>
/// <b>And the presence assertion is scoped to the server level, which it was not.</b> It used to
/// regex the whole file, so the four <c>add_header</c> lines repeated inside
/// <c>location = /sw.js</c> satisfied it on their own: deleting the server-level block from
/// <c>src/frontend/nginx.conf</c> left <c>location /</c> — the block that serves the signed-in
/// document, on the hop that decides whether it can be framed — completely bare, and all eight
/// tests stayed green. Demonstrated by running that mutant. Together the two theories are
/// complete: the server level carries all four, and any location that sets one of its own
/// repeats all four, so every block either inherits a full set or declares one.
/// </para>
/// </remarks>
public sealed class SecurityHeaderPostureTests : IClassFixture<TestWebAppFactory>
{
    private readonly TestWebAppFactory _factory;

    public SecurityHeaderPostureTests(TestWebAppFactory factory) => _factory = factory;

    /// <summary>Header name to the value every hop must send.</summary>
    private static readonly (string Name, string Value)[] Required =
    [
        ("X-Frame-Options", "DENY"),
        ("X-Content-Type-Options", "nosniff"),
        ("Content-Security-Policy", "frame-ancestors 'none'"),
        ("Referrer-Policy", "no-referrer"),
    ];

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
        throw new DirectoryNotFoundException(
            "The repository root was not found above the test binary. These tests read the shipped "
            + "gateway and SPA nginx configs; a copy would be a second thing to keep in step.");
    }

    /// <summary>The file with comment lines removed — a comment naming a header must not satisfy an assertion about it.</summary>
    private static string Directives(string relativePath)
    {
        var text = File.ReadAllText(Path.Combine(RepoRoot(), Path.Combine([.. relativePath.Split('/')])));
        return string.Join('\n', text.Split('\n').Where(line => !line.TrimStart().StartsWith('#')));
    }

    [Theory]
    [InlineData("nginx/nginx.conf")]
    [InlineData("src/frontend/nginx.conf")]
    public void Every_shipped_nginx_config_sends_the_four_headers_at_server_level(string relativePath)
    {
        // Server level only. A copy inside some location block is not a substitute: nginx
        // inherits add_header downwards, so this is the set every bare location gets, and it is
        // the only set the block serving the document has.
        var directives = ServerLevel(Directives(relativePath));

        foreach (var (name, value) in Required)
        {
            var match = Regex.Match(directives, $@"add_header\s+{Regex.Escape(name)}\s+""(?<value>[^""]*)""\s+always\s*;");
            Assert.True(
                match.Success,
                $"{relativePath} does not send {name} at SERVER level, or sends it without `always` "
                + "(which drops it from every 4xx and 5xx). A copy inside a location block does not "
                + "count: nginx inherits downwards, so a location that sets no add_header of its own — "
                + "`location /`, which serves the document — gets exactly this set and nothing else. "
                + "Without these four the signed-in app can be framed by any origin.");
            Assert.Contains(value, match.Groups["value"].Value, StringComparison.Ordinal);
        }
    }

    [Theory]
    [InlineData("nginx/nginx.conf")]
    [InlineData("src/frontend/nginx.conf")]
    public void No_location_block_silently_drops_the_inherited_headers(string relativePath)
    {
        foreach (var (header, body) in LocationBlocks(Directives(relativePath)))
        {
            if (!body.Contains("add_header", StringComparison.Ordinal)) continue;

            foreach (var (name, _) in Required)
            {
                Assert.True(
                    Regex.IsMatch(body, $@"add_header\s+{Regex.Escape(name)}\s"),
                    $"{relativePath}: `{header}` sets an add_header of its own and therefore inherits "
                    + $"NONE of the server-level ones, but does not repeat {name}. nginx replaces the whole "
                    + "set rather than merging it, so this block serves its responses bare.");
            }
        }
    }

    /// <summary>
    /// The directives outside every <c>location</c> block — the server level, which is what a
    /// location that declares no <c>add_header</c> of its own inherits.
    /// </summary>
    private static string ServerLevel(string directives)
    {
        var kept = new System.Text.StringBuilder();
        var from = 0;
        foreach (Match start in Regex.Matches(directives, @"^\s*location[^\{]*\{", RegexOptions.Multiline))
        {
            // A nested location is already inside a span this loop has consumed.
            if (start.Index < from) continue;

            kept.Append(directives[from..start.Index]);
            var depth = 1;
            var i = start.Index + start.Length;
            while (i < directives.Length && depth > 0)
            {
                if (directives[i] == '{') depth++;
                else if (directives[i] == '}') depth--;
                i++;
            }
            from = i;
        }
        kept.Append(directives[from..]);
        return kept.ToString();
    }

    /// <summary>Brace-matched <c>location …{ }</c> blocks: (the location line, the block body).</summary>
    private static IEnumerable<(string Header, string Body)> LocationBlocks(string directives)
    {
        foreach (Match start in Regex.Matches(directives, @"^\s*(location[^\{]*)\{", RegexOptions.Multiline))
        {
            var depth = 1;
            var i = start.Index + start.Length;
            var from = i;
            while (i < directives.Length && depth > 0)
            {
                if (directives[i] == '{') depth++;
                else if (directives[i] == '}') depth--;
                i++;
            }
            yield return (start.Groups[1].Value.Trim(), directives[from..(i - 1)]);
        }
    }

    /// <summary>The service worker is the one file in the build that must never be long-cached.</summary>
    [Fact]
    public void The_service_worker_is_not_served_with_a_year_long_cache()
    {
        var directives = Directives("src/frontend/nginx.conf");

        Assert.Matches(@"location\s*=\s*/sw\.js\s*\{", directives);

        var block = LocationBlocks(directives).Single(b => b.Header.Contains("/sw.js", StringComparison.Ordinal));
        Assert.Contains("no-cache", block.Body, StringComparison.Ordinal);
        Assert.DoesNotContain("expires", block.Body, StringComparison.OrdinalIgnoreCase);

        // And the asset block that used to swallow it must not emit Cache-Control twice: `expires`
        // and an `add_header Cache-Control` together sent two different values for one header.
        var assets = LocationBlocks(directives).Single(b => b.Header.Contains("woff2", StringComparison.Ordinal));
        Assert.DoesNotContain("expires", assets.Body, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("immutable", assets.Body, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("/healthz")]
    [InlineData("/api/v1/whoami")]
    public async Task The_api_sends_the_four_headers_on_its_own_responses(string path)
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync(path);

        foreach (var (name, value) in Required)
        {
            Assert.True(
                response.Headers.TryGetValues(name, out var values),
                $"{path} came back without {name}. Kestrel is reachable directly in the on-prem overlay, "
                + "so the gateway's copy is not the only one that matters.");
            Assert.Contains(value, string.Join(", ", values!), StringComparison.Ordinal);
        }

        // Deliberately no assertion about `Server` here: this factory runs on TestServer, not
        // Kestrel, so `AddServerHeader = false` in Program.cs is not exercised by it and an
        // assertion would pass without proving anything. It was checked against a real Kestrel
        // by hand instead.
    }

    /// <summary>
    /// The service worker's <c>mayCache()</c> refuses anything carrying <c>no-store</c> or
    /// <c>Vary: Authorization</c>, as a second line of defence behind its <c>/api/</c> path check.
    /// The API supplied neither, so that defence rested on the path check alone.
    /// </summary>
    [Fact]
    public async Task Api_responses_are_marked_unstorable()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/v1/whoami");

        Assert.Contains("no-store", response.Headers.CacheControl?.ToString() ?? "", StringComparison.Ordinal);
        Assert.Contains("Authorization", string.Join(", ", response.Headers.Vary), StringComparison.OrdinalIgnoreCase);
    }
}
