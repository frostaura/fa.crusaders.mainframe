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
/// The club does not sell a court it will not open — on either booking route.
///
/// <para>
/// A round-7 fix closed the courtside doors against a member the club has not said yes to,
/// widening the device-side filters from <c>Status == Suspended</c> to <c>Status != Active</c>.
/// The two booking routes were left behind: the member's own still read <c>== Suspended</c>,
/// and <c>POST /api/v1/admin/bookings</c> tested membership status not at all. A verifier
/// drove the result end to end — an admin booked on behalf of an applicant sitting in
/// <c>PendingApproval</c>, she was charged 50 credits, her booking never reached the box
/// roster, every courtside door refused it with <c>no_booking</c>, and the sweep then settled
/// it as an ordinary no-show carrying the 30% penalty. She could not object: sign-in refuses
/// an unapproved member, so she had no screen to see any of it on.
/// </para>
///
/// <para>
/// The assertion that matters in every case below is the LEDGER, not the status code. A 403
/// with a charge behind it would be the same defect wearing a better response.
/// </para>
/// </summary>
public sealed class BookingMembershipGateTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public BookingMembershipGateTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string MemberBookingsPath = "/api/v1/bookings/";
    private const string AdminBookingsPath = "/api/v1/admin/bookings/";
    private const int SliceMinutes = 15;   // a slice costs its 15 minutes (§1.1)
    private const int MemberFloatMinutes = 500;

    /// <summary>Hours wide open and no peak window, so nothing here depends on when the suite runs.</summary>
    private const string SettingsJson = """
        {"slice_minutes":15,"penalty_pct":30,"grace_window_minutes":5,
         "penalty_window_minutes":15,"advance_booking_days":14,"timezone":"UTC",
         "member_per_day_max_minutes":600,"peak_hours":"16:00-19:00","peak_advance_hours_for_regular":1,
         "day_start_minute":0,"day_end_minute":1440}
        """;

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId, Guid MemberUserId, Guid CourtId);

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory, MembershipStatus memberStatus)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"gate-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Gate Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = SettingsJson });

        var admin = new User { TenantId = tenant.Id, Email = $"admin-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        var member = new User { TenantId = tenant.Id, Email = $"member-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.AddRange(admin, member);
        db.Memberships.AddRange(
            new Membership { TenantId = tenant.Id, UserId = admin.Id, FullName = "Desk Admin", MembershipNumber = $"{slug}-A", Status = MembershipStatus.Active },
            new Membership { TenantId = tenant.Id, UserId = member.Id, FullName = "Mia Bekker", MembershipNumber = $"{slug}-M", Status = memberStatus });

        db.Courts.Add(new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1" });

        // Funded well past the price on purpose. A refusal has to be the membership rule and
        // not `insufficient_balance` wearing a different name — the fixture that would let
        // this test pass for the wrong reason is a poor one.
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = tenant.Id,
            UserId = member.Id,
            ActorUserId = admin.Id,
            Type = LedgerEntryType.AdminAdjustment,
            AmountMinutes = MemberFloatMinutes,
            Reason = "Seed float",
        });

        await db.SaveChangesAsync();
        var courtId = await db.Courts.IgnoreQueryFilters().Where(c => c.TenantId == tenant.Id).Select(c => c.Id).FirstAsync();
        return new Seeded(tenant.Id, slug, admin.Id, member.Id, courtId);
    }

    private static string TokenFor(Seeded s, Guid userId, bool isAdmin)
    {
        List<Claim> claims =
        [
            new Claim(JwtRegisteredClaimNames.Sub, userId.ToString()),
            new Claim("tenant_id", s.TenantId.ToString()),
            new Claim("tenant_slug", s.Slug),
            new Claim("purpose", "access"),
        ];
        if (isAdmin) claims.Add(new Claim(ClaimTypes.Role, "admin"));

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

    private static HttpClient ClientFor(TestWebAppFactory factory, Seeded s, Guid userId, bool isAdmin = false)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TokenFor(s, userId, isAdmin));
        return client;
    }

    private static DateTimeOffset SlotAt(int hour = 9)
    {
        var d = DateTime.UtcNow.Date.AddDays(2);
        return new DateTimeOffset(d.Year, d.Month, d.Day, hour, 0, 0, TimeSpan.Zero);
    }

    private static async Task<(HttpStatusCode Status, JsonElement Body)> PostAsync(HttpClient client, string path, object body)
    {
        var res = await client.PostAsJsonAsync(path, body);
        var text = await res.Content.ReadAsStringAsync();
        using var doc = string.IsNullOrWhiteSpace(text) ? JsonDocument.Parse("{}") : JsonDocument.Parse(text);
        return (res.StatusCode, doc.RootElement.Clone());
    }

    /// <summary>Nothing was charged and no booking exists — the assertion the status code cannot make.</summary>
    private static async Task AssertNothingHappenedAsync(TestWebAppFactory factory, Seeded s)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var rows = await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == s.TenantId && l.UserId == s.MemberUserId).ToListAsync();
        Assert.Equal(MemberFloatMinutes, rows.Sum(l => l.AmountMinutes));
        Assert.DoesNotContain(rows, l => l.Type == LedgerEntryType.BookingCharge);

        Assert.Empty(await db.Bookings.IgnoreQueryFilters()
            .Where(b => b.TenantId == s.TenantId && b.UserId == s.MemberUserId).ToListAsync());
    }

    [SkippableTheory]
    [InlineData(MembershipStatus.Suspended, "member_suspended")]
    [InlineData(MembershipStatus.PendingApproval, "member_not_active")]
    [InlineData(MembershipStatus.Rejected, "member_not_active")]
    public async Task A_member_the_club_has_not_said_yes_to_cannot_book_for_themselves(
        MembershipStatus status, string expectedError)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory, status);
        var member = ClientFor(factory, s, s.MemberUserId);

        var (code, body) = await PostAsync(member, MemberBookingsPath,
            new { courtId = s.CourtId, startsAt = SlotAt(), sliceCount = 1 });

        Assert.Equal(HttpStatusCode.Forbidden, code);
        Assert.Equal(expectedError, body.GetProperty("error").GetString());
        Assert.Equal(status.ToString(), body.GetProperty("status").GetString());
        await AssertNothingHappenedAsync(factory, s);
    }

    /// <summary>
    /// The regression itself. The desk, not the member, and the desk holds a real admin token
    /// — so nothing about authorization stops this call. What stops it is that the PAYER has
    /// not been approved.
    /// </summary>
    [SkippableTheory]
    [InlineData(MembershipStatus.Suspended, "member_suspended")]
    [InlineData(MembershipStatus.PendingApproval, "member_not_active")]
    [InlineData(MembershipStatus.Rejected, "member_not_active")]
    public async Task The_desk_cannot_book_on_behalf_of_a_member_the_box_will_refuse(
        MembershipStatus status, string expectedError)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory, status);
        var admin = ClientFor(factory, s, s.AdminUserId, isAdmin: true);

        var (code, body) = await PostAsync(admin, AdminBookingsPath,
            new { courtId = s.CourtId, userId = s.MemberUserId, startsAt = SlotAt(), sliceCount = 1 });

        Assert.Equal(HttpStatusCode.Forbidden, code);
        Assert.Equal(expectedError, body.GetProperty("error").GetString());
        Assert.Equal(status.ToString(), body.GetProperty("status").GetString());
        await AssertNothingHappenedAsync(factory, s);
    }

    /// <summary>
    /// The overdraft override does not buy past the membership rule. §8 lets the desk create
    /// a negative balance for a member who is short; it says nothing about a member the club
    /// has not approved, and a flag that quietly did both would be the worst version of this
    /// bug — an unapproved applicant put into DEBT for a court that cannot be opened.
    /// </summary>
    [SkippableFact]
    public async Task The_overdraft_override_does_not_buy_past_the_membership_rule()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory, MembershipStatus.PendingApproval);
        var admin = ClientFor(factory, s, s.AdminUserId, isAdmin: true);

        var (code, body) = await PostAsync(admin, AdminBookingsPath, new
        {
            courtId = s.CourtId,
            userId = s.MemberUserId,
            startsAt = SlotAt(),
            sliceCount = 1,
            allowNegativeBalance = true,
        });

        Assert.Equal(HttpStatusCode.Forbidden, code);
        Assert.Equal("member_not_active", body.GetProperty("error").GetString());
        await AssertNothingHappenedAsync(factory, s);
    }

    /// <summary>
    /// The fixture, varied — the direction that proves the three above are not passing because
    /// the route refuses everybody. One field changes: the member is Active.
    /// </summary>
    [SkippableFact]
    public async Task An_active_member_still_books_on_both_routes()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory, MembershipStatus.Active);

        var member = ClientFor(factory, s, s.MemberUserId);
        var (ownCode, ownBody) = await PostAsync(member, MemberBookingsPath,
            new { courtId = s.CourtId, startsAt = SlotAt(9), sliceCount = 1 });
        Assert.Equal(HttpStatusCode.OK, ownCode);
        Assert.Equal(MemberFloatMinutes - SliceMinutes, ownBody.GetProperty("balance_after_minutes").GetInt32());

        var admin = ClientFor(factory, s, s.AdminUserId, isAdmin: true);
        var (deskCode, deskBody) = await PostAsync(admin, AdminBookingsPath,
            new { courtId = s.CourtId, userId = s.MemberUserId, startsAt = SlotAt(11), sliceCount = 1 });
        Assert.Equal(HttpStatusCode.OK, deskCode);
        Assert.Equal(MemberFloatMinutes - (2 * SliceMinutes), deskBody.GetProperty("balance_after_minutes").GetInt32());
    }
}
