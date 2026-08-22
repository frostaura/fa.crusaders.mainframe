using System.Net;

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
    /// The limiter is registered before authentication, so a flood costs no token
    /// validation and no database read. Asserted by flooding with no credentials at
    /// all and still getting 429 — if authentication ran first this would be 401
    /// forever and the limiter would never see the request.
    /// </summary>
    [Fact]
    public async Task Limiting_happens_before_authentication()
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
