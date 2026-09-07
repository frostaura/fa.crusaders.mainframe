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
/// The club's daily breakdown: which day a figure lands on, and which figures are there.
///
/// <para>
/// Two defects, both visible on one screen. The buckets were cut on
/// <c>DateOnly.FromDateTime(x.UtcDateTime)</c> while the club runs
/// <c>Africa/Johannesburg</c>, so every movement between 00:00 and 02:00 local fell into the
/// previous day's row — and on the 1st of a month, into the previous month's report.
/// <c>reporting.md</c> § Implementation notes has required the tenant's own timezone since
/// it was written. And the row carried no <b>adjustments</b> figure at all: a club that had
/// handed out 2,525.50 credits at the desk could read that number on a member's own report
/// and on Transactions, and on no screen describing the club.
/// </para>
///
/// <para>
/// The third assertion here is not a defect but the thing that made the first one hard to
/// see: a row deliberately mixes two date bases — money on the day it moved, courts on the
/// day they are played — and under a 14-day advance window those are routinely different
/// days. That is pinned deliberately so a later "tidy-up" that quietly re-buckets bookings
/// onto the ledger's clock has to argue with a test rather than with a reviewer.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DailyReportTests
{
    private readonly PostgresFixture _pg;

    public DailyReportTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    /// <summary>Africa/Johannesburg is UTC+2 year round — no DST to reason about.</summary>
    private const string ClubZone = "Africa/Johannesburg";

    [SkippableTheory]
    // The club's zone, and UTC as the control. The SAME two instants must land on two days
    // under the first and on one day under the second, or the endpoint is not reading the
    // setting at all — a fixture that only ever ran at +02:00 could be satisfied by any
    // constant shift, including none.
    [InlineData(ClubZone, "2026-03-03")]
    [InlineData("UTC", "2026-03-02")]
    public async Task Daily_buckets_on_the_clubs_own_day_not_the_servers(
        string timezone, string expectedTopUpDay)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };

        // 22:30Z is 00:30 the NEXT day in Johannesburg; 21:30Z is 23:30 the SAME day. One
        // instant either side of the club's midnight, so a fix that shifts every row by a
        // day fails as loudly as the bug did.
        var lateNight = new DateTimeOffset(2026, 3, 2, 22, 30, 0, TimeSpan.Zero);
        var evening = new DateTimeOffset(2026, 3, 2, 21, 30, 0, TimeSpan.Zero);

        var (tenantId, slug, adminId) = await SeedAsync(factory, timezone, lateNight, evening);

        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Jwt(tenantId, slug, adminId));

        var response = await client.GetAsync(
            "/api/v1/admin/reports/daily?from=2026-03-01T00:00:00Z&to=2026-03-06T00:00:00Z");
        response.EnsureSuccessStatusCode();

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var byDate = doc.RootElement.EnumerateArray().ToDictionary(e => e.GetProperty("date").GetString()!);

        // The 300-credit top-up sits on the club's day, and on no other day — asserting the
        // whole series rather than one cell, so a fix that duplicates a row across two
        // buckets fails here too.
        foreach (var (date, row) in byDate)
        {
            var expected = date == expectedTopUpDay ? 300m : 0m;
            Assert.Equal(expected, row.GetProperty("top_ups_credits").GetDecimal());
        }

        // The 50-credit charge is an hour earlier and stays on 2 March under BOTH zones. So
        // in Johannesburg the two rows are split by the club's midnight, and in UTC they are
        // not — which is the whole difference between the two cases.
        Assert.Equal(50m, byDate["2026-03-02"].GetProperty("booking_charges_credits").GetDecimal());
    }

    [SkippableFact]
    public async Task Daily_reports_what_the_desk_adjusted_and_keeps_money_and_play_on_their_own_clocks()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };

        var lateNight = new DateTimeOffset(2026, 3, 2, 22, 30, 0, TimeSpan.Zero);
        var evening = new DateTimeOffset(2026, 3, 2, 21, 30, 0, TimeSpan.Zero);
        var (tenantId, slug, adminId) = await SeedAsync(factory, ClubZone, lateNight, evening);

        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Jwt(tenantId, slug, adminId));

        var response = await client.GetAsync(
            "/api/v1/admin/reports/daily?from=2026-03-01T00:00:00Z&to=2026-03-06T00:00:00Z");
        response.EnsureSuccessStatusCode();

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var byDate = doc.RootElement.EnumerateArray().ToDictionary(e => e.GetProperty("date").GetString()!);

        // K-F10: the desk's own movements, on the club's report, at all.
        Assert.Equal(125.50m, byDate["2026-03-03"].GetProperty("adjustments_credits").GetDecimal());
        // A day with none reads zero rather than being absent — the charts index every day.
        Assert.Equal(0m, byDate["2026-03-05"].GetProperty("adjustments_credits").GetDecimal());

        // The two clocks, stated. The court is charged for on the 2nd (local) and played on
        // the 4th, so the money column and the courts column of one row are not about the
        // same booking — which is exactly what the screen now says under the table.
        Assert.Equal(50m, byDate["2026-03-02"].GetProperty("booking_charges_credits").GetDecimal());
        Assert.Equal(0, byDate["2026-03-02"].GetProperty("bookings").GetInt32());
        Assert.Equal(0m, byDate["2026-03-04"].GetProperty("booking_charges_credits").GetDecimal());
        Assert.Equal(1, byDate["2026-03-04"].GetProperty("bookings").GetInt32());
    }

    /// <summary>
    /// One club, one member, and four rows: a top-up just after the club's midnight, a
    /// booking charge just before it, a desk adjustment, and the booking those charges name
    /// — played two days after it was paid for.
    /// </summary>
    private static async Task<(Guid TenantId, string Slug, Guid AdminId)> SeedAsync(
        TestWebAppFactory factory, string timezone, DateTimeOffset lateNight, DateTimeOffset evening)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"daily-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Daily Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = $$"""{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"timezone":"{{timezone}}"}""",
        });

        var admin = new User { TenantId = tenant.Id, Email = $"a-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        var member = new User { TenantId = tenant.Id, Email = $"m-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.AddRange(admin, member);

        var court = new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1", SlicePriceCredits = 50m };
        db.Courts.Add(court);

        var booking = new Booking
        {
            TenantId = tenant.Id,
            CourtId = court.Id,
            UserId = member.Id,
            ActorUserId = member.Id,
            StartsAt = new DateTimeOffset(2026, 3, 4, 8, 0, 0, TimeSpan.Zero),
            EndsAt = new DateTimeOffset(2026, 3, 4, 8, 30, 0, TimeSpan.Zero),
            SliceMinutes = 30,
            SliceCount = 1,
            AmountChargedCredits = 50m,
            Status = BookingStatus.Booked,
        };
        db.Bookings.Add(booking);

        db.LedgerEntries.AddRange(
            new LedgerEntry
            {
                TenantId = tenant.Id, UserId = member.Id, Type = LedgerEntryType.TopUp,
                AmountCredits = 300m, ZarPaid = 187.50m, ConversionRate = 1.6m,
                ActorUserId = member.Id, Reason = "top-up just after midnight", CreatedAt = lateNight,
            },
            new LedgerEntry
            {
                TenantId = tenant.Id, UserId = member.Id, Type = LedgerEntryType.BookingCharge,
                AmountCredits = -50m, RelatedBookingId = booking.Id,
                ActorUserId = member.Id, Reason = "court paid for two days ahead", CreatedAt = evening,
            },
            new LedgerEntry
            {
                TenantId = tenant.Id, UserId = member.Id, Type = LedgerEntryType.AdminAdjustment,
                AmountCredits = 125.50m, ActorUserId = admin.Id, Reason = "goodwill",
                CreatedAt = new DateTimeOffset(2026, 3, 3, 10, 0, 0, TimeSpan.Zero),
            });

        await db.SaveChangesAsync();
        return (tenant.Id, slug, admin.Id);
    }

    private static string Jwt(Guid tenantId, string slug, Guid adminId)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, adminId.ToString()),
            new("tenant_id", tenantId.ToString()),
            new("tenant_slug", slug),
            new("purpose", "access"),
            new(ClaimTypes.Role, "admin"),
        };
        return new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(
            issuer: "crusaders.mainframe", audience: "crusaders.mainframe.app", claims: claims,
            notBefore: DateTime.UtcNow, expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256)));
    }
}
