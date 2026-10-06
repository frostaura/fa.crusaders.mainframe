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
/// Demo mode over HTTP: the admin's switch is a session swap into a second tenant, a demo session
/// can read nothing of the real club, members cannot switch, the way back leads only to the admin
/// who came in, and nothing in the demo mails anybody or reaches PayFast or a device key.
/// </summary>
public sealed class DemoModeHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public DemoModeHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    /// <summary>The app with its mail going to <paramref name="mail"/> through the same demo lock the app wraps SMTP in.</summary>
    private static WebApplicationFactory<Program> Wired(TestWebAppFactory factory, StubEmailService mail) =>
        factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEmailService>();
            s.AddSingleton<IEmailService>(new DemoAwareEmailService(mail, NullLogger<DemoAwareEmailService>.Instance));
        }));

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage r) => JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;

    [SkippableFact]
    public async Task An_admin_switches_into_the_demo_and_back_and_each_crossing_is_on_the_real_record()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var app = Wired(_pg.SharedHost, new StubEmailService());
        var club = await DemoClub.SeedAsync(app, "switch");

        var entered = await DemoClub.SwitchAsync(club.Admin(app), "demo");
        Assert.Equal("demo", entered.GetProperty("mode").GetString());
        var demoToken = entered.GetProperty("access_token").GetString()!;
        var demo = await club.DemoAsync(app);
        Assert.Equal(demo.Slug, DemoClub.SlugOf(demoToken));
        Assert.NotEqual(club.AdminId, DemoClub.SubjectOf(demoToken));
        Assert.Null(demo.DeviceApiKey);

        var mode = await JsonAsync(await DemoClub.Bearer(app, demoToken).GetAsync("/api/v1/admin/mode"));
        Assert.Equal("demo", mode.GetProperty("mode").GetString());
        Assert.Equal("switch club", mode.GetProperty("club_name").GetString());

        var back = await DemoClub.SwitchAsync(DemoClub.Bearer(app, demoToken), "live");
        var liveToken = back.GetProperty("access_token").GetString()!;
        Assert.Equal(club.Club.Slug, DemoClub.SlugOf(liveToken));
        Assert.Equal(club.AdminId, DemoClub.SubjectOf(liveToken));

        var actions = await PeopleClub.ReadAsync(app, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(c => c.TenantId == club.Club.TenantId).OrderBy(c => c.OccurredAt).Select(c => c.Action).ToListAsync());
        Assert.Equal(new[] { AdminChangeActions.DemoEntered, AdminChangeActions.DemoLeft }, actions);
    }

    [SkippableFact]
    public async Task A_demo_session_reads_only_the_demo_and_never_a_real_row()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var app = Wired(_pg.SharedHost, new StubEmailService());
        var club = await DemoClub.SeedAsync(app, "isolate");
        var demoToken = (await DemoClub.SwitchAsync(club.Admin(app), "demo")).GetProperty("access_token").GetString()!;
        var client = DemoClub.Bearer(app, demoToken);

        var members = await client.GetStringAsync("/api/v1/admin/members?limit=200");
        Assert.DoesNotContain("Mo Member", members, StringComparison.Ordinal);
        Assert.DoesNotContain(club.MemberId.ToString(), members, StringComparison.Ordinal);
        Assert.Contains(DemoTenants.EmailDomain, members, StringComparison.Ordinal);

        // The real member's own record, asked for by id from the demo: not there.
        var detail = await client.GetAsync($"/api/v1/admin/members/{club.MemberId}");
        Assert.Equal(HttpStatusCode.NotFound, detail.StatusCode);
    }

    [SkippableFact]
    public async Task A_member_cannot_switch_and_a_demo_club_cannot_be_reached_by_its_host_name()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var app = Wired(_pg.SharedHost, new StubEmailService());
        var club = await DemoClub.SeedAsync(app, "member");

        var refused = await club.Club.Client(app, club.MemberId, adminRole: false).PostAsJsonAsync("/api/v1/admin/mode", new { mode = "demo" });
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.False(await PeopleClub.ReadAsync(app, db => db.Tenants.AnyAsync(t => t.DemoOfTenantId == club.Club.TenantId)));

        var token = (await DemoClub.SwitchAsync(club.Admin(app), "demo")).GetProperty("access_token").GetString()!;
        var demo = await club.DemoAsync(app);

        // Anonymous, by the demo's own host name: no such club.
        var anonymous = app.CreateClient();
        anonymous.DefaultRequestHeaders.Host = $"{demo.Slug}.crusaders.test";
        var probe = await anonymous.PostAsJsonAsync("/api/v1/auth/login", new { email = "x@y.z", password = "whatever-long" });
        Assert.Equal(HttpStatusCode.NotFound, probe.StatusCode);

        // The demo token on its own club's address is the admin still on the club's site: accepted.
        var onClubHost = DemoClub.Bearer(app, token);
        onClubHost.DefaultRequestHeaders.Host = $"{club.Club.Slug}.crusaders.test";
        Assert.Equal(HttpStatusCode.OK, (await onClubHost.GetAsync("/api/v1/admin/mode")).StatusCode);

        // ...and on some other club's address it is the mismatch it always was.
        var other = await PeopleClub.SeedAsync(app, "other");
        var onOtherHost = DemoClub.Bearer(app, token);
        onOtherHost.DefaultRequestHeaders.Host = $"{other.Slug}.crusaders.test";
        Assert.Equal(HttpStatusCode.Forbidden, (await onOtherHost.GetAsync("/api/v1/admin/mode")).StatusCode);
    }

    [SkippableFact]
    public async Task The_way_back_is_closed_once_the_real_sessions_were_ended()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var app = Wired(_pg.SharedHost, new StubEmailService());
        var club = await DemoClub.SeedAsync(app, "epoch");
        var token = (await DemoClub.SwitchAsync(club.Admin(app), "demo")).GetProperty("access_token").GetString()!;

        // "Sign out everywhere" in the real club, while the demo session is open.
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Persistence.MainframeDbContext>();
            await db.Users.IgnoreQueryFilters().Where(u => u.Id == club.AdminId)
                .ExecuteUpdateAsync(u => u.SetProperty(x => x.SessionEpoch, x => x.SessionEpoch + 1));
        }

        var back = await DemoClub.Bearer(app, token).PostAsJsonAsync("/api/v1/admin/mode", new { mode = "live" });
        Assert.Equal(HttpStatusCode.Unauthorized, back.StatusCode);
        Assert.Equal("session_ended", (await JsonAsync(back)).GetProperty("error").GetString());
    }

    [SkippableFact]
    public async Task Nothing_in_the_demo_mails_anybody_takes_money_or_hands_out_a_device_key()
    {
        Skip.IfNot(_pg.Available, Skipped);
        var mail = new StubEmailService();
        await using var app = Wired(_pg.SharedHost, mail);
        var club = await DemoClub.SeedAsync(app, "silent");
        var token = (await DemoClub.SwitchAsync(club.Admin(app), "demo")).GetProperty("access_token").GetString()!;
        var client = DemoClub.Bearer(app, token);
        var demo = await club.DemoAsync(app);
        mail.Clear();

        // Approving a made-up applicant — a member-affecting event that mails in a real club.
        var applicant = await PeopleClub.ReadAsync(app, db => db.Memberships.IgnoreQueryFilters()
            .Where(m => m.TenantId == demo.Id && m.Status == MembershipStatus.PendingApproval).Select(m => m.Id).FirstAsync());
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync($"/api/v1/admin/members/{applicant}/approve", null)).StatusCode);

        // A purchase completes on the spot as a simulation; no gateway form is handed out.
        var shelf = await JsonAsync(await client.GetAsync("/api/v1/minutes/packages"));
        var package = shelf.GetProperty("packages")[0];
        var bought = await client.PostAsJsonAsync("/api/v1/minutes/purchase", new
        {
            packageId = package.GetProperty("id").GetGuid(),
            quotedPriceZar = package.GetProperty("price_zar").GetDecimal(),
        });
        Assert.Equal(HttpStatusCode.OK, bought.StatusCode);
        var purchase = await JsonAsync(bought);
        Assert.True(purchase.GetProperty("simulated").GetBoolean());
        Assert.Equal(0, purchase.GetProperty("form_fields").GetArrayLength());
        var status = await JsonAsync(await client.GetAsync($"/api/v1/minutes/purchase/{purchase.GetProperty("purchase_id").GetGuid()}"));
        Assert.Equal("Completed", status.GetProperty("status").GetString());

        // The device key: refused, and none was minted.
        Assert.Equal(HttpStatusCode.Conflict, (await client.GetAsync("/api/v1/admin/devices/api-key")).StatusCode);
        Assert.Null((await club.DemoAsync(app)).DeviceApiKey);

        // The admin notices the demo raised are finished without a send.
        await PeopleClub.DeliverAdminNoticesAsync(app);
        await Task.Delay(300);
        Assert.Empty(mail.Sent);
        var pending = await PeopleClub.ReadAsync(app, db => db.AdminNotifications.IgnoreQueryFilters()
            .CountAsync(n => n.TenantId == demo.Id && n.State == AdminNotificationState.Pending));
        Assert.Equal(0, pending);

        // The same act in the real club does mail — the lock is the demo's, not a broken sender.
        var realUser = await club.Club.AddAsync(app, "Rita Real", isAdmin: false, membership: MembershipStatus.PendingApproval);
        var realApplicant = await PeopleClub.ReadAsync(app, db => db.Memberships.IgnoreQueryFilters().Where(m => m.UserId == realUser).Select(m => m.Id).FirstAsync());
        Assert.Equal(HttpStatusCode.OK, (await club.Admin(app).PostAsync($"/api/v1/admin/members/{realApplicant}/approve", null)).StatusCode);
        Assert.NotNull(await mail.WaitFor(m => m.To.Contains("rita.real", StringComparison.Ordinal), 5000));
    }
}
