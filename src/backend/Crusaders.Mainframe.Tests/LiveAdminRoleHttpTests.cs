using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The admin role on a token already in somebody's browser, across a change of that person's
/// rights — the whole point of <c>LiveAdminRole</c>.
///
/// <para>
/// Each test WARMS the cache first with a request that succeeds as admin, because a cold cache
/// proves nothing about eviction: the first read after a demotion would find the new value
/// whether or not anything had been invalidated.
/// </para>
/// </summary>
public sealed class LiveAdminRoleHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public LiveAdminRoleHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string AdminList = "/api/v1/admin/members";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    [SkippableFact]
    public async Task A_demoted_admins_existing_token_loses_admin_access_on_the_very_next_request()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "livedemote");
        var actor = await club.AddAsync(factory, "Acting Admin", isAdmin: true);
        var target = await club.AddAsync(factory, "Demoted Admin", isAdmin: true);
        var targetClient = club.Client(factory, target, adminRole: true);

        // Warm: the target's token works, and the cache now holds "admin" for them.
        Assert.Equal(HttpStatusCode.OK, (await targetClient.GetAsync(AdminList)).StatusCode);

        var demote = await club.Client(factory, actor, adminRole: true)
            .PostAsJsonAsync($"/api/v1/admin/members/{target}/admin", new { grant = false, reason = "Rights withdrawn" });
        Assert.Equal(HttpStatusCode.OK, demote.StatusCode);

        // Same token, still inside its lifetime, still claiming the role. Well inside the 15 s
        // cache window, so only the eviction can explain the refusal.
        Assert.Equal(HttpStatusCode.Forbidden, (await targetClient.GetAsync(AdminList)).StatusCode);
        var whoami = await targetClient.GetFromJsonAsync<JsonElement>("/api/v1/whoami");
        Assert.False(whoami.GetProperty("is_admin").GetBoolean());

        // The member half of the product is untouched — the token is demoted, not revoked.
        Assert.Equal(HttpStatusCode.OK, (await targetClient.GetAsync("/api/v1/me/profile")).StatusCode);

        // And a refresh now mints a token without the role.
        var refreshed = await targetClient.PostAsync("/api/v1/auth/refresh", null);
        Assert.Equal(HttpStatusCode.OK, refreshed.StatusCode);
        Assert.False((await refreshed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("is_admin").GetBoolean());
    }

    [SkippableFact]
    public async Task A_promoted_member_gains_admin_access_from_their_next_refresh()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "livepromote");
        var actor = await club.AddAsync(factory, "Acting Admin", isAdmin: true);
        var member = await club.AddAsync(factory, "Rising Member", isAdmin: false);
        var memberClient = club.Client(factory, member, adminRole: false);

        Assert.Equal(HttpStatusCode.Forbidden, (await memberClient.GetAsync(AdminList)).StatusCode);

        var promote = await club.Client(factory, actor, adminRole: true)
            .PostAsJsonAsync($"/api/v1/admin/members/{member}/admin", new { grant = true, reason = "runs the desk on Tuesdays" });
        Assert.Equal(HttpStatusCode.OK, promote.StatusCode);

        // The old token never claimed the role, and a database read never GRANTS one.
        Assert.Equal(HttpStatusCode.Forbidden, (await memberClient.GetAsync(AdminList)).StatusCode);

        var refreshed = await memberClient.PostAsync("/api/v1/auth/refresh", null);
        Assert.Equal(HttpStatusCode.OK, refreshed.StatusCode);
        var body = await refreshed.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("is_admin").GetBoolean());

        var fresh = factory.CreateClient();
        fresh.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", body.GetProperty("access_token").GetString());
        Assert.Equal(HttpStatusCode.OK, (await fresh.GetAsync(AdminList)).StatusCode);
    }

    /// <summary>
    /// A token whose admin claim names a club the account is not an admin OF. The live check
    /// matches tenant and user together, so an admin at one club minted into another's slug
    /// is not an admin there. Since 2026-09-29 the session check refuses it outright — the
    /// account is not a member of that club at all, so it is no session there (401), rather
    /// than a member session stripped of its role (403). See SessionEpochs.
    /// </summary>
    [SkippableFact]
    public async Task An_admin_of_one_club_holding_a_token_for_another_is_not_an_admin_there()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var clubA = await PeopleClub.SeedAsync(factory, "livexa");
        var clubB = await PeopleClub.SeedAsync(factory, "livexb");
        var adminA = await clubA.AddAsync(factory, "Admin Alpha", isAdmin: true);
        await clubB.AddAsync(factory, "Admin Bravo", isAdmin: true);

        var crossed = clubB.Client(factory, adminA, adminRole: true);

        Assert.Equal(HttpStatusCode.Unauthorized, (await crossed.GetAsync(AdminList)).StatusCode);
    }
}
