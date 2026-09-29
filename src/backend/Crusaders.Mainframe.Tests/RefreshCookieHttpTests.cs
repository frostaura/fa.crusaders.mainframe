using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Security;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 1, B1: "signed out after 15 idle minutes, even at the door". A sign-in sets an
/// httpOnly rotating refresh cookie; <c>POST /auth/refresh</c> exchanges it — with no bearer at all
/// — for a new access token and a rotated cookie. Pinned here: the cookie's attributes, hashing at
/// rest, rotation, replay revoking the family, the concurrent-tab grace, every epoch raise ending
/// the family, sign-out, expiry, and the club boundary.
/// </summary>
public sealed class RefreshCookieHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Cookie = RefreshSessions.CookieName;

    private sealed class MovableClock : TimeProvider
    {
        // Whole microseconds: timestamptz keeps no more, so a read-back compares equal.
        public DateTimeOffset Now { get; set; } = new(DateTimeOffset.UtcNow.Ticks / 10 * 10, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed record Harness(WebApplicationFactory<Program> App, MemberCodeClub Club, MovableClock Clock, TestWebAppFactory Factory) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await App.DisposeAsync();
            await Factory.DisposeAsync();
        }

        /// <summary>A client with NO cookie jar — every cookie a test sends is one it chose to send.</summary>
        public HttpClient Client(string? slug = null)
        {
            var client = App.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false });
            client.DefaultRequestHeaders.Host = $"{slug ?? Club.Slug}.crusaders.test";
            return client;
        }
    }

    private async Task<Harness> StartAsync(string prefix)
    {
        var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var clock = new MovableClock();
        var app = factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<Crusaders.Mainframe.Api.Email.IEmailService>();
            s.AddSingleton<Crusaders.Mainframe.Api.Email.IEmailService>(new StubEmailService());
            s.RemoveAll<TimeProvider>();
            s.AddSingleton<TimeProvider>(clock);
        }));
        var club = await MemberCodeClub.SeedAsync(app, prefix);
        return new Harness(app, club, clock, factory);
    }

    private static StringContent Json(JsonObject body) => new(body.ToJsonString(), Encoding.UTF8, "application/json");

    private static async Task<(HttpResponseMessage Response, string? Cookie)> LoginAsync(Harness h, string handle, string password = "OldPass!123")
    {
        var response = await h.Client().PostAsync("/api/v1/auth/login",
            Json(new JsonObject { ["email"] = $"{handle}-{h.Club.Slug}@test.local", ["password"] = password }));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (response, CookieValue(response));
    }

    private static string? SetCookieLine(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Set-Cookie", out var lines)
            ? lines.FirstOrDefault(l => l.StartsWith(Cookie + "=", StringComparison.Ordinal))
            : null;

    /// <summary>The value the response set, or null when it set none (an empty value — a clear — is "").</summary>
    private static string? CookieValue(HttpResponseMessage response)
    {
        var line = SetCookieLine(response);
        return line?[(Cookie.Length + 1)..].Split(';')[0];
    }

    private static Task<HttpResponseMessage> RefreshAsync(Harness h, string? cookie, string? bearer = null, string? slug = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/refresh");
        if (cookie is not null) request.Headers.Add("Cookie", $"{Cookie}={cookie}");
        if (bearer is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        return h.Client(slug).SendAsync(request);
    }

    private static async Task<string> AccessTokenOf(HttpResponseMessage response) =>
        (await MemberCodeClub.JsonAsync(response)).GetProperty("access_token").GetString()!;

    private static async Task<string> ErrorOf(HttpResponseMessage response) =>
        (await MemberCodeClub.JsonAsync(response)).GetProperty("error").GetString()!;

    [SkippableFact]
    public async Task Sign_in_sets_an_httponly_strict_secure_cookie_on_the_auth_path_stored_only_as_a_hash()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var h = await StartAsync("rtattrs");

        var (response, cookie) = await LoginAsync(h, "olga");
        var line = SetCookieLine(response)!.ToLowerInvariant();
        Assert.NotNull(cookie);
        Assert.True(cookie!.Length >= 40);
        Assert.Contains("httponly", line);
        Assert.Contains("samesite=strict", line);
        Assert.Contains("secure", line);                 // Testing is not Development
        Assert.Contains("path=/api/v1/auth", line);
        Assert.Contains($"max-age={(int)TimeSpan.FromDays(30).TotalSeconds}", line);

        var rows = await h.Club.ReadAsync(h.App, db => db.RefreshTokens.IgnoreQueryFilters().Where(t => t.UserId == h.Club.Olga).ToListAsync());
        var row = Assert.Single(rows);
        Assert.Equal(TokenHashing.Hash(cookie), row.TokenHash);
        Assert.NotEqual(cookie, row.TokenHash);
        Assert.Equal(h.Club.TenantId, row.TenantId);
        Assert.Equal(h.Clock.Now.AddDays(30), row.ExpiresAt);
    }

    [SkippableFact]
    public async Task The_cookie_alone_refreshes_an_idle_session_and_rotates_with_a_sliding_expiry()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var h = await StartAsync("rtrotate");
        var (_, first) = await LoginAsync(h, "olga");

        h.Clock.Now = h.Clock.Now.AddDays(20);           // long past the access token's 15 minutes
        var refreshed = await RefreshAsync(h, first);
        Assert.Equal(HttpStatusCode.OK, refreshed.StatusCode);
        var second = CookieValue(refreshed);
        Assert.False(string.IsNullOrEmpty(second));
        Assert.NotEqual(first, second);

        // The new access token is a real session.
        var member = h.Club.Bearer(h.App, await AccessTokenOf(refreshed));
        Assert.Equal(HttpStatusCode.OK, (await member.GetAsync("/api/v1/me/profile")).StatusCode);

        // Sliding: the successor lives 30 days from NOW, in the same family.
        var rows = await h.Club.ReadAsync(h.App, db => db.RefreshTokens.IgnoreQueryFilters().Where(t => t.UserId == h.Club.Olga).OrderBy(t => t.IssuedAt).ToListAsync());
        Assert.Equal(2, rows.Count);
        Assert.Equal(rows[0].FamilyId, rows[1].FamilyId);
        Assert.NotNull(rows[0].UsedAt);
        Assert.Equal(h.Clock.Now.AddDays(30), rows[1].ExpiresAt);

        h.Clock.Now = h.Clock.Now.AddDays(25);           // 45 days after sign-in, still alive by sliding
        Assert.Equal(HttpStatusCode.OK, (await RefreshAsync(h, second)).StatusCode);
    }

    [SkippableFact]
    public async Task A_replayed_cookie_revokes_the_whole_family_and_clears_the_cookie()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var h = await StartAsync("rtreplay");
        var (_, stolen) = await LoginAsync(h, "olga");

        var legit = await RefreshAsync(h, stolen);
        Assert.Equal(HttpStatusCode.OK, legit.StatusCode);
        var successor = CookieValue(legit)!;

        h.Clock.Now = h.Clock.Now.Add(RefreshSessions.ReuseGrace).AddSeconds(1);
        var replay = await RefreshAsync(h, stolen);
        Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);
        Assert.Equal("session_ended", await ErrorOf(replay));
        Assert.Equal("", CookieValue(replay));        // cleared

        // The successor the real holder has is dead too — both sign in again.
        var after = await RefreshAsync(h, successor);
        Assert.Equal(HttpStatusCode.Unauthorized, after.StatusCode);
        Assert.True(await h.Club.ReadAsync(h.App, db => db.RefreshTokens.IgnoreQueryFilters()
            .Where(t => t.UserId == h.Club.Olga).AllAsync(t => t.RevokedAt != null || t.UsedAt != null)));
    }

    [SkippableFact]
    public async Task A_second_tab_presenting_a_just_spent_cookie_is_refused_without_revoking_or_clearing()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var h = await StartAsync("rtgrace");
        var (_, cookie) = await LoginAsync(h, "olga");

        var winner = await RefreshAsync(h, cookie);
        Assert.Equal(HttpStatusCode.OK, winner.StatusCode);

        var loser = await RefreshAsync(h, cookie);
        Assert.Equal(HttpStatusCode.Unauthorized, loser.StatusCode);
        Assert.Equal("refresh_superseded", await ErrorOf(loser));
        Assert.Null(SetCookieLine(loser));             // must not delete the winner's cookie
        Assert.Equal(HttpStatusCode.OK, (await RefreshAsync(h, CookieValue(winner))).StatusCode);
    }

    [SkippableFact]
    public async Task Concurrent_presentations_of_one_cookie_mint_exactly_once()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var h = await StartAsync("rtrace");
        var (_, cookie) = await LoginAsync(h, "olga");

        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => RefreshAsync(h, cookie)));
        Assert.Equal(1, results.Count(r => r.StatusCode == HttpStatusCode.OK));
        Assert.All(results.Where(r => r.StatusCode != HttpStatusCode.OK), r => Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode));
        Assert.Equal(2, await h.Club.ReadAsync(h.App, db => db.RefreshTokens.IgnoreQueryFilters().CountAsync(t => t.UserId == h.Club.Olga)));
    }

    [SkippableFact]
    public async Task Every_epoch_raise_ends_the_family_sign_out_everywhere_desk_reset_and_password_reset()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var h = await StartAsync("rtepoch");

        // Sign out everywhere.
        var (login, cookie) = await LoginAsync(h, "olga");
        Assert.Equal(HttpStatusCode.OK, (await h.Club.Bearer(h.App, await AccessTokenOf(login)).PostAsync("/api/v1/me/sessions/revoke-all", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshAsync(h, cookie)).StatusCode);

        // The desk's code reset (the lost phone).
        (_, cookie) = await LoginAsync(h, "olga");
        Assert.Equal(HttpStatusCode.OK, (await h.Club.Member(h.App, h.Club.AdminId, "admin")
            .PostAsync($"/api/v1/admin/members/{h.Club.OlgaMembership}/code/reset", Json(new JsonObject { ["reason"] = "lost phone" }))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshAsync(h, cookie)).StatusCode);

        // An epoch raised behind the service's back (the check is the epoch, not the revoke stamp).
        (_, cookie) = await LoginAsync(h, "pam");
        await h.Club.WriteAsync(h.App, async db => (await db.Users.IgnoreQueryFilters().FirstAsync(u => u.Id == h.Club.Pam)).SessionEpoch += 1);
        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshAsync(h, cookie)).StatusCode);
    }

    [SkippableFact]
    public async Task A_password_change_kills_the_old_cookie_and_hands_the_member_a_new_one()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var h = await StartAsync("rtpwchg");
        var (login, old) = await LoginAsync(h, "olga");

        var change = await h.Club.Bearer(h.App, await AccessTokenOf(login)).PostAsync("/api/v1/me/password",
            Json(new JsonObject { ["currentPassword"] = "OldPass!123", ["newPassword"] = "NewPass!456" }));
        Assert.Equal(HttpStatusCode.OK, change.StatusCode);
        var fresh = CookieValue(change);
        Assert.False(string.IsNullOrEmpty(fresh));

        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshAsync(h, old)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await RefreshAsync(h, fresh)).StatusCode);
    }

    [SkippableFact]
    public async Task A_suspended_member_gets_nothing_and_the_family_is_revoked()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var h = await StartAsync("rtsusp");
        var (_, cookie) = await LoginAsync(h, "sid");

        // Suspended straight on the row: the refresh test itself, not the rotation, refuses it.
        await h.Club.WriteAsync(h.App, async db =>
            (await db.Memberships.IgnoreQueryFilters().FirstAsync(m => m.Id == h.Club.SidMembership)).Status = MembershipStatus.Suspended);
        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshAsync(h, cookie)).StatusCode);
        Assert.True(await h.Club.ReadAsync(h.App, db => db.RefreshTokens.IgnoreQueryFilters()
            .Where(t => t.UserId == h.Club.Sid).AllAsync(t => t.RevokedAt != null)));
    }

    [SkippableFact]
    public async Task Sign_out_with_only_the_cookie_revokes_its_family_and_clears_it()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var h = await StartAsync("rtlogout");
        var (_, cookie) = await LoginAsync(h, "olga");
        var (_, otherDevice) = await LoginAsync(h, "olga");

        var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/logout");
        request.Headers.Add("Cookie", $"{Cookie}={cookie}");
        var response = await h.Client().SendAsync(request);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal("", CookieValue(response));

        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshAsync(h, cookie)).StatusCode);
        // Only this device's family: the phone in the other hand stays signed in.
        Assert.Equal(HttpStatusCode.OK, (await RefreshAsync(h, otherDevice)).StatusCode);
    }

    [SkippableFact]
    public async Task An_expired_cookie_mints_nothing()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var h = await StartAsync("rtexpire");
        var (_, cookie) = await LoginAsync(h, "olga");

        h.Clock.Now = h.Clock.Now.AddDays(30).AddSeconds(1);
        var response = await RefreshAsync(h, cookie);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("", CookieValue(response));
    }

    [SkippableFact]
    public async Task Another_clubs_cookie_is_unknown_here_and_its_family_is_untouched()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var h = await StartAsync("rtcluba");
        var other = await MemberCodeClub.SeedAsync(h.App, "rtclubb");
        var (_, cookie) = await LoginAsync(h, "olga");

        var elsewhere = await RefreshAsync(h, cookie, slug: other.Slug);
        Assert.Equal(HttpStatusCode.Unauthorized, elsewhere.StatusCode);
        Assert.Equal("session_ended", await ErrorOf(elsewhere));

        // Nothing in club A moved: not spent, not revoked, still exchanges at home.
        var row = await h.Club.ReadAsync(h.App, db => db.RefreshTokens.IgnoreQueryFilters().SingleAsync(t => t.UserId == h.Club.Olga));
        Assert.Null(row.UsedAt);
        Assert.Null(row.RevokedAt);
        Assert.Equal(HttpStatusCode.OK, (await RefreshAsync(h, cookie)).StatusCode);

        // And a sign-out at club B with club A's cookie revokes nothing.
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/logout");
        request.Headers.Add("Cookie", $"{Cookie}={cookie}");
        var b = h.Client(other.Slug);
        await b.SendAsync(request);
        Assert.False(await h.Club.ReadAsync(h.App, db => db.RefreshTokens.IgnoreQueryFilters()
            .AnyAsync(t => t.UserId == h.Club.Olga && t.RevokedAt != null)));
    }

    [SkippableFact]
    public async Task A_garbage_or_missing_cookie_is_401_and_a_bearer_refresh_starts_a_family_only_when_there_is_none()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var h = await StartAsync("rtbearer");

        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshAsync(h, null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await RefreshAsync(h, "not-a-real-token")).StatusCode);

        var (login, cookie) = await LoginAsync(h, "olga");
        var bearer = await AccessTokenOf(login);

        var withCookie = await RefreshAsync(h, cookie, bearer);
        Assert.Equal(HttpStatusCode.OK, withCookie.StatusCode);
        Assert.Null(SetCookieLine(withCookie));        // the bearer path leaves an existing cookie alone

        var legacy = await RefreshAsync(h, null, bearer);  // a session from before B1: no cookie
        Assert.Equal(HttpStatusCode.OK, legacy.StatusCode);
        Assert.False(string.IsNullOrEmpty(CookieValue(legacy)));
    }
}
