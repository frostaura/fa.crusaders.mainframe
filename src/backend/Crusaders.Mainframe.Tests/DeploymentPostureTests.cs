using System.Net;
using System.Text;
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
[Collection(HttpTestCollection.Name)]
public sealed class DeploymentPostureTests
{
    private readonly PostgresFixture _pg;

    public DeploymentPostureTests(PostgresFixture pg) => _pg = pg;

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

    // ---- E1: what a CLUB'S deployment says when it cannot read the request ---------------
    //
    // The hostile reviewer drove malformed input at the review stack and got a ProblemDetails
    // carrying a full stack trace: type names, assembly names, and absolute source paths on
    // the machine that built the image. That stack runs in Development, which adds the
    // developer exception page, so the finding is about the STACK and not about the product —
    // and "it is only Development" is exactly the sentence nobody may say without having run
    // Production and looked. These four boot the real Program under Production and look.
    //
    // They are here, beside the compose assertions, because they are the same claim from the
    // other end: those pin that no shipped file selects Development, and these pin what the
    // environment those files DO select actually answers.

    /// <summary>Strings a 400 may never contain, whatever went wrong.</summary>
    private static readonly string[] Leaks =
    [
        "Exception", "exception", "StackTrace", "stackTrace", "at Crusaders", "Crusaders.Mainframe",
        "Microsoft.AspNetCore", "System.", ".cs:line", "/src/", "\\src\\", "Npgsql",
    ];

    private static void AssertOpaque(HttpStatusCode status, string body)
    {
        Assert.Equal(HttpStatusCode.BadRequest, status);
        foreach (var leak in Leaks)
        {
            Assert.DoesNotContain(leak, body, StringComparison.Ordinal);
        }
    }

    /// <summary>A body that is not JSON is a 400 that says nothing about this server.</summary>
    [SkippableTheory]
    [InlineData("{")]
    [InlineData("{\"email\": }")]
    [InlineData("not json at all")]
    [InlineData("[1,2,3]")]
    public async Task A_malformed_body_is_an_opaque_400_in_Production(string body)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString, EnvironmentName = "Production" };
        var club = await DoorClub.SeedAsync(factory, "posture");

        var response = await factory.CreateClient().PostAsync(
            $"/api/v1/auth/login?tenant={club.Slug}", new StringContent(body, Encoding.UTF8, "application/json"));

        AssertOpaque(response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// A query parameter the route cannot bind — <c>?limit=abc</c> on a route that declares an
    /// <c>int?</c> — is the other half, and it is a different code path: the framework refuses
    /// before the handler runs.
    /// </summary>
    [SkippableFact]
    public async Task An_unbindable_query_parameter_is_an_opaque_400_in_Production()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString, EnvironmentName = "Production" };
        var club = await DoorClub.SeedAsync(factory, "posture");
        var doorId = await club.AddDoorAsync(factory, "gate-dp0001", "front-door");

        var response = await club.AdminClient(factory)
            .GetAsync($"/api/v1/admin/devices/{doorId}/activity?limit=abc");

        AssertOpaque(response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// And a date that is not a date, which E3 now refuses by name: the refusal is a NAMED
    /// error code and nothing else. A club's console can act on <c>from_invalid</c>; it can do
    /// nothing with a stack frame, and a stranger can do a great deal.
    /// </summary>
    [SkippableTheory]
    [InlineData("from=not-a-date", "from_invalid")]
    [InlineData("to=not-a-date", "to_invalid")]
    [InlineData("cursor=aGVsbG8=", "cursor_invalid")]
    [InlineData("outcome=banana", "outcome_invalid")]
    public async Task A_refused_door_log_filter_names_the_error_and_nothing_else(string query, string error)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString, EnvironmentName = "Production" };
        var club = await DoorClub.SeedAsync(factory, "posture");

        var response = await club.AdminClient(factory).GetAsync($"/api/v1/admin/doors/activity?{query}");
        var body = await response.Content.ReadAsStringAsync();

        AssertOpaque(response.StatusCode, body);
        Assert.Equal($"{{\"error\":\"{error}\"}}", body);
    }

    /// <summary>
    /// The doors area answers headers the console has to READ, and a browser hands a page only
    /// the safelisted ones unless the server names the rest. Pinned here rather than in a doors
    /// suite because it is a deployment fact: the policy is built once, at boot, from
    /// configuration, and a CORS regression is invisible to every same-origin test in the repo.
    /// </summary>
    [Fact]
    public void The_cors_policy_exposes_the_headers_the_console_reads()
    {
        var program = Read("src", "backend", "Crusaders.Mainframe.Api", "Program.cs");

        Assert.Contains("WithExposedHeaders", program, StringComparison.Ordinal);
        Assert.Contains("AdminDoorLogEndpoint.RowsHeader", program, StringComparison.Ordinal);
        Assert.Contains("AdminDoorLogEndpoint.TruncatedHeader", program, StringComparison.Ordinal);
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
