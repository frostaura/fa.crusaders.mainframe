using System.Net;
using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
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
    /// The epoch is raised straight on the row here, so nothing evicted the cache.
    /// </summary>
    [SkippableFact]
    public async Task Enrolment_and_refresh_read_the_epoch_from_the_row_not_the_cache()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "cutrow");

        var phone = club.Bearer(app, await club.LoginAsync(app, "olga"));
        Assert.Equal(HttpStatusCode.OK, (await phone.GetAsync("/api/v1/me/code")).StatusCode); // warms the cache

        await club.WriteAsync(app, async db => (await db.Users.IgnoreQueryFilters().FirstAsync(u => u.Id == club.Olga)).SessionEpoch = 1);

        Assert.Equal(HttpStatusCode.Unauthorized, (await phone.PostAsync("/api/v1/me/code/enrol", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await phone.PostAsync("/api/v1/auth/refresh", null)).StatusCode);

        // And the service itself, whatever route reaches it.
        using var scope = app.Services.CreateScope();
        var auth = scope.ServiceProvider.GetRequiredService<AuthService>();
        scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>().Set(club.TenantId, club.Slug);
        Assert.IsType<LoginResult.InvalidCredentials>(await auth.RefreshAsync(club.Olga, 0, default));
        Assert.IsType<LoginResult.Ok>(await auth.RefreshAsync(club.Olga, 1, default));
    }

    /// <summary>
    /// Refuted 2026-09-28 against the time cut-off: a refresh landing inside a rotation — after it
    /// started, before it committed — read no cut-off and minted a token that survived it, which
    /// then enrolled for the new secret. The epoch is raised the moment the rotation begins, so a
    /// refresh or an enrolment inside that window is refused, and a token refreshed just BEFORE it
    /// dies with the rest.
    /// </summary>
    [SkippableFact]
    public async Task A_refresh_inside_a_rotation_in_flight_mints_nothing_that_survives_it()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "refrace");

        var phone = club.Bearer(app, await club.LoginAsync(app, "olga"));
        var refreshedBefore = club.Bearer(app, (await MemberCodeClub.JsonAsync(await phone.PostAsync("/api/v1/auth/refresh", null)))
            .GetProperty("access_token").GetString()!);

        // The rotation begins — and has NOT committed its new generation.
        using var rotation = app.Services.CreateScope();
        rotation.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>().Set(club.TenantId, club.Slug);
        var codes = rotation.ServiceProvider.GetRequiredService<MemberCodeService>();
        Assert.True(await codes.StageRotationAsync(club.Olga, club.AdminId, "admin_reset", default));

        Assert.Equal(HttpStatusCode.Unauthorized, (await phone.PostAsync("/api/v1/auth/refresh", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await phone.PostAsync("/api/v1/me/code/enrol", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await refreshedBefore.GetAsync("/api/v1/me/code")).StatusCode);

        // The rotation commits; still nothing of the old session survives, and a new sign-in enrols the new generation.
        await rotation.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Persistence.MainframeDbContext>().SaveChangesAsync();
        Assert.Equal(HttpStatusCode.Unauthorized, (await refreshedBefore.PostAsync("/api/v1/me/code/enrol", null)).StatusCode);
        var fresh = club.Bearer(app, await club.LoginAsync(app, "olga"));
        Assert.Equal(2, (await MemberCodeClub.JsonAsync(await fresh.PostAsync("/api/v1/me/code/enrol", null))).GetProperty("generation").GetInt32());
    }

    /// <summary>A token that names no epoch — minted before epochs existed — is epoch 0: good until the first rotation, dead after it.</summary>
    [SkippableFact]
    public async Task A_token_with_no_epoch_is_epoch_zero()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "epochzero");

        var legacy = club.Member(app, club.Pam);   // hand-minted: no epoch claim
        Assert.Equal(HttpStatusCode.OK, (await legacy.GetAsync("/api/v1/me/code")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await legacy.PostAsync("/api/v1/me/sessions/revoke-all", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await legacy.GetAsync("/api/v1/me/code")).StatusCode);
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

        var revoked = await here.PostAsync("/api/v1/me/sessions/revoke-all", null);
        Assert.Equal(HttpStatusCode.OK, revoked.StatusCode);
        Assert.Equal("""{"signed_out":true,"passkeys_revoked":false,"passkeys_removed":0}""", await revoked.Content.ReadAsStringAsync());

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
        Assert.Equal(0, await club.ReadAsync(app, db => db.Users.IgnoreQueryFilters().Where(u => u.Id == club.Olga).Select(u => u.SessionEpoch).FirstAsync()));
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

    // ---- Passkeys (refute round 1, #2) ----------------------------------------------------------

    private static Task AddPasskeyAsync(MemberCodeClub club, Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> app, Guid user) =>
        club.WriteAsync(app, db =>
        {
            db.WebAuthnCredentials.Add(new WebAuthnCredential
            {
                TenantId = club.TenantId, UserId = user, CredentialId = Guid.NewGuid().ToByteArray(),
                PublicKey = [1, 2, 3], UserHandle = user.ToByteArray(),
            });
            return Task.CompletedTask;
        });

    private static Task<int> PasskeysAsync(MemberCodeClub club, Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> app, Guid user) =>
        club.ReadAsync(app, db => db.WebAuthnCredentials.IgnoreQueryFilters().CountAsync(c => c.UserId == user));

    /// <summary>
    /// The lost phone's passkey would sign straight back in under the new epoch and enrol for the
    /// new secret, so the desk's reset removes the member's passkeys unless told not to — and says so.
    /// </summary>
    [SkippableFact]
    public async Task The_desks_reset_removes_passkeys_by_default_and_says_so()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "resetpk");
        await AddPasskeyAsync(club, app, club.Olga);
        await AddPasskeyAsync(club, app, club.Olga);
        await AddPasskeyAsync(club, app, club.Pam);
        var admin = club.Member(app, club.AdminId, "admin");

        var reset = await MemberCodeClub.JsonAsync(await admin.PostAsync($"/api/v1/admin/members/{club.OlgaMembership}/code/reset", null));
        Assert.True(reset.GetProperty("passkeys_revoked").GetBoolean());
        Assert.Equal(2, reset.GetProperty("passkeys_removed").GetInt32());
        Assert.Equal(0, await PasskeysAsync(club, app, club.Olga));
        Assert.Equal(1, await PasskeysAsync(club, app, club.Pam));
        var audit = await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .SingleAsync(a => a.TenantId == club.TenantId && a.Action == MemberCodeService.PasskeysRevokedAction));
        Assert.Equal(club.Olga, audit.SubjectUserId);
        Assert.Equal(club.AdminId, audit.ActorUserId);

        await AddPasskeyAsync(club, app, club.Olga);
        var kept = await MemberCodeClub.JsonAsync(await admin.PostAsJsonAsync($"/api/v1/admin/members/{club.OlgaMembership}/code/reset", new { revoke_passkeys = false }));
        Assert.False(kept.GetProperty("passkeys_revoked").GetBoolean());
        Assert.Equal(1, await PasskeysAsync(club, app, club.Olga));
    }

    [SkippableFact]
    public async Task Sign_out_everywhere_keeps_passkeys_unless_asked()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "selfpk");
        await AddPasskeyAsync(club, app, club.Pam);

        await club.Bearer(app, await club.LoginAsync(app, "pam")).PostAsync("/api/v1/me/sessions/revoke-all", null);
        Assert.Equal(1, await PasskeysAsync(club, app, club.Pam));

        var asked = await MemberCodeClub.JsonAsync(await club.Bearer(app, await club.LoginAsync(app, "pam"))
            .PostAsJsonAsync("/api/v1/me/sessions/revoke-all", new { revoke_passkeys = true }));
        Assert.True(asked.GetProperty("passkeys_revoked").GetBoolean());
        Assert.Equal(1, asked.GetProperty("passkeys_removed").GetInt32());
        Assert.Equal(0, await PasskeysAsync(club, app, club.Pam));
    }

    // ---- Streams (refute round 1, #5) -----------------------------------------------------------

    /// <summary>A wallet stream opened under a session a rotation then ends closes on its next frame.</summary>
    [SkippableFact]
    public async Task An_open_wallet_stream_closes_when_a_rotation_ends_its_session()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "streamcut");
        var session = club.Bearer(app, await club.LoginAsync(app, "olga"));
        var ticket = (await MemberCodeClub.JsonAsync(await session.PostAsync("/api/v1/wallet/stream-ticket", null))).GetProperty("ticket").GetString()!;

        Crusaders.Mainframe.Api.Endpoints.WalletEndpoints.KeepAliveOverride = TimeSpan.FromMilliseconds(300);
        try
        {
            var client = app.CreateClient();
            client.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            using var request = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/wallet/stream?ticket={Uri.EscapeDataString(ticket)}");
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(cts.Token));
            Assert.StartsWith("data:", await reader.ReadLineAsync(cts.Token));

            var admin = club.Member(app, club.AdminId, "admin");
            Assert.Equal(HttpStatusCode.OK, (await admin.PostAsync($"/api/v1/admin/members/{club.OlgaMembership}/code/reset", null)).StatusCode);

            // The stream ENDS (null) — it does not ping on for ever.
            string? line;
            while ((line = await reader.ReadLineAsync(cts.Token)) is not null) { }
            Assert.Null(line);
        }
        finally
        {
            Crusaders.Mainframe.Api.Endpoints.WalletEndpoints.KeepAliveOverride = null;
        }
    }
}
