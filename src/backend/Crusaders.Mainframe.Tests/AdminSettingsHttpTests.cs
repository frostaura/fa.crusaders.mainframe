using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The admin settings surface over real HTTP.
///
/// <para>
/// The test that matters most here is <see cref="Opening_the_settings_page_and_saving_it_changes_nothing"/>.
/// A settings screen reads a value, shows it to a person, and PUTs back whatever it was
/// shown — so any default the GET invents that the engine does not share is not a cosmetic
/// difference, it is a silent write. This endpoint answered 30 minutes and 50 credits where
/// <see cref="TenantSettingsAccessor"/> used 15 and 8, which meant that on a tenant with no
/// explicit values, opening the page and pressing save doubled every slice and repriced
/// every court. Nothing failed, nothing logged, and the club would have found out from a
/// member's bill.
/// </para>
/// </summary>
public abstract partial class AdminSettingsHttpTests
{
    private readonly PostgresFixture _pg;

    protected AdminSettingsHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string SettingsPath = "/api/v1/admin/settings/";
    private const string ProfilePath = "/api/v1/me/profile";

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId);

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    /// <summary>
    /// A tenant with a settings row that is deliberately EMPTY. That is the condition the
    /// defect lived in: every value falls through to a default, so the two default sets
    /// disagreeing is the whole of the behaviour.
    /// </summary>
    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory, string settingsJson = "{}")
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        // No MigrateAsync: the database is a clone of the template PostgresFixture migrated once.

        var slug = $"cfg-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Config Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = settingsJson });

        var admin = new User
        {
            TenantId = tenant.Id,
            Email = $"{slug}@test.local",
            PasswordHash = "x",
            EmailVerified = true,
            IsAdmin = true,
        };
        db.Users.Add(admin);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = admin.Id,
            FullName = "Config Admin",
            MembershipNumber = slug,
            Status = MembershipStatus.Active,
        });

        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, admin.Id);
    }

    private static string AdminToken(Seeded s)
    {
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, s.AdminUserId.ToString()),
                new Claim("tenant_id", s.TenantId.ToString()),
                new Claim("tenant_slug", s.Slug),
                new Claim("purpose", "access"),
                new Claim(ClaimTypes.Role, "admin"),
            ],
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static HttpClient AdminClient(TestWebAppFactory factory, Seeded s)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", AdminToken(s));
        return client;
    }

    /// <summary>The eight required booking fields at their fixture values, plus an optional timezone.</summary>
    private static Dictionary<string, object> BaseSettings(string? tz = null)
    {
        var payload = new Dictionary<string, object>
        {
            ["sliceMinutes"] = 15,
            ["slicePriceCredits"] = 8m,
            ["advanceBookingDays"] = 14,
            ["dayStartMinute"] = 360,
            ["dayEndMinute"] = 1320,
            ["penaltyPct"] = 30m,
            ["graceWindowMinutes"] = 5,
            ["penaltyWindowMinutes"] = 15,
        };
        if (tz is not null) payload["timezone"] = tz;
        return payload;
    }

    // ---- The six court-box and identification numbers (WI-2) ----------------

    /// <summary>The booking-settings body every PUT needs, with the device numbers layered on top.</summary>
    private static Dictionary<string, object> Baseline() => new()
    {
        ["sliceMinutes"] = 15,
        ["slicePriceCredits"] = 8m,
        ["advanceBookingDays"] = 14,
        ["dayStartMinute"] = 360,
        ["dayEndMinute"] = 1320,
        ["penaltyPct"] = 30m,
        ["graceWindowMinutes"] = 5,
        ["penaltyWindowMinutes"] = 15,
    };

    private static async Task<TenantSettingsView> EngineAsync(TestWebAppFactory factory, Seeded seeded)
    {
        using var scope = factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<Api.Multitenancy.ITenantContext>().Set(seeded.TenantId, seeded.Slug);
        return await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
    }
}
