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
public sealed class RateLimitTests : IClassFixture<PostgresFixture>
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

    // ---- two hops: cloudflared in front of the gateway (round-3 finding 4) ----------------

    /// <summary>
    /// The documented internet path is Cloudflare → cloudflared on the club's own host →
    /// the published gateway port, so a remote member's request reaches nginx already
    /// carrying <c>X-Forwarded-For: &lt;visitor&gt;</c> and leaves it as
    /// <c>&lt;visitor&gt;, &lt;cloudflared&gt;</c>. At <c>ForwardLimit = 1</c> the API
    /// stopped at cloudflared's address, so the whole remote membership shared one
    /// ten-a-minute auth bucket and any one outsider could lock every remote member out of
    /// login with ten POSTs. Two entries, two partitions.
    /// </summary>
    [Fact]
    public async Task Two_forwarded_hops_through_cloudflared_are_distinct_partitions()
    {
        await using var factory = new TestWebAppFactory
        {
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 1 },
            // The gateway. Its own peer — cloudflared, the first XFF entry from the right —
            // is loopback too, which is what lets the second hop be walked back.
            RemoteIpAddress = System.Net.IPAddress.Loopback,
            TrustedProxies = "127.0.0.1,::1",
        };
        var client = factory.CreateClient();

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 5; i++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, AuthPolicyPath);
            request.Headers.Add("X-Forwarded-For", $"203.0.113.{10 + i}, 127.0.0.1");
            statuses.Add((await client.SendAsync(request)).StatusCode);
        }

        // Five remote members, one call each. Under the old single-hop default all five
        // resolved to 127.0.0.1 and four of them were 429.
        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, statuses);

        // And the partition really is the visitor, not the tunnel: the same visitor twice
        // is limited, a different one is not.
        using var again = new HttpRequestMessage(HttpMethod.Post, AuthPolicyPath);
        again.Headers.Add("X-Forwarded-For", "203.0.113.10, 127.0.0.1");
        Assert.Equal(HttpStatusCode.TooManyRequests, (await client.SendAsync(again)).StatusCode);

        using var other = new HttpRequestMessage(HttpMethod.Post, AuthPolicyPath);
        other.Headers.Add("X-Forwarded-For", "203.0.113.99, 127.0.0.1");
        Assert.NotEqual(HttpStatusCode.TooManyRequests, (await client.SendAsync(other)).StatusCode);
    }

    /// <summary>
    /// Raising the limit to two hops is only safe because trust is re-checked at every hop.
    /// A LAN client reaching the gateway directly is nginx's own peer, so the first entry
    /// the middleware consumes is that client's real address — untrusted — and the forged
    /// entry in front of it is never taken. Without this the two-hop fix would have been a
    /// free pass out of the limiter for anyone on the club LAN.
    /// </summary>
    [Fact]
    public async Task A_second_hop_is_not_walked_back_past_an_untrusted_address()
    {
        await using var factory = new TestWebAppFactory
        {
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 2 },
            RemoteIpAddress = System.Net.IPAddress.Loopback,   // the gateway
            TrustedProxies = "127.0.0.1,::1",
        };
        var client = factory.CreateClient();

        // "<forged>, <the LAN client nginx actually saw>". The second entry is consumed
        // (the gateway is trusted); the first is not (192.168.68.50 is not).
        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 6; i++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, AuthPolicyPath);
            request.Headers.Add("X-Forwarded-For", $"198.51.100.{i}, 192.168.68.50");
            statuses.Add((await client.SendAsync(request)).StatusCode);
        }

        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, statuses.Take(2));
        Assert.Contains(HttpStatusCode.TooManyRequests, statuses.Skip(2));
    }

    // ---- the trusted range itself (round-3 finding 15) -----------------------------------

    /// <summary>
    /// The trusted default used to be <c>172.16.0.0/12</c> — a million addresses — and the
    /// on-prem overlay put Kestrel on every host interface at <c>:5000</c>. On a club whose
    /// LAN sits in that range, any laptop could POST straight to the API with a rotating
    /// <c>X-Forwarded-For</c> and guess passwords past every limit. The default is now the
    /// pinned compose bridge, so a peer inside the old /12 is a stranger like any other and
    /// its forged header is disbelieved.
    /// </summary>
    [Fact]
    public async Task A_peer_inside_the_old_slash_twelve_cannot_forge_a_client_address()
    {
        await using var factory = new TestWebAppFactory
        {
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 2 },
            // Squarely inside 172.16.0.0/12 and squarely outside 172.29.83.0/24.
            RemoteIpAddress = System.Net.IPAddress.Parse("172.16.40.7"),
        };
        var client = factory.CreateClient();

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 6; i++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, AuthPolicyPath);
            request.Headers.Add("X-Forwarded-For", $"10.9.9.{i}");
            statuses.Add((await client.SendAsync(request)).StatusCode);
        }

        // All six shared one partition — the forger's own address — so the ceiling bit.
        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, statuses.Take(2));
        Assert.Contains(HttpStatusCode.TooManyRequests, statuses.Skip(2));
    }

    /// <summary>
    /// And the gateway inside the pinned bridge still is believed — the control for the
    /// test above, so a green result there cannot mean "nothing is trusted at all".
    /// </summary>
    [Fact]
    public async Task The_pinned_compose_bridge_is_still_trusted()
    {
        await using var factory = new TestWebAppFactory
        {
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 1 },
            RemoteIpAddress = System.Net.IPAddress.Parse("172.29.83.2"),
        };
        var client = factory.CreateClient();

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 5; i++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, AuthPolicyPath);
            request.Headers.Add("X-Forwarded-For", $"192.168.68.{100 + i}");
            statuses.Add((await client.SendAsync(request)).StatusCode);
        }

        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, statuses);
    }

    /// <summary>
    /// A deployment must be able to NARROW the trusted set, not only add to it.
    ///
    /// <para>
    /// This is the dropped lead that turned out to be real: the default lived in
    /// <c>appsettings.json</c> as a three-entry JSON array, and .NET configuration merges
    /// arrays BY INDEX — so a club setting <c>Gateway__TrustedProxies__0</c> to its own load
    /// balancer replaced entry 0 and went on trusting <c>::1</c> and <c>172.16.0.0/12</c>
    /// underneath. The default is a delimited string now, which an environment variable
    /// replaces whole. Pinned by taking the compose bridge OUT and proving it is gone.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Configuration_can_narrow_the_trusted_default_rather_than_only_extend_it()
    {
        await using var factory = new TestWebAppFactory
        {
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 2 },
            // The address the shipped default trusts …
            RemoteIpAddress = System.Net.IPAddress.Parse("172.29.83.2"),
            // … and a deployment that names only loopback. If the entries merged, the
            // bridge would survive and every request below would be its own partition.
            TrustedProxies = "127.0.0.1",
        };
        var client = factory.CreateClient();

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 6; i++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, AuthPolicyPath);
            request.Headers.Add("X-Forwarded-For", $"192.168.68.{100 + i}");
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

        // Real members: a token naming no account in its club is not authenticated at all
        // (SessionEpochs), so it would be partitioned on the address instead.
        var club = await PeopleClub.SeedAsync(factory, "ratepart");
        var members = new List<Guid>();
        for (var i = 0; i < 5; i++) members.Add(await club.AddAsync(factory, $"Member {i}", isAdmin: false));

        // The courtside QR match is under the auth policy and admin-only: an ordinary
        // member's token is authenticated (so the limiter partitions on them) and then
        // refused by authorization, after the limiter.
        const string adminOnlyAuthPath = "/api/v1/court/1/qr/match";

        var statuses = new List<HttpStatusCode>();
        foreach (var member in members.Take(4))
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, adminOnlyAuthPath) { Content = JsonContent.Create(new { token = "x" }) };
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", club.Token(member, adminRole: false));
            statuses.Add((await client.SendAsync(request)).StatusCode);
        }
        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, statuses);

        var same = members[4];
        HttpStatusCode? second = null;
        for (var i = 0; i < 2; i++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, adminOnlyAuthPath) { Content = JsonContent.Create(new { token = "x" }) };
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", club.Token(same, adminRole: false));
            second = (await client.SendAsync(request)).StatusCode;
        }
        Assert.Equal(HttpStatusCode.TooManyRequests, second);
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
