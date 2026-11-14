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
/// <c>reversals_zar</c> and <c>net_zar</c> were all summed from <c>AmountMinutes</c>, and
/// the admin page printed them with a rand sign.
/// </para>
///
/// <para>
/// Since P13 the unit is minutes, bought in packages at prices that differ by package size, by
/// group discount and at the desk — so the same rand buys different minutes depending on who
/// paid and how, and once summed the two cannot be separated again. This test buys three
/// different ways precisely so a fix that simply divides by one price cannot pass it, and the
/// one honest bridge between the two totals is the rate over the window,
/// <c>zar_per_minute_sold</c> (contract §3.15).
/// </para>
/// </summary>
public sealed class RevenueUnitTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public RevenueUnitTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    [SkippableFact]
    public async Task Revenue_reports_rand_from_what_members_paid_and_minutes_from_what_they_got()
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
                SettingsJson = """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"timezone":"UTC"}""",
            });

            var admin = new User { TenantId = tenant.Id, Email = $"a-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
            var regular = new User { TenantId = tenant.Id, Email = $"r-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
            var league = new User { TenantId = tenant.Id, Email = $"l-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
            db.Users.AddRange(admin, regular, league);

            // Three ways to buy minutes, three prices per minute: 10 hours online at list
            // (R1000 for 600), 5 hours online at a 10% group discount (R495 for 300), and 1 hour
            // sold at the desk for cash (R100 for 60). R1595 banked, 960 minutes sold, and no
            // single divisor recovers one figure from the other.
            db.LedgerEntries.AddRange(
                new LedgerEntry
                {
                    TenantId = tenant.Id,
                    UserId = regular.Id,
                    Type = LedgerEntryType.TopUp,
                    AmountMinutes = 600,
                    ZarPaid = 1000m,
                    ActorUserId = regular.Id,
                    Reason = "PayFast purchase: 10 hours",
                },
                new LedgerEntry
                {
                    TenantId = tenant.Id,
                    UserId = league.Id,
                    Type = LedgerEntryType.TopUp,
                    AmountMinutes = 300,
                    ZarPaid = 495m,
                    ActorUserId = league.Id,
                    Reason = "PayFast purchase: 5 hours",
                },
                new LedgerEntry
                {
                    TenantId = tenant.Id,
                    UserId = league.Id,
                    Type = LedgerEntryType.AdminTopUp,
                    AmountMinutes = 60,
                    ZarPaid = 100m,
                    ActorUserId = admin.Id,
                    Reason = "Paid cash at the bar — 1 hour",
                },
                // Court time spent is neither: it funds nothing and reverses nothing, so it
                // must not appear in either total.
                new LedgerEntry
                {
                    TenantId = tenant.Id,
                    UserId = regular.Id,
                    Type = LedgerEntryType.BookingCharge,
                    AmountMinutes = -200,
                    ActorUserId = regular.Id,
                    Reason = "a court",
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
        Assert.Equal(1595m, root.GetProperty("gross_topups_zar").GetDecimal());
        Assert.Equal(0m, root.GetProperty("reversals_zar").GetDecimal());
        Assert.Equal(1595m, root.GetProperty("net_zar").GetDecimal());

        // What it sold in exchange, reported separately rather than under a rand name — and
        // as JSON integers, never 960.0.
        Assert.Equal(960, root.GetProperty("gross_topups_minutes").GetInt32());
        Assert.Equal(960, root.GetProperty("net_minutes").GetInt32());
        Assert.DoesNotContain("960.0", root.GetRawText());

        // The rate: 1595 ÷ 960 = 1.66145833…, rounded DOWN to four places.
        Assert.Equal(1.6614m, root.GetProperty("zar_per_minute_sold").GetDecimal());
        Assert.DoesNotContain("credit", root.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// The rate rounds DOWN to four places, so the report never claims a rate the club did not
    /// earn (2 ÷ 3 is 0.6666, not 0.6667), and it is null — not zero, not a division error —
    /// when no minutes were sold net over the window.
    /// </summary>
    [Theory]
    [InlineData(1595, 960, "1.6614")]
    [InlineData(2, 3, "0.6666")]
    [InlineData(550, 300, "1.8333")]
    [InlineData(120, 60, "2")]
    [InlineData(0, 60, "0")]
    [InlineData(100, 0, null)]
    [InlineData(-100, -60, null)]
    public void The_rate_per_minute_sold_rounds_down_and_is_null_without_sales(double zar, int minutes, string? expected)
    {
        var rate = Api.Endpoints.ReportingEndpoints.ZarPerMinuteSold((decimal)zar, minutes);
        Assert.Equal(expected is null ? null : decimal.Parse(expected, System.Globalization.CultureInfo.InvariantCulture), rate);
    }
}
