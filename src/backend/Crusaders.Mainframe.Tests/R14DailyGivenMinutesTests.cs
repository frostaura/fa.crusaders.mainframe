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
/// Review round 14, J14-2: "Sold" on the club's Reports means paid minutes only. The revenue
/// totals already said so (R13 J13-2), but the totals card and the "Minutes sold over time" chart
/// are summed from <c>/admin/reports/daily</c>, whose <c>top_ups_minutes</c> carries every funding
/// row. Each day now says how much of it the club gave (<c>given_minutes</c>, a SUBSET — the
/// buckets still sum to <c>net_movement_minutes</c>), so the page can draw sold and given apart.
/// </summary>
public sealed class R14DailyGivenMinutesTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    private sealed record Seed(Guid TenantId, string Slug, Guid AdminId);

    private static async Task<Seed> SeedAsync(IServiceProvider services, Func<Guid, Guid, Guid, IEnumerable<LedgerEntry>> rows)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var slug = $"r14g-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Given Daily Club" };
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

    private static async Task<List<JsonElement>> DailyAsync(TestWebAppFactory factory, Seed seed)
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
        var response = await client.GetAsync("/api/v1/admin/reports/daily");
        response.EnsureSuccessStatusCode();
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone().EnumerateArray().ToList();
    }

    private static LedgerEntry Row(Guid tenant, Guid user, Guid actor, LedgerEntryType type, int minutes, decimal? zar) => new()
    {
        TenantId = tenant,
        UserId = user,
        ActorUserId = actor,
        Type = type,
        AmountMinutes = minutes,
        ZarPaid = zar,
        Reason = "seed",
    };

    private static int Sum(List<JsonElement> days, string key) => days.Sum(d => d.GetProperty(key).GetInt32());

    /// <summary>A paid hour online, a desk sale, and two gifts (package_free and a R0.00 sale): 75 of 225 given.</summary>
    [SkippableFact]
    public async Task Each_day_says_how_much_of_its_top_ups_the_club_gave()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        var factory = pg.SharedHost;
        var seed = await SeedAsync(factory.Services, (t, admin, member) =>
        [
            Row(t, member, member, LedgerEntryType.TopUp, 60, 120m),
            Row(t, member, admin, LedgerEntryType.AdminTopUp, 90, 150m),
            Row(t, member, admin, LedgerEntryType.AdminTopUp, 30, 0m),
            Row(t, admin, admin, LedgerEntryType.AdminTopUp, 45, 0m),
            Row(t, member, member, LedgerEntryType.BookingCharge, -60, null),
        ]);

        var days = await DailyAsync(factory, seed);

        Assert.Equal(225, Sum(days, "top_ups_minutes"));
        Assert.Equal(75, Sum(days, "given_minutes"));
        // A subset, never an extra bucket: the day still sums to its own net.
        Assert.Equal(165, Sum(days, "net_movement_minutes"));
    }

    /// <summary>Varied: nothing given — every day carries a zero, so the page draws no Given at all.</summary>
    [SkippableFact]
    public async Task A_period_with_no_gifts_says_zero_given_on_every_day()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");
        var factory = pg.SharedHost;
        var seed = await SeedAsync(factory.Services, (t, admin, member) =>
        [
            Row(t, member, member, LedgerEntryType.TopUp, 60, 120m),
            Row(t, member, admin, LedgerEntryType.AdminTopUp, 90, 150m),
        ]);

        var days = await DailyAsync(factory, seed);

        Assert.NotEmpty(days);
        Assert.All(days, d => Assert.Equal(0, d.GetProperty("given_minutes").GetInt32()));
        Assert.Equal(150, Sum(days, "top_ups_minutes"));
    }
}
