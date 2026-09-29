using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 1, B14: ten sign-ins a minute per address tripped on club Wi-Fi, where every
/// member shares one address. The tight limit is now per account (club + address typed); the
/// per-address bucket is a higher ceiling. Brute force against one account is still refused.
/// </summary>
public sealed class SignInRateLimitHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private static StringContent Login(string email, string password = "wrong-password") =>
        new(new JsonObject { ["email"] = email, ["password"] = password }.ToJsonString(), Encoding.UTF8, "application/json");

    private static async Task<(WebApplicationFactory<Program> App, MemberCodeClub Club, HttpClient Client)> StartAsync(
        TestWebAppFactory factory, string prefix)
    {
        var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, prefix);
        var client = app.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false });
        client.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";
        return (app, club, client);
    }

    [SkippableFact]
    public async Task Many_members_behind_one_address_are_not_limited_by_each_other()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory
        {
            ConnectionString = pg.ConnectionString,
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 2, ["AuthPerIpPerMinute"] = 50 },
        };
        var (app, club, client) = await StartAsync(factory, "rlwifi");
        await using var _ = app;

        // Twelve different members, one address, one attempt each — six times the per-account limit.
        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 12; i++) statuses.Add((await client.PostAsync("/api/v1/auth/login", Login($"member{i}-{club.Slug}@test.local"))).StatusCode);
        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, statuses);

        // And a real member signs in fine among them.
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/v1/auth/login", Login($"olga-{club.Slug}@test.local", "OldPass!123"))).StatusCode);
    }

    [SkippableFact]
    public async Task Guessing_one_account_is_refused_whatever_the_address_while_other_accounts_are_not()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory
        {
            ConnectionString = pg.ConnectionString,
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 2, ["AuthPerIpPerMinute"] = 50 },
        };
        var (app, club, client) = await StartAsync(factory, "rlguess");
        await using var _ = app;
        var target = $"olga-{club.Slug}@test.local";

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync("/api/v1/auth/login", Login(target))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync("/api/v1/auth/login", Login(target.ToUpperInvariant()))).StatusCode);
        var third = await client.PostAsync("/api/v1/auth/login", Login(" " + target));
        Assert.Equal(HttpStatusCode.TooManyRequests, third.StatusCode);
        Assert.Equal("60", third.Headers.RetryAfter?.ToString());
        Assert.Contains("rate_limited", await third.Content.ReadAsStringAsync());

        // Even the right password is refused for the rest of the window: the limit is not an oracle.
        Assert.Equal(HttpStatusCode.TooManyRequests, (await client.PostAsync("/api/v1/auth/login", Login(target, "OldPass!123"))).StatusCode);

        // Pam, at the same address, is untouched.
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/v1/auth/login", Login($"pam-{club.Slug}@test.local", "OldPass!123"))).StatusCode);

        // Password-reset requests are limited per account the same way (a mail bomb is per mailbox).
        var resets = new List<HttpStatusCode>();
        for (var i = 0; i < 3; i++)
        {
            resets.Add((await client.PostAsync("/api/v1/auth/forgot-password",
                new StringContent(new JsonObject { ["email"] = $"pam-{club.Slug}@test.local" }.ToJsonString(), Encoding.UTF8, "application/json"))).StatusCode);
        }
        Assert.Equal([HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.TooManyRequests], resets);
    }

    [SkippableFact]
    public async Task One_address_spraying_many_accounts_still_meets_the_per_address_ceiling()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory
        {
            ConnectionString = pg.ConnectionString,
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 5, ["AuthPerIpPerMinute"] = 3 },
        };
        var (app, club, client) = await StartAsync(factory, "rlspray");
        await using var _ = app;

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 6; i++) statuses.Add((await client.PostAsync("/api/v1/auth/login", Login($"victim{i}-{club.Slug}@test.local"))).StatusCode);
        Assert.DoesNotContain(HttpStatusCode.TooManyRequests, statuses.Take(3));
        Assert.Contains(HttpStatusCode.TooManyRequests, statuses.Skip(3));
    }
}
