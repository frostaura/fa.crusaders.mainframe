using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// R20 — <c>POST /api/v1/admin/members/{userId}/admin</c>, against real Postgres.
///
/// <para>
/// <b>Postgres because the guard is a lock.</b> The last-admin rule is a read-then-write, and
/// the in-memory provider has no transactions and no advisory locks — a race test there would
/// pass by never racing. The two-admins-remove-each-other test below is the reason this file
/// exists.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class AdminRoleHttpTests
{
    private readonly PostgresFixture _pg;

    public AdminRoleHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static string RolePath(Guid userId) => $"/api/v1/admin/members/{userId}/admin";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>The app with a recording mail service and, optionally, an <c>Admins:Emails</c> list.</summary>
    private static WebApplicationFactory<Program> Wired(TestWebAppFactory factory, StubEmailService mail, params string[] configAdmins)
    {
        return factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEmailService>();
            s.AddSingleton<IEmailService>(mail);
            if (configAdmins.Length > 0)
            {
                s.RemoveAll<InherentAdmins>();
                s.AddSingleton(new InherentAdmins(configAdmins.ToHashSet(StringComparer.Ordinal), []));
            }
        }));
    }

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response)
        => JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

    private static async Task<string?> ErrorAsync(HttpResponseMessage response)
        => (await JsonAsync(response)).GetProperty("error").GetString();

    private static Task<bool> IsAdminAsync(WebApplicationFactory<Program> app, Guid userId)
        => PeopleClub.ReadAsync(app, db => db.Users.IgnoreQueryFilters().Where(u => u.Id == userId).Select(u => u.IsAdmin).FirstAsync());

    // ------------------------------------------------------------------ grant

    [SkippableFact]
    public async Task Granting_an_active_member_makes_them_admin_records_it_twice_and_tells_them_and_the_other_admins()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new StubEmailService();
        await using var app = Wired(factory, mail);
        var club = await PeopleClub.SeedAsync(app, "rolegrant");
        var actor = await club.AddAsync(app, "Anna Actor", isAdmin: true);
        var colleague = await club.AddAsync(app, "Colin Colleague", isAdmin: true);
        var member = await club.AddAsync(app, "Mandla Member", isAdmin: false);

        var response = await club.Client(app, actor, adminRole: true).PostAsJsonAsync(RolePath(member), new { grant = true });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await JsonAsync(response);
        Assert.True(body.GetProperty("changed").GetBoolean());
        Assert.True(body.GetProperty("is_admin").GetBoolean());
        Assert.Equal("granted", body.GetProperty("admin_source").GetString());
        Assert.True(await IsAdminAsync(app, member));

        var audit = await PeopleClub.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .SingleAsync(a => a.SubjectUserId == member && a.Action == AdminRoleService.GrantedAction));
        Assert.Equal(actor, audit.ActorUserId);
        var change = await PeopleClub.ReadAsync(app, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .SingleAsync(c => c.SubjectId == member && c.Action == AdminChangeActions.MemberAdminGranted));
        Assert.Equal(actor, change.ActorUserId);
        Assert.Equal("Anna Actor", change.ActorName);
        Assert.Equal("Mandla Member", change.SubjectLabel);
        Assert.Equal(AdminChangeAreas.Member, change.Area);

        var memberEmail = $"mandla.member@{club.Slug}.test";
        var colleagueEmail = $"colin.colleague@{club.Slug}.test";
        Assert.NotNull(await mail.WaitFor(m => m.To == memberEmail && m.Subject == "You're now an administrator"));
        Assert.NotNull(await mail.WaitFor(m => m.To == colleagueEmail && m.Subject == "New administrator — Mandla Member"));
        // The actor is not told about what they just did.
        await Task.Delay(200);
        Assert.DoesNotContain(mail.Sent, m => m.To == $"anna.actor@{club.Slug}.test");
    }

    [SkippableTheory]
    [InlineData("pending")]
    [InlineData("suspended_membership")]
    [InlineData("no_membership")]
    [InlineData("suspended_account")]
    public async Task Only_an_active_member_with_an_active_account_can_be_made_admin(string who)
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "rolenotact");
        var actor = await club.AddAsync(factory, "Desk Admin", isAdmin: true);
        var target = who switch
        {
            "pending" => await club.AddAsync(factory, "Pat Pending", false, MembershipStatus.PendingApproval),
            "suspended_membership" => await club.AddAsync(factory, "Sam Suspended", false, MembershipStatus.Suspended),
            "no_membership" => await club.AddAsync(factory, "Nomvula None", false, membership: null),
            _ => await club.AddAsync(factory, "Lulu Locked", false, userStatus: "suspended"),
        };

        var response = await club.Client(factory, actor, adminRole: true).PostAsJsonAsync(RolePath(target), new { grant = true });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("not_active_member", await ErrorAsync(response));
        Assert.False(await IsAdminAsync(factory, target));
    }

    [SkippableFact]
    public async Task Granting_someone_already_admin_changes_nothing_and_records_nothing()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "rolenoop");
        var actor = await club.AddAsync(factory, "Desk Admin", isAdmin: true);
        var other = await club.AddAsync(factory, "Other Admin", isAdmin: true);

        var response = await club.Client(factory, actor, adminRole: true).PostAsJsonAsync(RolePath(other), new { grant = true });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.False((await JsonAsync(response)).GetProperty("changed").GetBoolean());
        Assert.Equal(0, await PeopleClub.ReadAsync(factory, db => db.AdminChangeLogs.IgnoreQueryFilters().CountAsync(c => c.SubjectId == other)));
    }

    // ------------------------------------------------------------------ request validation

    [SkippableTheory]
    [InlineData("""{}""", "grant_required")]
    [InlineData("""{"grant":false}""", "reason_required")]
    [InlineData("""{"grant":false,"reason":"   "}""", "reason_required")]
    public async Task A_malformed_request_is_refused_before_anything_is_read(string json, string code)
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "rolebad");
        var actor = await club.AddAsync(factory, "Desk Admin", isAdmin: true);
        var other = await club.AddAsync(factory, "Other Admin", isAdmin: true);

        var response = await club.Client(factory, actor, adminRole: true)
            .PostAsync(RolePath(other), new StringContent(json, System.Text.Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(code, await ErrorAsync(response));
        Assert.True(await IsAdminAsync(factory, other));
    }

    [SkippableFact]
    public async Task A_member_cannot_reach_the_route_at_all()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "rolemem");
        var member = await club.AddAsync(factory, "Mo Member", isAdmin: false);

        var response = await club.Client(factory, member, adminRole: false).PostAsJsonAsync(RolePath(member), new { grant = true });

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.False(await IsAdminAsync(factory, member));
    }

    // ------------------------------------------------------------------ revoke

    [SkippableFact]
    public async Task Revoking_records_the_reason_and_the_member_is_told_it()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new StubEmailService();
        await using var app = Wired(factory, mail);
        var club = await PeopleClub.SeedAsync(app, "rolerevoke");
        var actor = await club.AddAsync(app, "Anna Actor", isAdmin: true);
        var target = await club.AddAsync(app, "Themba Target", isAdmin: true);
        var watcher = await club.AddAsync(app, "Wendy Watcher", isAdmin: true);

        var response = await club.Client(app, actor, adminRole: true)
            .PostAsJsonAsync(RolePath(target), new { grant = false, reason = "Stepped down from the committee" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await JsonAsync(response);
        Assert.True(body.GetProperty("changed").GetBoolean());
        Assert.False(body.GetProperty("is_admin").GetBoolean());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("admin_source").ValueKind);
        Assert.False(await IsAdminAsync(app, target));

        var change = await PeopleClub.ReadAsync(app, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .SingleAsync(c => c.SubjectId == target && c.Action == AdminChangeActions.MemberAdminRevoked));
        Assert.Equal("Stepped down from the committee", change.Reason);
        Assert.True(JsonDocument.Parse(change.BeforeJson!).RootElement.GetProperty("is_admin").GetBoolean());
        Assert.False(JsonDocument.Parse(change.AfterJson!).RootElement.GetProperty("is_admin").GetBoolean());
        var audit = await PeopleClub.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .SingleAsync(a => a.SubjectUserId == target && a.Action == AdminRoleService.RevokedAction));
        Assert.Contains("Stepped down from the committee", audit.DetailsJson);

        var toTarget = await mail.WaitFor(m => m.To == $"themba.target@{club.Slug}.test");
        Assert.NotNull(toTarget);
        Assert.Equal("You're no longer an administrator", toTarget!.Subject);
        Assert.Contains("Stepped down from the committee", MailText.Unwrap(toTarget.PlainBody));
        var notice = await mail.WaitFor(m => m.To == $"wendy.watcher@{club.Slug}.test");
        Assert.NotNull(notice);
        Assert.Equal("Administrator removed — Themba Target", notice!.Subject);
        _ = watcher;
    }

    [SkippableFact]
    public async Task The_last_active_admin_cannot_be_removed_even_by_themselves()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "rolelast");
        var only = await club.AddAsync(factory, "Olwethu Only", isAdmin: true);
        // An admin flag on a SUSPENDED account is not an admin anybody can use.
        await club.AddAsync(factory, "Dormant Admin", isAdmin: true, userStatus: "suspended");

        var response = await club.Client(factory, only, adminRole: true)
            .PostAsJsonAsync(RolePath(only), new { grant = false, reason = "Leaving", confirm_self = true });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("last_admin", await ErrorAsync(response));
        Assert.True(await IsAdminAsync(factory, only));
    }

    [SkippableFact]
    public async Task Removing_yourself_needs_confirmation_and_then_takes_effect_on_your_own_token()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var club = await PeopleClub.SeedAsync(factory, "roleself");
        var me = await club.AddAsync(factory, "Sipho Self", isAdmin: true);
        await club.AddAsync(factory, "Remaining Admin", isAdmin: true);
        var client = club.Client(factory, me, adminRole: true);

        var unconfirmed = await client.PostAsJsonAsync(RolePath(me), new { grant = false, reason = "Handing over" });
        Assert.Equal(HttpStatusCode.Conflict, unconfirmed.StatusCode);
        Assert.Equal("confirm_self_required", await ErrorAsync(unconfirmed));
        Assert.True(await IsAdminAsync(factory, me));

        var confirmed = await client.PostAsJsonAsync(RolePath(me), new { grant = false, reason = "Handing over", confirm_self = true });
        Assert.Equal(HttpStatusCode.OK, confirmed.StatusCode);
        Assert.False(await IsAdminAsync(factory, me));

        // The same token, one request later: the admin role it still carries is no longer honoured.
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/v1/admin/members")).StatusCode);
    }

    [SkippableFact]
    public async Task An_address_in_the_server_configuration_cannot_be_removed_here_and_the_list_says_why()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var mail = new StubEmailService();
        var slugless = $"ops-{Guid.NewGuid():N}@operator.test";
        await using var app = Wired(factory, mail, slugless);
        var club = await PeopleClub.SeedAsync(app, "rolecfg");
        var actor = await club.AddAsync(app, "Desk Admin", isAdmin: true);
        var configured = await club.AddAsync(app, "Operator Person", isAdmin: true, email: slugless);
        var member = await club.AddAsync(app, "Plain Member", isAdmin: false);
        var client = club.Client(app, actor, adminRole: true);

        var response = await client.PostAsJsonAsync(RolePath(configured), new { grant = false, reason = "Tidying up" });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("admin_inherited_from_config", await ErrorAsync(response));
        Assert.True(await IsAdminAsync(app, configured));

        var rows = (await client.GetFromJsonAsync<JsonElement>("/api/v1/admin/members")).EnumerateArray().ToList();
        JsonElement Row(Guid id) => rows.Single(r => r.GetProperty("user_id").GetGuid() == id);
        Assert.Equal("config", Row(configured).GetProperty("admin_source").GetString());
        Assert.True(Row(configured).GetProperty("is_admin").GetBoolean());
        Assert.Equal("granted", Row(actor).GetProperty("admin_source").GetString());
        Assert.Equal(JsonValueKind.Null, Row(member).GetProperty("admin_source").ValueKind);
        Assert.False(Row(member).GetProperty("is_admin").GetBoolean());
    }

    // ------------------------------------------------------------------ the race

    /// <summary>
    /// Two admins, each removing the other, at the same moment. Without the lock both read "one
    /// other admin remains", both commit, and the club has none. With it exactly one succeeds
    /// and the other is told it would have removed the last admin.
    /// </summary>
    [SkippableFact]
    public async Task Two_admins_removing_each_other_at_once_leave_exactly_one_admin()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();

        for (var round = 0; round < 8; round++)
        {
            var club = await PeopleClub.SeedAsync(factory, "rolerace");
            var a = await club.AddAsync(factory, $"Alpha {round}", isAdmin: true);
            var b = await club.AddAsync(factory, $"Bravo {round}", isAdmin: true);
            var clientA = club.Client(factory, a, adminRole: true);
            var clientB = club.Client(factory, b, adminRole: true);

            var responses = await Task.WhenAll(
                clientA.PostAsJsonAsync(RolePath(b), new { grant = false, reason = "race" }),
                clientB.PostAsJsonAsync(RolePath(a), new { grant = false, reason = "race" }));

            Assert.Single(responses, r => r.StatusCode == HttpStatusCode.OK);
            var loser = Assert.Single(responses, r => r.StatusCode != HttpStatusCode.OK);
            // 409 last_admin when the loser got through the door; 403 when its token was already
            // stripped by the time it arrived. Either way, it changed nothing.
            Assert.Contains(loser.StatusCode, new[] { HttpStatusCode.Conflict, HttpStatusCode.Forbidden });
            if (loser.StatusCode == HttpStatusCode.Conflict) Assert.Equal("last_admin", await ErrorAsync(loser));

            var admins = await PeopleClub.ReadAsync(factory, db => db.Users.IgnoreQueryFilters()
                .CountAsync(u => u.TenantId == club.TenantId && u.IsAdmin));
            Assert.Equal(1, admins);
        }
    }

    // ------------------------------------------------------------------ tenancy

    [SkippableFact]
    public async Task Another_clubs_admin_cannot_touch_this_clubs_members()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var factory = CreateFactory();
        var clubA = await PeopleClub.SeedAsync(factory, "rolexa");
        var clubB = await PeopleClub.SeedAsync(factory, "rolexb");
        var adminA = await clubA.AddAsync(factory, "Admin Alpha", isAdmin: true);
        var otherA = await clubA.AddAsync(factory, "Second Alpha", isAdmin: true);
        var memberA = await clubA.AddAsync(factory, "Member Alpha", isAdmin: false);
        var adminB = await clubB.AddAsync(factory, "Admin Bravo", isAdmin: true);
        var clientB = clubB.Client(factory, adminB, adminRole: true);

        var grant = await clientB.PostAsJsonAsync(RolePath(memberA), new { grant = true });
        var revoke = await clientB.PostAsJsonAsync(RolePath(otherA), new { grant = false, reason = "hostile" });

        Assert.Equal(HttpStatusCode.NotFound, grant.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, revoke.StatusCode);
        Assert.False(await IsAdminAsync(factory, memberA));
        Assert.True(await IsAdminAsync(factory, otherA));
        Assert.True(await IsAdminAsync(factory, adminA));
        Assert.Equal(0, await PeopleClub.ReadAsync(factory, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .CountAsync(c => c.SubjectId == memberA || c.SubjectId == otherA)));

        // And club B's member list shows none of club A's people.
        var rows = (await clientB.GetFromJsonAsync<JsonElement>("/api/v1/admin/members")).EnumerateArray()
            .Select(r => r.GetProperty("user_id").GetGuid()).ToList();
        Assert.Equal([adminB], rows);
    }
}
