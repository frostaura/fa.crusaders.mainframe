using System.IdentityModel.Tokens.Jwt;
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
/// Review round 13, J13-2: minutes the club GAVE — a desk <c>package_free</c>, or a package recorded
/// at R0.00 — are not minutes it sold. The revenue report counted them in <c>gross_topups_minutes</c>
/// and <c>net_minutes</c>, so one free package beside one paid one halved "rand per hour sold".
/// They are reported on their own (<c>given_minutes</c>), and sold + given still reconciles with
/// every funding row Transactions lists.
/// </summary>
public sealed class R13RevenueGivenMinutesTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    private sealed record Seed(Guid TenantId, string Slug, Guid AdminId);

    private static async Task<Seed> SeedAsync(IServiceProvider services, Func<Guid, Guid, Guid, IEnumerable<LedgerEntry>> rows)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var slug = $"r13g-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Given Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"timezone":"UTC"}""",
        });
        var admin = new User { TenantId = tenant.Id, Email = $"a-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        var member = new User { TenantId = tenant.Id, Email = $"m-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.AddRange(admin, member);
        db.LedgerEntries.AddRange(rows(tenant.Id, admin.Id, member.Id));
        await db.SaveChangesAsync();
        return new Seed(tenant.Id, slug, admin.Id);
    }

    private static async Task<JsonElement> RevenueAsync(TestWebAppFactory factory, Seed seed)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, seed.AdminId.ToString()),
            new("tenant_id", seed.TenantId.ToString()),
            new("tenant_slug", seed.Slug),
            new("purpose", "access"),
            new(ClaimTypes.Role, "admin"),
        };
        var jwt = new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(
            issuer: "crusaders.mainframe", audience: "crusaders.mainframe.app", claims: claims,
            notBefore: DateTime.UtcNow, expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256)));
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", jwt);
        var response = await client.GetAsync("/api/v1/admin/reports/revenue");
        response.EnsureSuccessStatusCode();
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
    }

    private static LedgerEntry Row(Guid tenant, Guid user, Guid actor, LedgerEntryType type, int minutes, decimal? zar) => new()
    {
        TenantId = tenant, UserId = user, ActorUserId = actor, Type = type, AmountMinutes = minutes, ZarPaid = zar,
        Reason = "seed",
    };

    /// <summary>One paid hour online and one free hour at the desk: one hour sold, at the paid hour's rate.</summary>
    [SkippableFact]
    public async Task A_free_package_is_given_not_sold_and_leaves_the_rate_alone()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        var factory = pg.SharedHost;
        var seed = await SeedAsync(factory.Services, (t, admin, member) =>
        [
            Row(t, member, member, LedgerEntryType.TopUp, 60, 120m),
            Row(t, member, admin, LedgerEntryType.AdminTopUp, 60, 0m),
        ]);

        var root = await RevenueAsync(factory, seed);

        Assert.Equal(120m, root.GetProperty("net_zar").GetDecimal());
        Assert.Equal(60, root.GetProperty("gross_topups_minutes").GetInt32());
        Assert.Equal(60, root.GetProperty("net_minutes").GetInt32());
        Assert.Equal(60, root.GetProperty("given_minutes").GetInt32());
        // R120 for 60 sold: R2 a minute (R120 an hour), not R1 (R60 an hour) over 120 "sold".
        Assert.Equal(2m, root.GetProperty("zar_per_minute_sold").GetDecimal());
    }

    /// <summary>
    /// Varied: a desk SALE beside two gifts (one package_free, one recorded at R0.00), and nothing
    /// paid online. Sold + given is every funding row's minutes — what Transactions totals.
    /// </summary>
    [SkippableFact]
    public async Task Sold_and_given_add_up_to_every_funding_row()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        var factory = pg.SharedHost;
        var seed = await SeedAsync(factory.Services, (t, admin, member) =>
        [
            Row(t, member, admin, LedgerEntryType.AdminTopUp, 90, 150m),
            Row(t, member, admin, LedgerEntryType.AdminTopUp, 30, 0m),
            Row(t, admin, admin, LedgerEntryType.AdminTopUp, 45, 0m),
            Row(t, member, member, LedgerEntryType.BookingCharge, -60, null),
        ]);

        var root = await RevenueAsync(factory, seed);

        Assert.Equal(90, root.GetProperty("gross_topups_minutes").GetInt32());
        Assert.Equal(75, root.GetProperty("given_minutes").GetInt32());
        Assert.Equal(165, root.GetProperty("gross_topups_minutes").GetInt32() + root.GetProperty("given_minutes").GetInt32());
        Assert.Equal(150m, root.GetProperty("gross_topups_zar").GetDecimal());
        Assert.Equal(1.6666m, root.GetProperty("zar_per_minute_sold").GetDecimal());
    }

    /// <summary>Only gifts in the window: nothing was sold, so there is no rate — a dash, never R0.00.</summary>
    [SkippableFact]
    public async Task A_window_of_gifts_alone_sold_nothing()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        var factory = pg.SharedHost;
        var seed = await SeedAsync(factory.Services, (t, admin, member) =>
        [
            Row(t, member, admin, LedgerEntryType.AdminTopUp, 60, 0m),
        ]);

        var root = await RevenueAsync(factory, seed);

        Assert.Equal(0, root.GetProperty("net_minutes").GetInt32());
        Assert.Equal(60, root.GetProperty("given_minutes").GetInt32());
        Assert.Equal(JsonValueKind.Null, root.GetProperty("zar_per_minute_sold").ValueKind);
    }
}
