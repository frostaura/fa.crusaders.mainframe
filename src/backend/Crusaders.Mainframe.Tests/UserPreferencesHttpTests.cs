using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <c>/api/v1/me/preferences</c> and the onboarding routes, against real Postgres.
///
/// <para>
/// <b>Postgres, not the in-memory host, for three reasons that are each a claim this feature
/// makes:</b> the theme CHECK constraint and the unique <c>(TenantId, UserId)</c> index only
/// exist in the migrated schema; the lazy-create retry only fires on a real unique violation;
/// and the answered <c>updated_at</c> is only worth asserting against a column that truncates
/// to microseconds.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class UserPreferencesHttpTests
{
    private readonly PostgresFixture _pg;

    public UserPreferencesHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string Path = "/api/v1/me/preferences";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response)
        => JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

    private static Task<int> RowCountAsync(TestWebAppFactory factory, Guid userId)
        => PeopleClub.ReadAsync(factory, db => db.UserPreferences.IgnoreQueryFilters().CountAsync(p => p.UserId == userId));

    [SkippableFact]
    public async Task A_member_who_never_changed_anything_reads_the_defaults_and_no_row_is_written()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "prefdef");
        var member = await club.AddAsync(factory, "Lerato Dube", isAdmin: false);

        var body = await club.Client(factory, member, adminRole: false).GetFromJsonAsync<JsonElement>(Path);

        Assert.Equal("system", body.GetProperty("theme").GetString());
        Assert.False(body.GetProperty("findable").GetBoolean());
        Assert.False(body.GetProperty("show_in_leaderboards").GetBoolean());
        Assert.False(body.GetProperty("rating_opt_in").GetBoolean());
        Assert.False(body.GetProperty("weekly_recap").GetBoolean());
        Assert.Equal(1, body.GetProperty("onboarding_version").GetInt32());
        Assert.Equal(UserPreferences.CurrentOnboardingVersion, body.GetProperty("current_onboarding_version").GetInt32());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("member_onboarding_completed_at").ValueKind);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("updated_at").ValueKind);
        Assert.Empty(body.GetProperty("admin_notification_optouts").EnumerateArray());

        // The read path is the hottest in the app; it must not insert a row of defaults.
        Assert.Equal(0, await RowCountAsync(factory, member));
    }

    /// <summary>
    /// The console's client sends camelCase. A snake-only body bound
    /// <c>{showInLeaderboards, ratingOptIn, weeklyRecap}</c> to nothing and answered 200 with every
    /// flag still false — a settings screen that says "saved" and saved nothing (review finding
    /// P2-2, 2026-09-23). Both spellings bind; snake_case wins when a body carries both.
    /// </summary>
    [SkippableFact]
    public async Task A_camel_case_put_changes_what_it_names()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "prefcamel");
        var member = await club.AddAsync(factory, "Camel Case", isAdmin: false);
        var client = club.Client(factory, member, adminRole: false);

        var put = await client.PutAsJsonAsync(Path, new
        {
            showInLeaderboards = true,
            ratingOptIn = true,
            weeklyRecap = true,
            adminNotificationOptouts = new[] { "member.registered" },
        });
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);

        var body = await client.GetFromJsonAsync<JsonElement>(Path);
        Assert.True(body.GetProperty("show_in_leaderboards").GetBoolean());
        Assert.True(body.GetProperty("rating_opt_in").GetBoolean());
        Assert.True(body.GetProperty("weekly_recap").GetBoolean());
        Assert.Equal("member.registered", Assert.Single(body.GetProperty("admin_notification_optouts").EnumerateArray()).GetString());

        var both = await client.PutAsJsonAsync(Path, new { weekly_recap = false, weeklyRecap = true });
        Assert.Equal(HttpStatusCode.OK, both.StatusCode);
        Assert.False((await client.GetFromJsonAsync<JsonElement>(Path)).GetProperty("weekly_recap").GetBoolean());
    }

    [SkippableFact]
    public async Task A_partial_put_changes_only_the_fields_it_names()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "prefput");
        var member = await club.AddAsync(factory, "Sipho Khumalo", isAdmin: false);
        var client = club.Client(factory, member, adminRole: false);

        var first = await client.PutAsJsonAsync(Path, new { theme = "dark", findable = true });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        var second = await client.PutAsJsonAsync(Path, new { weekly_recap = true });
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);

        var body = await client.GetFromJsonAsync<JsonElement>(Path);
        Assert.Equal("dark", body.GetProperty("theme").GetString());
        Assert.True(body.GetProperty("findable").GetBoolean());
        Assert.True(body.GetProperty("weekly_recap").GetBoolean());
        Assert.False(body.GetProperty("show_in_leaderboards").GetBoolean());
        Assert.Equal(1, await RowCountAsync(factory, member));
    }

    /// <summary>
    /// The answered stamp is the one that persists — the microsecond trap in
    /// <c>memory/gotchas-postgres-offsets.md</c>. Compared to the next READ, which is where a
    /// stamp answered from memory would have moved.
    /// </summary>
    [SkippableFact]
    public async Task The_updated_at_a_put_answers_is_the_one_a_later_read_returns()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "prefstamp");
        var member = await club.AddAsync(factory, "Ayesha Patel", isAdmin: false);
        var client = club.Client(factory, member, adminRole: false);

        var answered = (await JsonAsync(await client.PutAsJsonAsync(Path, new { theme = "light" })))
            .GetProperty("updated_at").GetDateTimeOffset();
        var reread = (await client.GetFromJsonAsync<JsonElement>(Path)).GetProperty("updated_at").GetDateTimeOffset();

        Assert.Equal(answered, reread);
        Assert.Equal(0, answered.Ticks % 10);
    }

    [SkippableTheory]
    [InlineData("""{"theme":"purple"}""", "invalid_theme")]
    [InlineData("""{"admin_notification_optouts":["Device Offline"]}""", "invalid_notification_kind")]
    [InlineData("""{"admin_notification_optouts":[""]}""", "invalid_notification_kind")]
    public async Task An_invalid_put_is_refused_with_its_code_and_changes_nothing(string json, string code)
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "prefbad");
        var member = await club.AddAsync(factory, "Johan Botha", isAdmin: false);
        var client = club.Client(factory, member, adminRole: false);

        // The valid half of a half-valid request must not land either.
        var body = json.Insert(1, "\"findable\":true,");
        var response = await client.PutAsync(Path, new StringContent(body, System.Text.Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(code, (await JsonAsync(response)).GetProperty("error").GetString());
        Assert.Equal(0, await RowCountAsync(factory, member));
    }

    [SkippableFact]
    public async Task Too_many_opt_outs_is_refused()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "prefmany");
        var admin = await club.AddAsync(factory, "Nomsa Zulu", isAdmin: true);

        var kinds = Enumerable.Range(0, 65).Select(i => $"kind.n{i}").ToArray();
        var response = await club.Client(factory, admin, adminRole: true)
            .PutAsJsonAsync(Path, new { admin_notification_optouts = kinds });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("too_many_optouts", (await JsonAsync(response)).GetProperty("error").GetString());
    }

    [SkippableFact]
    public async Task Opt_outs_are_stored_deduplicated_in_the_order_given()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "prefopt");
        var admin = await club.AddAsync(factory, "Pieter Nel", isAdmin: true);
        var client = club.Client(factory, admin, adminRole: true);

        await client.PutAsJsonAsync(Path, new { admin_notification_optouts = new[] { "device.offline", "member.registered", "device.offline" } });

        var kinds = (await client.GetFromJsonAsync<JsonElement>(Path)).GetProperty("admin_notification_optouts")
            .EnumerateArray().Select(e => e.GetString()).ToList();
        Assert.Equal(["device.offline", "member.registered"], kinds);
    }

    /// <summary>The database refuses a theme the endpoint would never write — the CHECK is real.</summary>
    [SkippableFact]
    public async Task The_database_itself_refuses_an_unknown_theme()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "prefck");
        var member = await club.AddAsync(factory, "Grace Mokoena", isAdmin: false);

        var ex = await Assert.ThrowsAsync<Npgsql.PostgresException>(() => PeopleClub.ReadAsync(factory, db =>
            db.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO user_preferences (\"Id\", \"TenantId\", \"UserId\", \"Theme\", \"UpdatedAt\") VALUES ({Guid.NewGuid()}, {club.TenantId}, {member}, 'sepia', now())")));
        Assert.Equal("23514", ex.SqlState);
    }

    [SkippableFact]
    public async Task Completing_dismissing_and_stepping_through_the_member_tour_are_all_recorded()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "preftour");
        var member = await club.AddAsync(factory, "Thabo Nkosi", isAdmin: false);
        var client = club.Client(factory, member, adminRole: false);

        var step = await client.PutAsJsonAsync("/api/v1/me/onboarding/member/step", new { step = "wallet" });
        Assert.Equal(HttpStatusCode.OK, step.StatusCode);
        Assert.Equal("wallet", (await JsonAsync(step)).GetProperty("member_onboarding_last_step").GetString());

        var dismissed = await JsonAsync(await client.PostAsync("/api/v1/me/onboarding/member/dismiss", null));
        Assert.Equal(JsonValueKind.String, dismissed.GetProperty("member_onboarding_dismissed_at").ValueKind);
        Assert.Equal(JsonValueKind.Null, dismissed.GetProperty("member_onboarding_completed_at").ValueKind);

        var completed = await JsonAsync(await client.PostAsync("/api/v1/me/onboarding/member/complete", null));
        Assert.Equal(JsonValueKind.String, completed.GetProperty("member_onboarding_completed_at").ValueKind);
        Assert.Equal(UserPreferences.CurrentOnboardingVersion, completed.GetProperty("onboarding_version").GetInt32());
        // "Not now, then did it anyway" is still true history.
        Assert.Equal(JsonValueKind.String, completed.GetProperty("member_onboarding_dismissed_at").ValueKind);
    }

    [SkippableTheory]
    [InlineData("")]
    [InlineData("has spaces")]
    [InlineData("0123456789012345678901234567890123456789012345678901234567890123456789")]
    public async Task A_step_that_is_not_a_slug_is_refused(string step)
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "prefstep");
        var member = await club.AddAsync(factory, "Karabo Molefe", isAdmin: false);

        var response = await club.Client(factory, member, adminRole: false)
            .PutAsJsonAsync("/api/v1/me/onboarding/member/step", new { step });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid_step", (await JsonAsync(response)).GetProperty("error").GetString());
    }

    [SkippableFact]
    public async Task Only_an_admin_can_complete_the_admin_tour()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "prefadm");
        var member = await club.AddAsync(factory, "Zanele Mthembu", isAdmin: false);
        var admin = await club.AddAsync(factory, "Desk Admin", isAdmin: true);

        var refused = await club.Client(factory, member, adminRole: false).PostAsync("/api/v1/me/onboarding/admin/complete", null);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal(0, await RowCountAsync(factory, member));

        var ok = await club.Client(factory, admin, adminRole: true).PostAsync("/api/v1/me/onboarding/admin/complete", null);
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal(JsonValueKind.String, (await JsonAsync(ok)).GetProperty("admin_onboarding_completed_at").ValueKind);
    }

    [SkippableFact]
    public async Task The_profile_embeds_the_same_preferences_the_preferences_route_answers()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "prefprof");
        var member = await club.AddAsync(factory, "Neo Sithole", isAdmin: false);
        var client = club.Client(factory, member, adminRole: false);
        await client.PutAsJsonAsync(Path, new { theme = "dark", rating_opt_in = true });

        var profile = await client.GetFromJsonAsync<JsonElement>("/api/v1/me/profile");
        var prefs = await client.GetFromJsonAsync<JsonElement>(Path);

        // Additive: the fields the profile always had are still there.
        Assert.Equal("Neo Sithole", profile.GetProperty("full_name").GetString());
        Assert.Equal(prefs.GetRawText(), profile.GetProperty("preferences").GetRawText());
        Assert.Equal("dark", profile.GetProperty("preferences").GetProperty("theme").GetString());
    }

    /// <summary>
    /// The standing cross-tenant rule. Two clubs in ONE database, a member in each; neither
    /// club's writes reach the other's row, and a token naming club B cannot read or create a
    /// row for a user who belongs to club A.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_member_can_neither_read_nor_write_this_clubs_preferences()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var clubA = await PeopleClub.SeedAsync(factory, "prefxa");
        var clubB = await PeopleClub.SeedAsync(factory, "prefxb");
        var alice = await clubA.AddAsync(factory, "Alice Adams", isAdmin: false);
        var bongani = await clubB.AddAsync(factory, "Bongani Buthelezi", isAdmin: false);

        await clubA.Client(factory, alice, adminRole: false).PutAsJsonAsync(Path, new { theme = "dark", findable = true });

        // B's own member sees B's defaults, not A's row.
        var bView = await clubB.Client(factory, bongani, adminRole: false).GetFromJsonAsync<JsonElement>(Path);
        Assert.Equal("system", bView.GetProperty("theme").GetString());

        // A token scoped to club B that names Alice's id: the read answers defaults (her row is
        // in club A and invisible here), and the write is a 404 rather than a row created for
        // a person club B has never heard of.
        var forged = clubB.Client(factory, alice, adminRole: false);
        var forgedRead = await forged.GetFromJsonAsync<JsonElement>(Path);
        Assert.Equal("system", forgedRead.GetProperty("theme").GetString());
        Assert.False(forgedRead.GetProperty("findable").GetBoolean());

        var forgedWrite = await forged.PutAsJsonAsync(Path, new { theme = "light" });
        Assert.Equal(HttpStatusCode.NotFound, forgedWrite.StatusCode);

        var rows = await PeopleClub.ReadAsync(factory, db =>
            db.UserPreferences.IgnoreQueryFilters().Where(p => p.UserId == alice).ToListAsync());
        var only = Assert.Single(rows);
        Assert.Equal(clubA.TenantId, only.TenantId);
        Assert.Equal("dark", only.Theme);
    }

    /// <summary>
    /// Two first-ever writes at once from two tabs. Both find no row; the unique index refuses
    /// one insert, and the retry replays it onto the other's row — both changes land, one row.
    /// </summary>
    [SkippableFact]
    public async Task Two_simultaneous_first_writes_leave_one_row_holding_both_changes()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "prefrace");

        for (var round = 0; round < 5; round++)
        {
            var member = await club.AddAsync(factory, $"Racer {round}", isAdmin: false);
            var a = club.Client(factory, member, adminRole: false);
            var b = club.Client(factory, member, adminRole: false);

            var responses = await Task.WhenAll(
                a.PutAsJsonAsync(Path, new { findable = true }),
                b.PutAsJsonAsync(Path, new { weekly_recap = true }));

            Assert.All(responses, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));
            Assert.Equal(1, await RowCountAsync(factory, member));
            var body = await a.GetFromJsonAsync<JsonElement>(Path);
            Assert.True(body.GetProperty("findable").GetBoolean());
            Assert.True(body.GetProperty("weekly_recap").GetBoolean());
        }
    }
}
