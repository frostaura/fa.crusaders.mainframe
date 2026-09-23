using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Regression tests for the QR-to-account-takeover path.
///
/// <para>
/// Every token this application mints is signed with one key, for one issuer and one
/// audience. That used to include the <c>qr_ident</c> token a member's phone put on
/// screen at the court so a camera could read it. Before the <c>purpose</c> check, that
/// token was a working <c>Authorization: Bearer</c> header for the entire API as that
/// member: read their wallet, book on their credits, change their profile.
/// Photographing a screen in a public sports hall was the whole attack.
/// </para>
///
/// <para>
/// The QR is no longer a JWT at all — it is a twelve-character access code that names a
/// row (review H2) — so nothing this application mints is both scannable and a bearer
/// token. The purpose rule stays, because the next short-lived token somebody mints for
/// a courtside purpose must be refused as a bearer by default, not after the fact.
/// </para>
///
/// <para>
/// The tests below mint tokens the way the application does — same key, same issuer,
/// same audience, valid signature, unexpired — and differ only in the <c>purpose</c>
/// claim. That is what makes them a test of the check rather than of the signature.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class TokenPurposeTests
{
    private readonly PostgresFixture _pg;

    public TokenPurposeTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    /// <summary>Any authenticated endpoint would do; this one needs only a valid principal.</summary>
    private const string AuthenticatedPath = "/api/v1/me/profile";

    private static string Mint(string purpose, Guid userId, string tenantSlug, Guid tenantId, string? role = null)
    {
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret));
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, userId.ToString()),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
            new("tenant_id", tenantId.ToString()),
            new("tenant_slug", tenantSlug),
            new("purpose", purpose),
        };
        if (role is not null) claims.Add(new Claim(ClaimTypes.Role, role));

        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims: claims,
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    /// <summary>Minting a token with no purpose claim at all — the shape of a hand-rolled forgery.</summary>
    private static string MintWithoutPurpose(Guid userId, string tenantSlug, Guid tenantId)
    {
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret));
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, userId.ToString()),
                new Claim("tenant_id", tenantId.ToString()),
                new Claim("tenant_slug", tenantSlug),
            ],
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private sealed record Seeded(Guid UserId, Guid TenantId, string Slug);

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"purp-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Purpose Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = """{"timezone":"UTC"}""" });

        var user = new User
        {
            TenantId = tenant.Id,
            Email = $"{slug}@test.local",
            PasswordHash = "x",
            EmailVerified = true,
            // A real admin, because two tests below mint this user an ADMIN access token as the
            // control half of a purpose check. Since R20 the admin role on a token is checked
            // against the account (LiveAdminRole), so a role claimed for a non-admin is stripped
            // and the control would fail for a reason that has nothing to do with purpose.
            IsAdmin = true,
        };
        db.Users.Add(user);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = user.Id,
            FullName = "Purpose Player",
            MembershipNumber = slug,
            Status = MembershipStatus.Active,
            MemberClass = MemberClass.Regular,
        });
        await db.SaveChangesAsync();

        return new Seeded(user.Id, tenant.Id, slug);
    }

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static async Task<HttpStatusCode> GetWithAsync(HttpClient client, string token)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, AuthenticatedPath);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return (await client.SendAsync(req)).StatusCode;
    }

    /// <summary>
    /// Did the token actually authenticate?
    ///
    /// <para>
    /// Asked at <c>/api/v1/whoami</c> rather than inferred from a status code, because
    /// a rejected token produces <c>400 tenant_unresolved</c> on most endpoints, not
    /// <c>401</c>: authentication fails, so there is no tenant_slug claim, and the
    /// tenant middleware — which sits between authentication and authorization —
    /// refuses first. Both are refusals, but only one of them is evidence about the
    /// token. whoami is anonymous and tenant-exempt, so it answers the actual question.
    /// </para>
    /// </summary>
    private static async Task<bool> AuthenticatesAsync(HttpClient client, string token)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/whoami");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await req.SendVia(client);

        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        return json.GetProperty("is_authenticated").GetBoolean();
    }

    /// <summary>The control. A real access token still works — the fix must not lock everyone out.</summary>
    [SkippableFact]
    public async Task An_access_token_is_accepted()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = factory.CreateClient();

        var token = Mint("access", seeded.UserId, seeded.Slug, seeded.TenantId);

        Assert.True(await AuthenticatesAsync(client, token));
        Assert.Equal(HttpStatusCode.OK, await GetWithAsync(client, token));
    }

    /// <summary>
    /// The takeover, denied. Same key, same issuer, same audience, valid signature,
    /// unexpired — only the purpose differs, and only the purpose stops it.
    /// </summary>
    [SkippableTheory]
    [InlineData("qr_ident")]        // the purpose the QR carried when it was a JWT; no longer minted, still refused
    [InlineData("pin_ident")]       // a plausible future courtside purpose
    [InlineData("magic_link")]
    [InlineData("password_reset")]
    [InlineData("email_verify")]
    [InlineData("device")]          // a device claim minted as a JWT
    [InlineData("")]
    public async Task A_non_access_token_is_refused(string purpose)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = factory.CreateClient();

        var token = Mint(purpose, seeded.UserId, seeded.Slug, seeded.TenantId);

        Assert.False(await AuthenticatesAsync(client, token));
        Assert.NotEqual(HttpStatusCode.OK, await GetWithAsync(client, token));
    }

    [SkippableFact]
    public async Task A_token_with_no_purpose_claim_is_refused()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = factory.CreateClient();

        var token = MintWithoutPurpose(seeded.UserId, seeded.Slug, seeded.TenantId);

        Assert.False(await AuthenticatesAsync(client, token));
        Assert.NotEqual(HttpStatusCode.OK, await GetWithAsync(client, token));
    }

    /// <summary>
    /// Privilege escalation via purpose. A qr_ident token carrying an admin role claim
    /// must not reach the admin surface either — the purpose check runs before role
    /// authorisation, so the role never gets considered.
    /// </summary>
    [SkippableFact]
    public async Task A_qr_token_claiming_the_admin_role_does_not_reach_the_admin_surface()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = factory.CreateClient();

        var token = Mint("qr_ident", seeded.UserId, seeded.Slug, seeded.TenantId, role: "admin");
        Assert.False(await AuthenticatesAsync(client, token));

        var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/admin/devices/");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await client.SendAsync(req);

        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);

        // And the control: the same user with the same role on an access token does get in,
        // so the refusal above is about the purpose and not about the seeding.
        var admin = Mint("access", seeded.UserId, seeded.Slug, seeded.TenantId, role: "admin");
        var ok = new HttpRequestMessage(HttpMethod.Get, "/api/v1/admin/devices/");
        ok.Headers.Authorization = new AuthenticationHeaderValue("Bearer", admin);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(ok)).StatusCode);
    }

    /// <summary>
    /// No JWT identifies anybody at a court any more — not even one with the old
    /// <c>qr_ident</c> purpose. The QR is an access code now (review H2: a JWT could never
    /// cross the box's 24-byte scanner pipeline), so a qr_ident JWT presented as the QR
    /// body is simply an unknown code. The refusal is the ordinary business one — 200
    /// with <c>matched:false</c> — not a 401: the admin's bearer still authenticates, and
    /// the endpoint answers every unusable code identically so it cannot sort real ones
    /// from junk.
    /// </summary>
    [SkippableFact]
    public async Task A_qr_ident_jwt_presented_as_the_qr_body_identifies_nobody()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        var client = factory.CreateClient();

        var admin = Mint("access", seeded.UserId, seeded.Slug, seeded.TenantId, role: "admin");
        var qr = Mint("qr_ident", seeded.UserId, seeded.Slug, seeded.TenantId);

        var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/court/1/qr/match")
        {
            Content = JsonContent.Create(new { Token = qr }),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", admin);
        var response = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.False(body.GetProperty("matched").GetBoolean());
        Assert.Equal("invalid_or_expired", body.GetProperty("reason").GetString());
    }
}

internal static class HttpRequestMessageExtensions
{
    /// <summary>Sends a request built by the caller. Exists only so the assertion helpers read as one line.</summary>
    public static Task<HttpResponseMessage> SendVia(this HttpRequestMessage request, HttpClient client)
        => client.SendAsync(request);
}
