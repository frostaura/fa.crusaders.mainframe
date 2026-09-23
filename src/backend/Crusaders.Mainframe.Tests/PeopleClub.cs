using System.IdentityModel.Tokens.Jwt;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A club of named people — admins, members, applicants — for the suites about who a person
/// IS rather than what they booked: preferences, and the admin role.
///
/// <para>
/// Every club gets a fresh slug because the whole Postgres-backed tier shares one database (an
/// xUnit collection fixture is created once, not once per test), and two clubs in that one
/// database is exactly the arrangement a cross-tenant test needs: with a database per club the
/// second club is empty because it is a different store, and the assertion would hold with
/// every query filter deleted.
/// </para>
/// </summary>
public sealed class PeopleClub
{
    /// <summary>The signing key <c>TestWebAppFactory</c> boots the app with.</summary>
    public const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    public Guid TenantId { get; }
    public string Slug { get; }

    private PeopleClub(Guid tenantId, string slug)
    {
        TenantId = tenantId; Slug = slug;
    }

    /// <summary>Migrates, then creates an empty club.</summary>
    public static async Task<PeopleClub> SeedAsync(WebApplicationFactory<Program> factory, string prefix)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"{prefix}-{Guid.NewGuid():N}"[..24];
        var tenant = new Tenant { Slug = slug, DisplayName = $"{prefix} club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = """{"timezone":"UTC"}""" });
        await db.SaveChangesAsync();
        return new PeopleClub(tenant.Id, slug);
    }

    /// <summary>
    /// Adds one person. <paramref name="membership"/> null means an account with no membership
    /// row at all — which is what a bootstrap administrator is.
    /// </summary>
    public async Task<Guid> AddAsync(
        WebApplicationFactory<Program> factory, string name, bool isAdmin,
        MembershipStatus? membership = MembershipStatus.Active, string userStatus = "active", string? email = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var handle = name.ToLowerInvariant().Replace(' ', '.');
        var user = new User
        {
            TenantId = TenantId,
            Email = email ?? $"{handle}@{Slug}.test",
            PasswordHash = "x",
            EmailVerified = true,
            IsAdmin = isAdmin,
            Status = userStatus,
        };
        db.Users.Add(user);
        if (membership is { } status)
        {
            db.Memberships.Add(new Membership
            {
                TenantId = TenantId,
                UserId = user.Id,
                FullName = name,
                MembershipNumber = $"{handle}-{Guid.NewGuid():N}"[..20],
                Status = status,
            });
        }
        await db.SaveChangesAsync();
        return user.Id;
    }

    /// <summary>
    /// A client carrying an access token for <paramref name="userId"/> in this club. The role
    /// is whatever the TOKEN says, independent of the database — which is exactly what a token
    /// minted before a demotion looks like.
    /// </summary>
    public HttpClient Client(WebApplicationFactory<Program> factory, Guid userId, bool adminRole)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Token(userId, adminRole));
        return client;
    }

    public string Token(Guid userId, bool adminRole)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, userId.ToString()),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
            new("tenant_id", TenantId.ToString()),
            new("tenant_slug", Slug),
            new("purpose", "access"),
        };
        if (adminRole) claims.Add(new Claim(ClaimTypes.Role, "admin"));

        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims: claims,
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    /// <summary>A read of the database outside any request, tenant filters off.</summary>
    public static async Task<T> ReadAsync<T>(WebApplicationFactory<Program> factory, Func<MainframeDbContext, Task<T>> read)
    {
        using var scope = factory.Services.CreateScope();
        return await read(scope.ServiceProvider.GetRequiredService<MainframeDbContext>());
    }
}
