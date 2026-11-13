using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
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
/// Go-live FM-8 — <c>GET /api/v1/auth/club</c>, the anonymous read that names the club an address
/// serves, so the member app's crest, sign-in band, pass and tab titles stop saying "Crusaders
/// Squash" at every club. Two clubs in every test, because a single club cannot tell "this club's
/// name" from "the only name there is".
/// </summary>
public sealed class ClubIdentityHttpTests : IClassFixture<PostgresFixture>
{
    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private readonly PostgresFixture _pg;

    public ClubIdentityHttpTests(PostgresFixture pg) => _pg = pg;

    private sealed record Club(Guid TenantId, string Slug, string Name, Guid MemberId);

    private static async Task<Club> SeedAsync(TestWebAppFactory factory, string displayName)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();
        var slug = $"club-{Guid.NewGuid():N}"[..18];
        var tenant = new Tenant { Slug = slug, DisplayName = displayName };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = """{"slice_minutes":15,"timezone":"UTC"}""" });
        var member = new User { TenantId = tenant.Id, Email = $"m-{slug}@test.local", EmailVerified = true };
        db.Users.Add(member);
        db.Memberships.Add(new Membership { TenantId = tenant.Id, UserId = member.Id, FullName = "Ordinary Member", MembershipNumber = $"M-{slug}", Status = MembershipStatus.Active });
        await db.SaveChangesAsync();
        return new Club(tenant.Id, slug, displayName, member.Id);
    }

    private static string Token(Club club)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, club.MemberId.ToString()),
            new("tenant_id", club.TenantId.ToString()),
            new("tenant_slug", club.Slug),
            new("purpose", "access"),
        };
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe", audience: "crusaders.mainframe.app", claims: claims,
            notBefore: DateTime.UtcNow, expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static async Task<(HttpStatusCode Status, JsonElement Body)> ReadAsync(HttpClient client)
    {
        var response = await client.GetAsync("/api/v1/auth/club");
        var text = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text);
        return (response.StatusCode, doc.RootElement.Clone());
    }

    [Fact]
    public async Task A_visitor_on_each_clubs_address_is_told_that_clubs_own_name()
    {
        if (!_pg.Available) return;
        var factory = _pg.SharedHost;
        var a = await SeedAsync(factory, "Northside Squash Club");
        var b = await SeedAsync(factory, "Harbour Racquets");

        foreach (var club in new[] { a, b })
        {
            using var client = factory.CreateClient();
            client.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";
            var (status, body) = await ReadAsync(client);
            Assert.Equal(HttpStatusCode.OK, status);
            Assert.Equal(club.Slug, body.GetProperty("slug").GetString());
            Assert.Equal(club.Name, body.GetProperty("name").GetString());
            // Only the name and the slug: nothing from the club's settings, no member data.
            Assert.Equal(2, body.EnumerateObject().Count());
        }
    }

    [Fact]
    public async Task A_signed_in_member_on_a_tenantless_host_is_told_their_own_clubs_name()
    {
        if (!_pg.Available) return;
        var factory = _pg.SharedHost;
        var a = await SeedAsync(factory, "Northside Squash Club");
        await SeedAsync(factory, "Harbour Racquets");

        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Host = "127.0.0.1";
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Token(a));
        var (status, body) = await ReadAsync(client);
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal("Northside Squash Club", body.GetProperty("name").GetString());
    }

    /// <summary>The cross-tenant injection: club A's token on club B's address names neither.</summary>
    [Fact]
    public async Task One_clubs_token_on_another_clubs_address_is_refused()
    {
        if (!_pg.Available) return;
        var factory = _pg.SharedHost;
        var a = await SeedAsync(factory, "Northside Squash Club");
        var b = await SeedAsync(factory, "Harbour Racquets");

        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Host = $"{b.Slug}.crusaders.test";
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Token(a));
        var (status, body) = await ReadAsync(client);
        Assert.NotEqual(HttpStatusCode.OK, status);
        Assert.False(body.TryGetProperty("name", out _));
    }

    [Fact]
    public async Task A_club_row_with_no_display_name_is_called_the_club_never_another_clubs_name()
    {
        if (!_pg.Available) return;
        var factory = _pg.SharedHost;
        var blank = await SeedAsync(factory, "   ");
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Host = $"{blank.Slug}.crusaders.test";
        var (status, body) = await ReadAsync(client);
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal("the club", body.GetProperty("name").GetString());
    }
}
