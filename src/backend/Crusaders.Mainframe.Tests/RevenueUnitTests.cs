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
/// The club's revenue report, in the units it claims to be in.
///
/// <para>
/// <c>CLAUDE.md</c> says a ledger field whose name implies one unit while the column holds
/// another is a defect that must never be added a second time. It had been, three times
/// over, and this endpoint was the expensive one: <c>gross_topups_zar</c>,
/// <c>reversals_zar</c> and <c>net_zar</c> were all summed from <c>AmountCredits</c>, and
/// the admin page printed them with a rand sign.
/// </para>
///
/// <para>
/// The overstatement is not small and it is not uniform. A Regular member converts at 1.6
/// credits per rand and a League member at 2.4, so the same R1000 shows up as R1600 or
/// R2400 depending on who paid it — and once summed the two classes cannot be separated
/// again. This test uses one member of each class precisely so a fix that simply divides by
/// a single rate cannot pass it.
/// </para>
/// </summary>
public sealed class RevenueUnitTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public RevenueUnitTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    [SkippableFact]
    public async Task Revenue_reports_rand_from_what_members_paid_and_credits_from_what_they_got()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;

        Guid tenantId;
        string slug;
        Guid adminId;

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            await db.Database.MigrateAsync();

            slug = $"rev-{Guid.NewGuid():N}"[..20];
            var tenant = new Tenant { Slug = slug, DisplayName = "Revenue Club" };
            db.Tenants.Add(tenant);
            db.TenantSettings.Add(new TenantSettings
            {
                TenantId = tenant.Id,
                SettingsJson = """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"credits_per_zar_regular":1.6,"credits_per_zar_league":2.4,"timezone":"UTC"}""",
            });

            var admin = new User { TenantId = tenant.Id, Email = $"a-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
            var regular = new User { TenantId = tenant.Id, Email = $"r-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
            var league = new User { TenantId = tenant.Id, Email = $"l-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
            db.Users.AddRange(admin, regular, league);

            // R1000 each. One converts at 1.6, the other at 2.4 — so R2000 banked becomes
            // 4000 credits issued, and no single divisor recovers one figure from the other.
            db.LedgerEntries.AddRange(
                new LedgerEntry
                {
                    TenantId = tenant.Id, UserId = regular.Id, Type = LedgerEntryType.TopUp,
                    AmountCredits = 1600m, ZarPaid = 1000m, ConversionRate = 1.6m,
                    ActorUserId = regular.Id, Reason = "regular top-up",
                },
                new LedgerEntry
                {
                    TenantId = tenant.Id, UserId = league.Id, Type = LedgerEntryType.TopUp,
                    AmountCredits = 2400m, ZarPaid = 1000m, ConversionRate = 2.4m,
                    ActorUserId = league.Id, Reason = "league top-up",
                },
                // Court time spent is neither: it funds nothing and reverses nothing, so it
                // must not appear in either total.
                new LedgerEntry
                {
                    TenantId = tenant.Id, UserId = regular.Id, Type = LedgerEntryType.BookingCharge,
                    AmountCredits = -200m, ActorUserId = regular.Id, Reason = "a court",
                });

            await db.SaveChangesAsync();
            tenantId = tenant.Id;
            adminId = admin.Id;
        }

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, adminId.ToString()),
            new("tenant_id", tenantId.ToString()),
            new("tenant_slug", slug),
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

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = doc.RootElement;

        // What the club actually banked.
        Assert.Equal(2000m, root.GetProperty("gross_topups_zar").GetDecimal());
        Assert.Equal(0m, root.GetProperty("reversals_zar").GetDecimal());
        Assert.Equal(2000m, root.GetProperty("net_zar").GetDecimal());

        // What it issued in exchange, reported separately rather than under a rand name.
        Assert.Equal(4000m, root.GetProperty("gross_topups_credits").GetDecimal());
        Assert.Equal(4000m, root.GetProperty("net_credits").GetDecimal());
    }
}
