using System.Net;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A token whose subject has no account in the club it names is not a session. Found in a headed
/// walk after the local database was wiped: the browser's old token was still accepted —
/// <c>/me/profile</c> answered 404 while <c>/me/notifications/unread-count</c> and <c>/me/door</c>
/// answered 200, because the session-epoch check read a missing row as epoch 0. Every route must
/// answer the same 401, so the PWA ends the session instead of rendering a half-working app.
/// </summary>
public sealed class SessionAccountGoneHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    [SkippableFact]
    public async Task A_token_for_an_account_that_was_deleted_is_refused_on_every_route()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "gonerow");

        // A real sign-in, then the row goes — as it does when the database is wiped under a browser.
        var goneId = await club.ReadAsync(app, db => AddBareMemberAsync(db, club, "gone"));
        var token = await club.LoginAsync(app, "gone");
        await club.WriteAsync(app, async db =>
        {
            await db.Memberships.IgnoreQueryFilters().Where(m => m.UserId == goneId).ExecuteDeleteAsync();
            await db.Users.IgnoreQueryFilters().Where(u => u.Id == goneId).ExecuteDeleteAsync();
        });

        await AssertRefusedEverywhereAsync(app, club, club.Bearer(app, token), goneId);
    }

    [SkippableFact]
    public async Task A_token_from_another_database_naming_no_account_here_is_refused_on_every_route()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "foreignrow");

        var stranger = Guid.NewGuid();
        var jwt = app.Services.GetRequiredService<IJwtIssuer>();
        var token = jwt.IssueAccess(stranger, club.TenantId, club.Slug, ["admin"], 0);

        var client = club.Bearer(app, token);
        await AssertRefusedEverywhereAsync(app, club, client, stranger);
        // It claims admin: refused as unauthenticated, not stripped to a member and answered 403.
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/admin/members")).StatusCode);

        // The refusal is not sticky for anyone else: a real member is still let in.
        Assert.Equal(HttpStatusCode.OK, (await club.Member(app, club.Pam).GetAsync("/api/v1/me/profile")).StatusCode);
    }

    /// <summary>
    /// The account exists — in ANOTHER club. The token's tenant is part of who it names: a user id
    /// is an account only in the club it was minted for (the lookup the epoch check already made,
    /// whose empty answer was read as epoch 0).
    /// </summary>
    [SkippableFact]
    public async Task A_token_naming_a_real_account_under_the_wrong_club_is_refused()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var home = await MemberCodeClub.SeedAsync(app, "homeclub");
        var other = await MemberCodeClub.SeedAsync(app, "otherclub");

        var jwt = app.Services.GetRequiredService<IJwtIssuer>();
        var client = other.Bearer(app, jwt.IssueAccess(home.Olga, other.TenantId, other.Slug, [], 0));

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/me/notifications/unread-count")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/wallet")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync("/api/v1/auth/refresh", null)).StatusCode);
    }

    private static async Task AssertRefusedEverywhereAsync(
        WebApplicationFactory<Program> app, MemberCodeClub club, HttpClient client, Guid subject)
    {
        foreach (var path in new[] { "/api/v1/me/profile", "/api/v1/me/notifications/unread-count", "/api/v1/me/door", "/api/v1/wallet" })
        {
            Assert.True(HttpStatusCode.Unauthorized == (await client.GetAsync(path)).StatusCode, $"GET {path} was not 401");
        }
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync("/api/v1/auth/refresh", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync("/api/v1/wallet/stream-ticket", null)).StatusCode);

        // A stream ticket already in hand for that subject opens nothing either.
        var ticket = app.Services.GetRequiredService<IJwtIssuer>().IssueOneTime(subject, club.TenantId, club.Slug,
            new TicketScope(TokenPurposes.WalletStream, TokenPurposes.WalletStreamTicketTtl), 0);
        var stream = await app.CreateClient().GetAsync($"/api/v1/wallet/stream?ticket={ticket}", HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal(HttpStatusCode.Unauthorized, stream.StatusCode);

        // Asked twice: the cached answer is the same refusal, not a pass.
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/me/door")).StatusCode);
    }

    private static async Task<Guid> AddBareMemberAsync(MainframeDbContext db, MemberCodeClub club, string handle)
    {
        var user = new User
        {
            TenantId = club.TenantId, Email = $"{handle}-{club.Slug}@test.local",
            PasswordHash = new Pbkdf2PasswordHasher().Hash("OldPass!123"), EmailVerified = true,
        };
        db.Users.Add(user);
        db.Memberships.Add(new Membership
        {
            TenantId = club.TenantId, UserId = user.Id, FullName = "Gone Member",
            MembershipNumber = $"{handle}-{club.Slug}", Status = MembershipStatus.Active,
        });
        await db.SaveChangesAsync();
        return user.Id;
    }
}
