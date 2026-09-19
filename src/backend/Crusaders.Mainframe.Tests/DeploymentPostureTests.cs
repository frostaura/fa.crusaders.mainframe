using System.Text.RegularExpressions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The deployment files, read as what they are: shipped configuration.
/// </summary>
/// <remarks>
/// <para>
/// Nothing in CI looked at these. The Portainer deploy job checks that a stack names the gateway
/// image and does not bind-mount <c>nginx.conf</c>, and stops there — so the unqualified
/// <c>docker-compose.yml</c> defaulting to <c>Development</c> was invisible, and a stack created
/// from the wrong file gets redeployed happily forever. Development is not a milder setting here:
/// it turns on an anonymous endpoint that returns an admin JWT, force-resets the seeded admin's
/// password, and reaches the member list and the device API key that switches the club's lights.
/// </para>
/// <para>
/// These assertions are cheap and they are the only thing standing between "somebody ran the
/// obvious file" and that outcome.
/// </para>
/// </remarks>
public sealed class DeploymentPostureTests
{
    /// <summary>
    /// Walks up from the test binary to the repository root, the way the device-protocol corpus
    /// tests do. The compose files are deliberately not copied to the output directory: a copy
    /// is a second thing to keep in step, and these tests exist to read the shipped ones.
    /// </summary>
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
            "The repository root was not found above the test binary. These tests read the shipped " +
            "compose and gateway files; a copy would be a second thing to keep in step.");
    }

    private static string Read(params string[] parts) => File.ReadAllText(Path.Combine(RepoRoot(), Path.Combine(parts)));

    [Theory]
    [InlineData("docker-compose.yml")]
    [InlineData("docker-compose.prod.yml")]
    [InlineData("docker-compose.onprem.yml")]
    public void No_shipped_compose_file_defaults_the_api_to_Development(string file)
    {
        var path = Path.Combine(RepoRoot(), file);
        Skip.IfNot(File.Exists(path), $"{file} is not present in this checkout");

        foreach (Match match in Regex.Matches(File.ReadAllText(path), @"ASPNETCORE_ENVIRONMENT:\s*(?<value>\S+)"))
        {
            var value = match.Groups["value"].Value;

            // Either pinned outright, or interpolated with a default that is not Development.
            // `${ASPNETCORE_ENVIRONMENT}` with no default at all is fine too: unset means
            // ASP.NET's own default, which is Production.
            var interpolated = Regex.Match(value, @"^\$\{[^:}]+(?::-(?<fallback>[^}]*))?\}$");
            var effective = interpolated.Success ? interpolated.Groups["fallback"].Value : value;

            Assert.False(
                string.Equals(effective, "Development", StringComparison.OrdinalIgnoreCase),
                $"{file} makes the API Development by default. Development exposes an anonymous " +
                "admin-token endpoint, seeds sample data into whatever database is configured, and " +
                "returns .NET stack traces. Set it explicitly in .env instead.");
        }
    }

    [Fact]
    public void The_gateway_does_not_proxy_a_path_the_backend_does_not_serve()
    {
        // Directives only. The comment explaining why the block is gone necessarily names it,
        // and an assertion that a file does not contain a word is worthless if its own
        // explanation trips it.
        var directives = string.Join(
            '\n',
            Read("nginx", "nginx.conf")
                .Split('\n')
                .Where(line => !line.TrimStart().StartsWith('#')));

        // There is no GraphQL anywhere in this product. The location block that used to be here
        // proxied to a backend path that answered 400 tenant_unresolved, and carried websocket
        // Upgrade headers, so it read as a live subscription transport somebody would be sent to
        // debug. It shipped, baked into the gateway image.
        Assert.DoesNotContain("graphql", directives, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// <b>The gateway must never answer <c>403</c> on the device surface, and nothing was
    /// stopping it.</b>
    ///
    /// <para>
    /// <c>DeviceForbiddenMeansOutOfServiceTests</c> pins that a <c>403</c> from the
    /// APPLICATION on <c>/api/v1/device/*</c> can mean one thing only — this board is out of
    /// service — because the firmware acts on that word: it denies the scan without consulting
    /// its roster, and on a heartbeat it commits an EMPTY roster. That pin is
    /// application-level, and the boards do not talk to the application. They talk to this
    /// file.
    /// </para>
    ///
    /// <para>
    /// So an <c>nginx</c> rule that answered <c>403</c> for any reason at all — an IP
    /// allow-list, a rate limiter configured to forbid rather than to 429, a WAF snippet
    /// pasted in during an incident — would take <b>every door in the club out of service</b>,
    /// and keep them there until each board's next ACCEPTED heartbeat. No code change, no
    /// deploy of the API, nothing red. There is no such rule today and this is what says so.
    /// </para>
    ///
    /// <para>
    /// Directives only, like the check above, so the comment that has to name the thing being
    /// forbidden cannot trip its own assertion — and matched as DIRECTIVES rather than as
    /// substrings, because <c>add_header X-Frame-Options "DENY"</c> is a security header this
    /// file should keep and contains the word.
    /// </para>
    /// </summary>
    [Fact]
    public void The_gateway_never_answers_forbidden_itself()
    {
        var directives = string.Join(
            '\n',
            Read("nginx", "nginx.conf")
                .Split('\n')
                .Where(line => !line.TrimStart().StartsWith('#')));

        // `deny` as the directive that begins a line, and `return 403` anywhere. Those are
        // the two ways this file can answer Forbidden on its own.
        Assert.DoesNotMatch(new Regex(@"(?m)^\s*deny\s", RegexOptions.IgnoreCase), directives);
        Assert.DoesNotMatch(new Regex(@"return\s+403\b"), directives);

        // The control: the file really is the gateway the boards reach, so the absence above
        // is about something rather than about an empty file.
        Assert.Contains("proxy_pass", directives, StringComparison.Ordinal);
    }

    [Fact]
    public void The_backend_really_has_no_graphql_endpoint()
    {
        // The control for the assertion above: it is only correct to delete the proxy while this
        // stays true. If GraphQL is ever added, this fails first and says so.
        var api = Path.Combine(RepoRoot(), "src", "backend", "Crusaders.Mainframe.Api");
        var hits = Directory.EnumerateFiles(api, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                     && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"))
            .Where(f => File.ReadAllText(f).Contains("graphql", StringComparison.OrdinalIgnoreCase))
            .ToList();

        Assert.Empty(hits);
    }
}
