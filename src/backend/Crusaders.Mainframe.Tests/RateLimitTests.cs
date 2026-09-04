using System.Net;
using System.Net.Http.Json;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The application had no rate limiting of any kind. These tests fix the shape of what
/// was added: that a limiter exists, that it is per-policy rather than one global
/// number, that it refuses with 429 and a Retry-After rather than a connection reset,
/// and — the part most easily got wrong — that it runs <b>before</b> authentication,
/// so an unauthenticated flood is cheap to refuse.
///
/// <para>
/// No database, so these run everywhere rather than only where Postgres is available:
/// a limiter that only gates in the integration job is a limiter nobody notices
/// breaking. They still join the HTTP collection, because the ceilings reach the app
/// through process environment variables — two of these running concurrently would
/// overwrite each other's limits.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class RateLimitTests
{
    private readonly PostgresFixture _pg;

    public RateLimitTests(PostgresFixture pg) => _pg = pg;

    /// <summary>
    /// Under the auth policy and free of the database, which is what makes these tests
    /// runnable without Postgres. Login would have been the obvious choice and is not:
    /// it reads the user table, so a database-free host throws inside the handler and
    /// the failure says nothing about the limiter.
    /// </summary>
    private const string AuthPolicyPath = "/api/v1/me/qr/generate";

    /// <summary>
    /// The auth policy at its floor. Login is a password oracle: without a ceiling it
    /// answers as fast as the box can hash, which for a four-digit PIN or a weak
    /// password is measured in minutes rather than centuries.
    /// </summary>
    [Fact]
    public async Task The_auth_policy_refuses_past_its_ceiling()
    {
        await using var factory = new TestWebAppFactory
        {
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 3 },
        };
        var client = factory.CreateClient();

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 8; i++)
        {
            var response = await client.PostAsync(AuthPolicyPath, content: null);
            statuses.Add(response.StatusCode);
        }

        Assert.Contains(HttpStatusCode.TooManyRequests, statuses);

        // The first few must have been let through, or the test proves only that
        // everything is blocked.
        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, statuses.Take(3));
    }

    /// <summary>
    /// A refusal must be a well-formed HTTP answer a client can act on: 429, a
    /// Retry-After, and a JSON body in the same shape as every other error here.
    /// </summary>
    [Fact]
    public async Task A_refusal_carries_retry_after_and_a_structured_body()
    {
        await using var factory = new TestWebAppFactory
        {
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 1 },
        };
        var client = factory.CreateClient();

        HttpResponseMessage? refused = null;
        for (var i = 0; i < 6 && refused is null; i++)
        {
            var response = await client.PostAsync(AuthPolicyPath, content: null);
            if (response.StatusCode == HttpStatusCode.TooManyRequests) refused = response;
        }

        Assert.NotNull(refused);
        Assert.Equal("60", refused.Headers.RetryAfter?.ToString());

        var body = await refused.Content.ReadAsStringAsync();
        Assert.Contains("rate_limited", body);
    }

    /// <summary>
    /// An unauthenticated flood is refused cheaply: no database read, and no token
    /// validation for a request that carries no token. Authentication runs ahead of the
    /// limiter now (so the auth policy can partition by member), but authentication does
    /// not challenge — authorization does, later — so a flood with no credentials still
    /// reaches the limiter and is 429, never 401 forever.
    /// </summary>
    [Fact]
    public async Task Limiting_refuses_an_unauthenticated_flood()
    {
        await using var factory = new TestWebAppFactory
        {
            RateLimits = new Dictionary<string, int> { ["GlobalPerMinute"] = 3 },
        };
        var client = factory.CreateClient();

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 8; i++)
        {
            statuses.Add((await client.PostAsync("/api/v1/me/qr/generate", content: null)).StatusCode);
        }

        Assert.Contains(HttpStatusCode.TooManyRequests, statuses);
    }

    /// <summary>
    /// The policies must be independent. A club whose members are hammering login
    /// must not knock its own court boxes offline — which is exactly what one shared
    /// global number would do.
    /// </summary>
    [Fact]
    public async Task Exhausting_the_auth_policy_does_not_close_the_health_probe()
    {
        await using var factory = new TestWebAppFactory
        {
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 1 },
        };
        var client = factory.CreateClient();

        for (var i = 0; i < 6; i++)
        {
            await client.PostAsync(AuthPolicyPath, content: null);
        }

        // Liveness must survive. A probe that fails under load gets the container killed
        // mid-incident, which is the opposite of what a limiter is for.
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/healthz")).StatusCode);
    }

    // ---- behind the gateway (closing re-review #7) ------------------------------------

    /// <summary>
    /// Every deployment fronts the API with nginx, so Kestrel sees the gateway's address
    /// as the peer of every browser request. Partitioned on that, the whole club shared
    /// one ten-a-minute auth bucket — ten Court Code refreshes on league night and login,
    /// PIN and provisioning were dead club-wide for the rest of the minute. The client
    /// address is now read from X-Forwarded-For when the request came from a trusted
    /// proxy: distinct forwarded clients are distinct partitions.
    /// </summary>
    [Fact]
    public async Task Distinct_clients_behind_the_trusted_gateway_get_distinct_partitions()
    {
        await using var factory = new TestWebAppFactory
        {
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 1 },
            RemoteIpAddress = System.Net.IPAddress.Loopback,   // the gateway, per the default trusted list
        };
        var client = factory.CreateClient();

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 6; i++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, AuthPolicyPath);
            request.Headers.Add("X-Forwarded-For", $"192.168.68.{100 + i}");
            statuses.Add((await client.SendAsync(request)).StatusCode);
        }

        // Six members, one call each: nobody is limited.
        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, statuses);

        // The same member twice: limited on the second, and nobody else with them.
        using var again = new HttpRequestMessage(HttpMethod.Post, AuthPolicyPath);
        again.Headers.Add("X-Forwarded-For", "192.168.68.100");
        Assert.Equal(HttpStatusCode.TooManyRequests, (await client.SendAsync(again)).StatusCode);

        using var other = new HttpRequestMessage(HttpMethod.Post, AuthPolicyPath);
        other.Headers.Add("X-Forwarded-For", "192.168.68.200");
        Assert.NotEqual(HttpStatusCode.TooManyRequests, (await client.SendAsync(other)).StatusCode);
    }

    /// <summary>
    /// The header is believed only from a trusted proxy. A stranger forging
    /// X-Forwarded-For from an untrusted address stays in the one partition their real
    /// address puts them in — otherwise the header is a free pass out of the limit.
    /// </summary>
    [Fact]
    public async Task A_forwarded_header_from_an_untrusted_address_is_ignored()
    {
        await using var factory = new TestWebAppFactory
        {
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 2 },
            RemoteIpAddress = System.Net.IPAddress.Parse("203.0.113.9"),
        };
        var client = factory.CreateClient();

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 6; i++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, AuthPolicyPath);
            request.Headers.Add("X-Forwarded-For", $"10.0.0.{i}");
            statuses.Add((await client.SendAsync(request)).StatusCode);
        }

        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, statuses.Take(2));
        Assert.Contains(HttpStatusCode.TooManyRequests, statuses.Skip(2));
    }

    /// <summary>
    /// "Ten a minute per member" means per member: an authenticated call is partitioned on
    /// the member, so two members behind one address — a shared clubhouse tablet, or the
    /// gateway when no forwarded header reaches us — do not spend each other's allowance.
    /// </summary>
    [SkippableFact]
    public async Task Authenticated_calls_are_partitioned_by_member()
    {
        // The one test here that needs Postgres: an authenticated request resolves its
        // tenant from the database before authorization, so a database-free host throws
        // inside the pipeline and the status says nothing about the limiter.
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory
        {
            ConnectionString = _pg.ConnectionString,
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 1 },
        };
        var client = factory.CreateClient();

        // The courtside QR match is under the auth policy and admin-only: an ordinary
        // member's token is authenticated (so the limiter partitions on them) and then
        // refused by authorization, after the limiter.
        const string adminOnlyAuthPath = "/api/v1/court/1/qr/match";

        var statuses = new List<HttpStatusCode>();
        foreach (var member in Enumerable.Range(0, 4).Select(_ => Guid.NewGuid()))
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, adminOnlyAuthPath) { Content = JsonContent.Create(new { token = "x" }) };
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", MemberToken(member));
            statuses.Add((await client.SendAsync(request)).StatusCode);
        }
        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, statuses);

        var same = Guid.NewGuid();
        HttpStatusCode? second = null;
        for (var i = 0; i < 2; i++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, adminOnlyAuthPath) { Content = JsonContent.Create(new { token = "x" }) };
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", MemberToken(same));
            second = (await client.SendAsync(request)).StatusCode;
        }
        Assert.Equal(HttpStatusCode.TooManyRequests, second);
    }

    /// <summary>An access token for a member, signed with the factory's test secret.</summary>
    private static string MemberToken(Guid subject)
    {
        var token = new System.IdentityModel.Tokens.Jwt.JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims:
            [
                new System.Security.Claims.Claim(System.IdentityModel.Tokens.Jwt.JwtRegisteredClaimNames.Sub, subject.ToString()),
                new System.Security.Claims.Claim("tenant_id", Guid.NewGuid().ToString()),
                new System.Security.Claims.Claim("tenant_slug", "crusaders"),
                new System.Security.Claims.Claim("purpose", "access"),
            ],
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new Microsoft.IdentityModel.Tokens.SigningCredentials(
                new Microsoft.IdentityModel.Tokens.SymmetricSecurityKey(
                    System.Text.Encoding.UTF8.GetBytes("test-only-signing-key-not-used-in-any-real-environment")),
                Microsoft.IdentityModel.Tokens.SecurityAlgorithms.HmacSha256));
        return new System.IdentityModel.Tokens.Jwt.JwtSecurityTokenHandler().WriteToken(token);
    }

    /// <summary>The generous default must not fire during ordinary use.</summary>
    [Fact]
    public async Task Ordinary_traffic_is_not_limited()
    {
        await using var factory = new TestWebAppFactory();
        var client = factory.CreateClient();

        for (var i = 0; i < 30; i++)
        {
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/healthz")).StatusCode);
        }
    }
}
