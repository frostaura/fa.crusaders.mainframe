using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 2, B-10 (ADM-L): the global backstop was 600 a minute per ADDRESS, and a club's
/// members all sit behind one router — an evening's app traffic 429'd the whole club at once. It
/// is now per MEMBER for a signed-in request and per address only for anonymous ones (at a much
/// higher ceiling), and the refusal carries a stable code the app can word.
/// </summary>
public sealed class R2RateLimitHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    [SkippableFact]
    public async Task Members_behind_one_address_each_get_their_own_budget()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = new TestWebAppFactory
        {
            ConnectionString = pg.ConnectionString,
            RateLimits = new Dictionary<string, int> { ["GlobalPerMinute"] = 3 },
        };
        var club = await PlayersClub.SeedAsync(f, "r2rlmember");
        var olive = club.Client(f, club.Organiser);

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 4; i++) statuses.Add((await olive.GetAsync("/api/v1/me/profile")).StatusCode);
        Assert.Equal([HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.TooManyRequests], statuses);

        var refused = await olive.GetAsync("/api/v1/me/profile");
        var body = await refused.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("rate_limited", body.GetProperty("error").GetString());
        Assert.Equal(60, body.GetProperty("retry_after_seconds").GetInt32());

        // Same address, another member: untouched by Olive's budget.
        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Sam).GetAsync("/api/v1/me/profile")).StatusCode);
    }

    [SkippableFact]
    public async Task Anonymous_requests_share_an_address_ceiling_that_signed_in_members_do_not_spend()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = new TestWebAppFactory
        {
            ConnectionString = pg.ConnectionString,
            RateLimits = new Dictionary<string, int> { ["GlobalPerIpPerMinute"] = 2, ["GlobalPerMinute"] = 100 },
        };
        var club = await PlayersClub.SeedAsync(f, "r2rlanon");
        var anonymous = f.CreateClient();

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 4; i++) statuses.Add((await anonymous.GetAsync($"/api/v1/invites/{new string('a', 43)}/preview")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, statuses[^1]);

        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Organiser).GetAsync("/api/v1/me/profile")).StatusCode);
    }
}
