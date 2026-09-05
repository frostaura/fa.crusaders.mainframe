using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// What a sign-out actually ends, and what the wallet stream is allowed to be opened with.
///
/// <para>
/// Both are boundary facts and neither is visible from the service layer. Sign-out was a
/// client-side delete: the browser dropped its copy and the JWT stayed valid for the rest of
/// its lifetime, so a second tab kept working and anything that had captured the token — a
/// proxy log, most of all — outlived the sign-out completely. And the thing that reached those
/// logs was the full access token, because <c>EventSource</c> cannot set headers and the SSE
/// stream took <c>?access_token=</c>.
/// </para>
///
/// <para>
/// Postgres-backed, because the revocation has a durable half: the row in <c>auth_tokens</c> is
/// what stops a restart inside the token's lifetime from resurrecting a signed-out credential.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class SessionRevocationHttpTests
{
    private readonly PostgresFixture _pg;

    public SessionRevocationHttpTests(PostgresFixture pg) => _pg = pg;

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>
    /// A client that names the club in its Host header.
    ///
    /// <para>
    /// The tenant middleware sits in front of authentication, so a request that does not resolve
    /// a tenant is refused with <c>400 tenant_unresolved</c> before any token is even looked at.
    /// Without the subdomain, every assertion in this file would be measuring the wrong refusal.
    /// </para>
    /// </summary>
    private static HttpClient ClientFor(TestWebAppFactory factory, Club club)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";
        return client;
    }

    private sealed record Club(Guid TenantId, string Slug, Guid MemberId, string Email, string Password);

    private static async Task<Club> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();
        await db.Database.MigrateAsync();

        var slug = $"revo-{Guid.NewGuid():N}"[..18];
        var tenant = new Tenant { Slug = slug, DisplayName = "Revocation Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = """{"timezone":"UTC"}""" });

        const string password = "RevokeMe123!";
        var member = new User
        {
            TenantId = tenant.Id,
            Email = $"{slug}@test.local",
            PasswordHash = hasher.Hash(password),
            EmailVerified = true,
        };
        db.Users.Add(member);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = member.Id,
            FullName = "Revo Member",
            MembershipNumber = slug,
            Status = MembershipStatus.Active,
            MemberClass = MemberClass.Regular,
        });
        await db.SaveChangesAsync();

        return new Club(tenant.Id, slug, member.Id, member.Email, password);
    }

    private static async Task<string> SignInAsync(HttpClient client, Club club)
    {
        var response = await client.PostAsJsonAsync("/api/v1/auth/login", new { Email = club.Email, Password = club.Password });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        return body.GetProperty("access_token").GetString()!;
    }

    private static HttpRequestMessage Bearing(HttpMethod method, string path, string token)
    {
        var req = new HttpRequestMessage(method, path);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return req;
    }

    /// <summary>
    /// Asked at whoami rather than inferred from a status code: a refused token produces
    /// <c>400 tenant_unresolved</c> on most endpoints because the tenant middleware sits between
    /// authentication and authorisation and refuses first. Both are refusals; only one is
    /// evidence about the token.
    /// </summary>
    private static async Task<bool> AuthenticatesAsync(HttpClient client, string token)
    {
        var response = await client.SendAsync(Bearing(HttpMethod.Get, "/api/v1/whoami", token));
        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        return json.GetProperty("is_authenticated").GetBoolean();
    }

    [SkippableFact]
    public async Task Signing_out_stops_the_token_working()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var client = ClientFor(factory, club);

        var token = await SignInAsync(client, club);
        Assert.True(await AuthenticatesAsync(client, token));
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Bearing(HttpMethod.Get, "/api/v1/wallet", token))).StatusCode);

        var signOut = await client.SendAsync(Bearing(HttpMethod.Post, "/api/v1/auth/logout", token));
        Assert.Equal(HttpStatusCode.NoContent, signOut.StatusCode);

        // The whole point: the credential itself stops, not merely the browser's copy of it.
        Assert.False(await AuthenticatesAsync(client, token));
        Assert.NotEqual(HttpStatusCode.OK, (await client.SendAsync(Bearing(HttpMethod.Get, "/api/v1/wallet", token))).StatusCode);
        Assert.NotEqual(HttpStatusCode.OK, (await client.SendAsync(Bearing(HttpMethod.Get, "/api/v1/me/profile", token))).StatusCode);
    }

    [SkippableFact]
    public async Task Signing_out_one_session_leaves_the_others_alone()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var client = ClientFor(factory, club);

        var phone = await SignInAsync(client, club);
        var laptop = await SignInAsync(client, club);
        Assert.NotEqual(phone, laptop);

        await client.SendAsync(Bearing(HttpMethod.Post, "/api/v1/auth/logout", phone));

        Assert.False(await AuthenticatesAsync(client, phone));
        Assert.True(await AuthenticatesAsync(client, laptop));
    }

    [SkippableFact]
    public async Task A_revocation_is_written_down_so_a_restart_cannot_undo_it()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var client = ClientFor(factory, club);

        var token = await SignInAsync(client, club);
        await client.SendAsync(Bearing(HttpMethod.Post, "/api/v1/auth/logout", token));

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var rows = await db.AuthTokens.IgnoreQueryFilters()
            .Where(t => t.UserId == club.MemberId && t.Kind == TokenKind.RevokedAccess)
            .ToListAsync();

        Assert.Single(rows);
        Assert.True(rows[0].ExpiresAt > DateTimeOffset.UtcNow);

        // And the in-memory list agrees with it: seeding from that row alone re-arms the refusal.
        var fresh = new AccessTokenRevocationList();
        fresh.SeedHashed(rows[0].TokenHash, rows[0].ExpiresAt);
        Assert.Equal(1, fresh.Count);
    }

    [SkippableFact]
    public async Task The_wallet_stream_no_longer_accepts_a_session_token_in_the_query_string()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var client = ClientFor(factory, club);

        var token = await SignInAsync(client, club);

        // The query string is logged verbatim by every proxy in front of this. A full access
        // token must not be usable there, whatever a stale client sends.
        //
        // ResponseHeadersRead with a deadline, because the failure mode of a regression here is
        // an SSE stream that opens and never ends: the test would hang rather than go red, and a
        // gate that hangs is worse than one that fails.
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/wallet/stream?access_token={Uri.EscapeDataString(token)}");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
    }

    [SkippableFact]
    public async Task A_stream_ticket_opens_the_stream_and_nothing_else()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var client = ClientFor(factory, club);

        var token = await SignInAsync(client, club);
        var minted = await client.SendAsync(Bearing(HttpMethod.Post, "/api/v1/wallet/stream-ticket", token));
        Assert.Equal(HttpStatusCode.OK, minted.StatusCode);
        var ticket = JsonDocument.Parse(await minted.Content.ReadAsStringAsync()).RootElement
            .GetProperty("ticket").GetString()!;

        // It authenticates the stream…
        using var streamRequest = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/wallet/stream?ticket={Uri.EscapeDataString(ticket)}");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var streamed = await client.SendAsync(streamRequest, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        Assert.Equal(HttpStatusCode.OK, streamed.StatusCode);
        streamed.Dispose();

        // …and nothing else. It is not a session: it cannot read the wallet, cannot read the
        // profile, and — segment boundaries, deliberately — cannot mint another ticket.
        Assert.False(await AuthenticatesAsync(client, ticket));
        Assert.NotEqual(HttpStatusCode.OK, (await client.SendAsync(Bearing(HttpMethod.Get, "/api/v1/wallet", ticket))).StatusCode);
        Assert.NotEqual(HttpStatusCode.OK, (await client.SendAsync(Bearing(HttpMethod.Get, "/api/v1/me/profile", ticket))).StatusCode);
        Assert.NotEqual(HttpStatusCode.OK, (await client.SendAsync(Bearing(HttpMethod.Post, "/api/v1/wallet/stream-ticket", ticket))).StatusCode);
    }
}
