using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Demo;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The demo club's member view: an admin in the demo flips to a plain-member persona with a wallet,
/// games and open invites, and back. Demo-only, never an admin, never anything of the real club,
/// and every crossing is on the real club's record.
/// </summary>
public sealed class DemoMemberViewHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public DemoMemberViewHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string MemberView = "demo_member";

    private static WebApplicationFactory<Program> Wired(TestWebAppFactory factory) =>
        factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEmailService>();
            s.AddSingleton<IEmailService>(new DemoAwareEmailService(new StubEmailService(), NullLogger<DemoAwareEmailService>.Instance));
        }));

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage r) => JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;

    private static async Task<string> TokenAsync(HttpClient client, string mode, string route = "/api/v1/admin/mode")
    {
        var response = await client.PostAsJsonAsync(route, new { mode });
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, $"{route} {mode}: {(int)response.StatusCode} {text}");
        return JsonDocument.Parse(text).RootElement.GetProperty("access_token").GetString()!;
    }

    /// <summary>The admin's demo session, then their member-view session out of it.</summary>
    private static async Task<(string Demo, string Member)> IntoMemberViewAsync(WebApplicationFactory<Program> app, DemoClub club)
    {
        var demo = await TokenAsync(club.Admin(app), "demo");
        return (demo, await TokenAsync(DemoClub.Bearer(app, demo), MemberView));
    }

    [SkippableFact]
    public async Task The_member_view_is_a_plain_member_with_a_wallet_and_invites_who_can_reach_no_admin_route()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var app = Wired(_pg.SharedHost);
        var club = await DemoClub.SeedAsync(app, "mview");
        var (_, member) = await IntoMemberViewAsync(app, club);
        var client = DemoClub.Bearer(app, member);
        var demo = await club.DemoAsync(app);

        Assert.Equal(demo.Slug, DemoClub.SlugOf(member));
        var persona = DemoClub.SubjectOf(member);
        Assert.NotEqual(club.AdminId, persona);
        var who = await JsonAsync(await client.GetAsync("/api/v1/whoami"));
        Assert.False(who.GetProperty("is_admin").GetBoolean());
        Assert.True(who.GetProperty("demo_member_view").GetBoolean());

        // A member's own screens: a wallet with minutes in it, and games with invites waiting.
        var wallet = await JsonAsync(await client.GetAsync("/api/v1/wallet"));
        Assert.True(wallet.GetProperty("balance_minutes").GetInt32() > 0);
        var story = await PeopleClub.ReadAsync(app, async db => new
        {
            Invited = await db.BookingParticipants.IgnoreQueryFilters().CountAsync(p => p.TenantId == demo.Id && p.UserId == persona && p.Status == ParticipantStatus.Invited),
            Games = await db.Bookings.IgnoreQueryFilters().CountAsync(b => b.TenantId == demo.Id && b.UserId == persona),
            IsAdmin = await db.Users.IgnoreQueryFilters().Where(u => u.Id == persona).Select(u => u.IsAdmin).SingleAsync(),
        });
        Assert.True(story.Invited > 0);
        Assert.True(story.Games > 0);
        Assert.False(story.IsAdmin);

        // Every admin route refuses it by the ordinary role policy, the mode switch included.
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/v1/admin/members")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/v1/admin/mode", new { mode = "live" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsync("/api/v1/admin/demo/reset", null)).StatusCode);
    }

    [SkippableFact]
    public async Task The_way_back_leads_to_the_admins_demo_session_or_the_live_club_and_each_crossing_is_on_the_real_record()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var app = Wired(_pg.SharedHost);
        var club = await DemoClub.SeedAsync(app, "mback");
        var (_, member) = await IntoMemberViewAsync(app, club);

        var adminDemo = await TokenAsync(DemoClub.Bearer(app, member), "demo", "/api/v1/me/demo/mode");
        Assert.Equal(DemoClub.SlugOf(member), DemoClub.SlugOf(adminDemo));
        var again = DemoClub.Bearer(app, adminDemo);
        Assert.True((await JsonAsync(await again.GetAsync("/api/v1/whoami"))).GetProperty("is_admin").GetBoolean());
        Assert.False((await JsonAsync(await again.GetAsync("/api/v1/whoami"))).GetProperty("demo_member_view").GetBoolean());

        // Over and back again: the persona is the same account, and the demo was not drawn a second time.
        var drawn = (await club.DemoAsync(app)).DemoGeneratedAt;
        var secondMember = await TokenAsync(again, MemberView);
        Assert.Equal(DemoClub.SubjectOf(member), DemoClub.SubjectOf(secondMember));
        Assert.Equal(drawn, (await club.DemoAsync(app)).DemoGeneratedAt);

        var live = await TokenAsync(DemoClub.Bearer(app, secondMember), "live", "/api/v1/me/demo/mode");
        Assert.Equal(club.Club.Slug, DemoClub.SlugOf(live));
        Assert.Equal(club.AdminId, DemoClub.SubjectOf(live));

        var actions = await PeopleClub.ReadAsync(app, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(c => c.TenantId == club.Club.TenantId).OrderBy(c => c.OccurredAt).Select(c => c.Action).ToListAsync());
        Assert.Equal(new[]
        {
            AdminChangeActions.DemoEntered, AdminChangeActions.DemoMemberViewEntered, AdminChangeActions.DemoMemberViewLeft,
            AdminChangeActions.DemoMemberViewEntered, AdminChangeActions.DemoLeft,
        }, actions);
    }

    [SkippableFact]
    public async Task Nothing_grants_a_member_view_outside_the_demo_and_nobody_else_can_leave_through_it()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var app = Wired(_pg.SharedHost);
        var club = await DemoClub.SeedAsync(app, "mrefuse");

        // The live club has no member view: asking for it there is a named refusal and creates nothing.
        var fromLive = await club.Admin(app).PostAsJsonAsync("/api/v1/admin/mode", new { mode = MemberView });
        Assert.Equal(HttpStatusCode.Conflict, fromLive.StatusCode);
        Assert.Equal("member_view_needs_demo", (await JsonAsync(fromLive)).GetProperty("error").GetString());
        Assert.False(await PeopleClub.ReadAsync(app, db => db.Users.IgnoreQueryFilters().AnyAsync(u => u.DemoSourceUserId == club.AdminId)));

        // A real member (or admin) cannot use the way out: it is a refusal, not a session.
        var realMember = club.Club.Client(app, club.MemberId, adminRole: false);
        var asMember = await realMember.PostAsJsonAsync("/api/v1/me/demo/mode", new { mode = "live" });
        Assert.Equal(HttpStatusCode.Conflict, asMember.StatusCode);
        Assert.Equal("not_member_view", (await JsonAsync(asMember)).GetProperty("error").GetString());
        Assert.Equal(HttpStatusCode.Conflict, (await club.Admin(app).PostAsJsonAsync("/api/v1/me/demo/mode", new { mode = "demo" })).StatusCode);

        // The admin's own mirror is not a persona either.
        var (demoToken, member) = await IntoMemberViewAsync(app, club);
        var mirror = await DemoClub.Bearer(app, demoToken).PostAsJsonAsync("/api/v1/me/demo/mode", new { mode = "live" });
        Assert.Equal("not_member_view", (await JsonAsync(mirror)).GetProperty("error").GetString());

        Assert.Equal(HttpStatusCode.BadRequest, (await DemoClub.Bearer(app, member).PostAsJsonAsync("/api/v1/me/demo/mode", new { mode = "elsewhere" })).StatusCode);
    }

    [SkippableFact]
    public async Task The_member_view_never_touches_the_real_club_and_its_way_back_closes_when_the_real_sessions_end()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var app = Wired(_pg.SharedHost);
        var club = await DemoClub.SeedAsync(app, "mreal");
        Task<int[]> Counts() => PeopleClub.ReadAsync(app, async db => new[]
        {
            await db.Users.IgnoreQueryFilters().CountAsync(u => u.TenantId == club.Club.TenantId),
            await db.Memberships.IgnoreQueryFilters().CountAsync(m => m.TenantId == club.Club.TenantId),
            await db.LedgerEntries.IgnoreQueryFilters().CountAsync(l => l.TenantId == club.Club.TenantId),
            await db.Bookings.IgnoreQueryFilters().CountAsync(b => b.TenantId == club.Club.TenantId),
        });
        var before = await Counts();

        var (_, member) = await IntoMemberViewAsync(app, club);
        var client = DemoClub.Bearer(app, member);
        // The persona reads its own wallet and nothing of the real club's rows is added or moved.
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/v1/wallet")).StatusCode);
        Assert.Equal(before, await Counts());

        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Persistence.MainframeDbContext>();
            await db.Users.IgnoreQueryFilters().Where(u => u.Id == club.AdminId)
                .ExecuteUpdateAsync(u => u.SetProperty(x => x.SessionEpoch, x => x.SessionEpoch + 1));
        }
        var closed = await client.PostAsJsonAsync("/api/v1/me/demo/mode", new { mode = "live" });
        Assert.Equal(HttpStatusCode.Unauthorized, closed.StatusCode);
        Assert.Equal("session_ended", (await JsonAsync(closed)).GetProperty("error").GetString());
    }
}
