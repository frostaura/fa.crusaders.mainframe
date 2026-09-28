using System.Net;
using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A rotation ends every session open when it happened (<c>docs/specs/member-code.md</c> §10,
/// §13) — the reviewer's lost-phone case: the desk resets the code, and the phone's signed-in PWA
/// must not be able to re-enrol and fetch the new secret. A member changing their own password
/// keeps the session they are in (a fresh token is handed back); sign-out-everywhere ends them all.
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class MemberCodeSessionHttpTests(PostgresFixture pg)
{
    [SkippableFact]
    public async Task A_lost_phone_is_signed_out_by_the_desks_reset_cannot_enrol_and_its_old_codes_are_refused()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "lostphone");

        // The phone that will be lost: signed in, enrolled, computing generation-1 codes.
        var lost = club.Bearer(app, await club.LoginAsync(app, "olga"));
        var enrolled = await MemberCodeClub.JsonAsync(await lost.PostAsync("/api/v1/me/code/enrol", null));
        var oldSecret = MemberCodeMath.FromBase64Url(enrolled.GetProperty("secret").GetString()!)!;

        var reset = await club.Member(app, club.AdminId, "admin").PostAsync($"/api/v1/admin/members/{club.OlgaMembership}/code/reset", null);
        Assert.Equal(HttpStatusCode.OK, reset.StatusCode);

        // Every route the lost phone could reach is closed — and above all it cannot re-enrol.
        Assert.Equal(HttpStatusCode.Unauthorized, (await lost.GetAsync("/api/v1/me/code")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await lost.PostAsync("/api/v1/me/code/enrol", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await lost.PostAsync("/api/v1/auth/refresh", null)).StatusCode);

        // The codes it can still compute open nothing.
        var oldCode = MemberCodeMath.Token(
            MemberCodeMath.RefText(club.Refs[club.Olga]), oldSecret, MemberCodeMath.StepOf(DateTimeOffset.UtcNow), MemberCodeMath.ZoneOf("Africa/Johannesburg"));
        var gate = await MemberCodeClub.JsonAsync(await app.CreateClient().SendAsync(club.Gate(oldCode)));
        Assert.False(gate.GetProperty("opened").GetBoolean());
        Assert.Equal("not_recognised", gate.GetProperty("reason").GetString());

        // Olga signs in again on her new phone and gets the new generation.
        var fresh = club.Bearer(app, await club.LoginAsync(app, "olga"));
        var again = await MemberCodeClub.JsonAsync(await fresh.PostAsync("/api/v1/me/code/enrol", null));
        Assert.Equal(2, again.GetProperty("generation").GetInt32());
    }

    /// <summary>
    /// The middleware answers from a fifteen-second cache; enrolment and refresh must not, because
    /// one hands out the secret and the other mints a token that would pass every later check.
    /// The cut-off is written straight to the row here, so nothing evicted the cache.
    /// </summary>
    [SkippableFact]
    public async Task Enrolment_and_refresh_read_the_cut_off_from_the_row_not_the_cache()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "cutrow");

        var phone = club.Bearer(app, await club.LoginAsync(app, "olga"));
        Assert.Equal(HttpStatusCode.OK, (await phone.GetAsync("/api/v1/me/code")).StatusCode); // warms the cache

        await club.WriteAsync(app, async db =>
            (await db.Users.IgnoreQueryFilters().FirstAsync(u => u.Id == club.Olga)).SessionsValidAfter = SessionCutoff.StampNow().AddMilliseconds(1));

        Assert.Equal(HttpStatusCode.Unauthorized, (await phone.PostAsync("/api/v1/me/code/enrol", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await phone.PostAsync("/api/v1/auth/refresh", null)).StatusCode);

        // And the service itself, whatever route reaches it.
        using var scope = app.Services.CreateScope();
        var auth = scope.ServiceProvider.GetRequiredService<AuthService>();
        scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>().Set(club.TenantId, club.Slug);
        Assert.IsType<LoginResult.InvalidCredentials>(await auth.RefreshAsync(club.Olga, DateTimeOffset.UtcNow.AddMinutes(-1), default));
        Assert.IsType<LoginResult.Ok>(await auth.RefreshAsync(club.Olga, DateTimeOffset.UtcNow.AddSeconds(1), default));
    }

    [SkippableFact]
    public async Task Changing_the_password_keeps_the_callers_session_on_a_new_token_and_ends_every_other()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "pwkeep");

        var here = club.Bearer(app, await club.LoginAsync(app, "olga"));
        var elsewhere = club.Bearer(app, await club.LoginAsync(app, "olga"));

        var changed = await here.PostAsJsonAsync("/api/v1/me/password", new { currentPassword = "OldPass!123", newPassword = "NewPass!456" });
        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);
        var body = await MemberCodeClub.JsonAsync(changed);
        Assert.True(body.GetProperty("changed").GetBoolean());
        var reissued = body.GetProperty("access_token").GetString()!;

        Assert.Equal(HttpStatusCode.Unauthorized, (await here.GetAsync("/api/v1/me/code")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await elsewhere.GetAsync("/api/v1/me/code")).StatusCode);

        var kept = club.Bearer(app, reissued);
        var status = await MemberCodeClub.JsonAsync(await kept.GetAsync("/api/v1/me/code"));
        Assert.Equal(2, status.GetProperty("generation").GetInt32());
        Assert.Equal(HttpStatusCode.OK, (await kept.PostAsync("/api/v1/me/code/enrol", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await kept.PostAsync("/api/v1/auth/refresh", null)).StatusCode);
    }

    [SkippableFact]
    public async Task Sign_out_everywhere_ends_every_session_including_the_callers_and_rotates()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "revokeall");

        var here = club.Bearer(app, await club.LoginAsync(app, "pam"));
        var elsewhere = club.Bearer(app, await club.LoginAsync(app, "pam"));

        Assert.Equal(HttpStatusCode.NoContent, (await here.PostAsync("/api/v1/me/sessions/revoke-all", null)).StatusCode);

        Assert.Equal(HttpStatusCode.Unauthorized, (await here.GetAsync("/api/v1/me/code")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await elsewhere.GetAsync("/api/v1/me/code")).StatusCode);
        Assert.Equal(2, await club.ReadAsync(app, db => db.MemberCodes.IgnoreQueryFilters().Where(c => c.UserId == club.Pam).Select(c => c.Generation).FirstAsync()));

        var audit = await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .FirstAsync(a => a.TenantId == club.TenantId && a.Action == MemberCodeService.RotatedAction && a.SubjectUserId == club.Pam));
        Assert.Contains("sign_out_everywhere", audit.DetailsJson);

        // Signing in again is a new session and works.
        var back = club.Bearer(app, await club.LoginAsync(app, "pam"));
        Assert.Equal(HttpStatusCode.OK, (await back.GetAsync("/api/v1/me/code")).StatusCode);

        // Anonymous is refused, and another member's sessions are untouched.
        var anonymous = app.CreateClient();
        anonymous.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsync("/api/v1/me/sessions/revoke-all", null)).StatusCode);
        Assert.Null(await club.ReadAsync(app, db => db.Users.IgnoreQueryFilters().Where(u => u.Id == club.Olga).Select(u => u.SessionsValidAfter).FirstAsync()));
    }

    [SkippableFact]
    public async Task A_suspension_ends_the_members_open_sessions()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "suspsess");

        var sid = club.Bearer(app, await club.LoginAsync(app, "sid"));
        Assert.Equal(HttpStatusCode.OK, (await sid.GetAsync("/api/v1/me/code")).StatusCode);

        var suspend = await club.Member(app, club.AdminId, "admin").PostAsJsonAsync($"/api/v1/admin/members/{club.SidMembership}/suspend", new { reason = "dues" });
        Assert.Equal(HttpStatusCode.OK, suspend.StatusCode);

        Assert.Equal(HttpStatusCode.Unauthorized, (await sid.GetAsync("/api/v1/me/code")).StatusCode);
    }
}
