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
/// <c>feature-spec.md</c> §8's admin override, over real HTTP: the club desk books for a
/// member who is short, is refused with the figures, and comes back having asked for the
/// overdraft by name.
///
/// <para>
/// Postgres-backed rather than in-memory because this is the money path. The in-memory
/// provider has no transaction and no numeric column, so a test written against it can pass
/// while demonstrating the failure it was meant to catch (<c>memory/gotchas.md</c>). The
/// service-level shape of the override is pinned in <c>AdminOverdraftBookingTests</c>; what
/// is only observable here is the wiring — which request record carries the flag, which
/// route reads it, and the fact that the member's own endpoint cannot.
/// </para>
/// </summary>
public sealed class AdminOverdraftBookingHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public AdminOverdraftBookingHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string MemberBookingsPath = "/api/v1/bookings/";
    private const string AdminBookingsPath = "/api/v1/admin/bookings/";

    /// <summary>Whole numbers throughout, so a wrong figure is obvious in a failure message.</summary>
    private const int SlicePriceCredits = 50;
    private const int MemberFloatMinutes = 10;

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId, Guid MemberUserId, Guid CourtId);

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    /// <summary>
    /// Hours 00:00–24:00 and no peak window, so every assertion here is about the balance
    /// rule and not about what time the suite happens to run.
    /// </summary>
    private const string SettingsJson = """
        {"slice_minutes":15,"slice_price_credits":50,"penalty_pct":30,"grace_window_minutes":5,
         "penalty_window_minutes":15,"advance_booking_days":14,"timezone":"UTC",
         "member_per_day_max_minutes":600,"peak_hours":"16:00-19:00","peak_advance_hours_for_regular":1,
         "day_start_minute":0,"day_end_minute":1440}
        """;

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"od-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Overdraft Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = SettingsJson });

        var admin = new User { TenantId = tenant.Id, Email = $"admin-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        var member = new User { TenantId = tenant.Id, Email = $"member-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.AddRange(admin, member);
        db.Memberships.AddRange(
            new Membership { TenantId = tenant.Id, UserId = admin.Id, FullName = "Desk Admin", MembershipNumber = $"{slug}-A", Status = MembershipStatus.Active },
            new Membership { TenantId = tenant.Id, UserId = member.Id, FullName = "Naledi Khoza", MembershipNumber = $"{slug}-M", Status = MembershipStatus.Active });

        var court = new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1" };
        db.Courts.Add(court);

        // Short, deliberately: 10 credits against a 50-credit court is the exact situation
        // §8's override exists for. The desk account gets nothing — a club desk is never
        // topped up, because it never plays.
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
        return new Seeded(tenant.Id, slug, admin.Id, member.Id, court.Id);
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

    /// <summary>A slot at least two days out, outside the peak window, whatever time the suite runs.</summary>
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

    /// <summary>
    /// The first half of the interaction, and the reason the override is safe to have: the
    /// desk is refused, and told the member's balance and the price, before anything can be
    /// overridden. Those two figures are what the confirmation screen puts in front of the
    /// admin, so a mis-picked member is caught by reading rather than by an audit later.
    /// </summary>
    [SkippableFact]
    public async Task Booking_for_a_short_member_is_refused_first_with_the_two_figures_the_desk_needs()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var admin = ClientFor(factory, s, s.AdminUserId, isAdmin: true);

        var (status, body) = await PostAsync(admin, AdminBookingsPath,
            new { courtId = s.CourtId, userId = s.MemberUserId, startsAt = SlotAt(), sliceCount = 1 });

        Assert.Equal(HttpStatusCode.PaymentRequired, status);
        Assert.Equal("insufficient_balance", body.GetProperty("error").GetString());
        Assert.Equal(MemberFloatMinutes, body.GetProperty("current_minutes").GetDecimal());
        Assert.Equal(SlicePriceCredits, body.GetProperty("required_minutes").GetDecimal());
    }

    /// <summary>
    /// §8's promise, end to end. Nothing here is a special money path: one
    /// <c>BookingCharge</c> at the quoted price, the audit row naming the actor, the member
    /// and the balance it left, and the response quoting the same negative figure the ledger
    /// holds.
    /// </summary>
    [SkippableFact]
    public async Task The_desk_can_override_that_refusal_and_the_member_goes_negative_on_the_record()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var admin = ClientFor(factory, s, s.AdminUserId, isAdmin: true);

        var (status, body) = await PostAsync(admin, AdminBookingsPath, new
        {
            courtId = s.CourtId,
            userId = s.MemberUserId,
            startsAt = SlotAt(),
            sliceCount = 1,
            allowNegativeBalance = true,
        });

        Assert.Equal(HttpStatusCode.OK, status);
        var bookingId = body.GetProperty("booking_id").GetGuid();
        Assert.Equal(MemberFloatMinutes - SlicePriceCredits, body.GetProperty("balance_after_minutes").GetDecimal());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var rows = await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == s.TenantId && l.UserId == s.MemberUserId).ToListAsync();
        var charge = Assert.Single(rows, l => l.RelatedBookingId == bookingId);
        Assert.Equal(LedgerEntryType.BookingCharge, charge.Type);
        Assert.Equal(-SlicePriceCredits, charge.AmountMinutes);
        Assert.Equal(s.AdminUserId, charge.ActorUserId);
        Assert.Equal(MemberFloatMinutes - SlicePriceCredits, rows.Sum(l => l.AmountMinutes));

        // The admin's own wallet is untouched — the whole point of "charges that member's
        // credit" is that the desk is not the payer.
        Assert.Empty(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == s.TenantId && l.UserId == s.AdminUserId).ToListAsync());

        var audit = Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == s.TenantId && a.Action == "booking.created_on_behalf_overdrawn").ToListAsync());
        Assert.Equal(s.AdminUserId, audit.ActorUserId);
        Assert.Equal(s.MemberUserId, audit.SubjectUserId);

        using var details = JsonDocument.Parse(audit.DetailsJson!);
        Assert.True(details.RootElement.GetProperty("overdrawn").GetBoolean());
        Assert.Equal(MemberFloatMinutes - SlicePriceCredits,
            details.RootElement.GetProperty("balance_after_minutes").GetDecimal());
    }

    /// <summary>
    /// The boundary. A member sending the same field on their own booking gets the ordinary
    /// refusal — the field is not on <c>CreateBookingRequest</c> at all, and the service
    /// would refuse it anyway because the member holds no admin role (the rule since decision
    /// R19; it used to be "because the actor is the payer"). Both halves are asserted at once
    /// by sending the field and watching nothing happen.
    /// </summary>
    [SkippableFact]
    public async Task A_member_cannot_overdraw_themselves_by_sending_the_field()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var member = ClientFor(factory, s, s.MemberUserId);

        var (status, body) = await PostAsync(member, MemberBookingsPath, new
        {
            courtId = s.CourtId,
            startsAt = SlotAt(),
            sliceCount = 1,
            allowNegativeBalance = true,
        });

        Assert.Equal(HttpStatusCode.PaymentRequired, status);
        Assert.Equal("insufficient_balance", body.GetProperty("error").GetString());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Empty(await db.Bookings.IgnoreQueryFilters().Where(b => b.TenantId == s.TenantId).ToListAsync());
        Assert.Equal(MemberFloatMinutes, await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == s.TenantId && l.UserId == s.MemberUserId).SumAsync(l => l.AmountMinutes));
    }

    /// <summary>
    /// <b>Flipped deliberately by decision R19 (2026-09-23, "admin god mode").</b> This was
    /// <c>An_admin_cannot_overdraw_their_own_wallet_through_the_admin_route</c>. The admin
    /// route with <c>userId</c> = self and the flag set is now HOW an admin books themselves
    /// into the red: one ordinary <c>BookingCharge</c>, and a
    /// <c>booking.overdraft_authorised</c> row in the undeletable change record. The member
    /// route still cannot — see <see cref="A_member_cannot_overdraw_themselves_by_sending_the_field"/>
    /// and <see cref="An_admin_on_the_member_route_cannot_overdraw_even_with_the_field"/>.
    /// </summary>
    [SkippableFact]
    public async Task An_admin_can_overdraw_their_own_wallet_through_the_admin_route_on_the_record()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var admin = ClientFor(factory, s, s.AdminUserId, isAdmin: true);

        var (status, body) = await PostAsync(admin, AdminBookingsPath, new
        {
            courtId = s.CourtId,
            userId = s.AdminUserId,
            startsAt = SlotAt(),
            sliceCount = 1,
            allowNegativeBalance = true,
        });

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(-SlicePriceCredits, body.GetProperty("balance_after_minutes").GetDecimal());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var charge = Assert.Single(await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == s.TenantId && l.UserId == s.AdminUserId).ToListAsync());
        Assert.Equal(LedgerEntryType.BookingCharge, charge.Type);
        Assert.Equal(-SlicePriceCredits, charge.AmountMinutes);

        var row = Assert.Single(await db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == s.TenantId).ToListAsync());
        Assert.Equal("booking.overdraft_authorised", row.Action);
        Assert.Equal(s.AdminUserId, row.ActorUserId);
        Assert.Equal(s.AdminUserId, row.SubjectId);
        using var after = JsonDocument.Parse(row.AfterJson!);
        Assert.Equal(-SlicePriceCredits, after.RootElement.GetProperty("balance_minutes").GetDecimal());
        Assert.True(after.RootElement.GetProperty("self").GetBoolean());
    }

    /// <summary>
    /// God mode is the ADMIN route. An admin booking on the member route is booking as a
    /// member for money purposes: that request record has no flag, so sending one binds to
    /// nothing and the ordinary 402 comes back.
    /// </summary>
    [SkippableFact]
    public async Task An_admin_on_the_member_route_cannot_overdraw_even_with_the_field()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var admin = ClientFor(factory, s, s.AdminUserId, isAdmin: true);

        var (status, body) = await PostAsync(admin, MemberBookingsPath, new
        {
            courtId = s.CourtId,
            startsAt = SlotAt(),
            sliceCount = 1,
            allowNegativeBalance = true,
        });

        Assert.Equal(HttpStatusCode.PaymentRequired, status);
        Assert.Equal("insufficient_balance", body.GetProperty("error").GetString());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Empty(await db.Bookings.IgnoreQueryFilters().Where(b => b.TenantId == s.TenantId).ToListAsync());
    }

    /// <summary>
    /// A member is not suspended by being in the red, and the club can dig them out. The
    /// top-up that follows an overdraft nets against it on the ledger — there is no separate
    /// debt record to reconcile, which is what "money is ledger-only" buys.
    /// </summary>
    [SkippableFact]
    public async Task A_top_up_after_an_overdraft_nets_against_it_on_the_ledger()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var admin = ClientFor(factory, s, s.AdminUserId, isAdmin: true);

        var (status, _) = await PostAsync(admin, AdminBookingsPath, new
        {
            courtId = s.CourtId,
            userId = s.MemberUserId,
            startsAt = SlotAt(),
            sliceCount = 1,
            allowNegativeBalance = true,
        });
        Assert.Equal(HttpStatusCode.OK, status);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = s.TenantId,
            UserId = s.MemberUserId,
            ActorUserId = s.MemberUserId,
            Type = LedgerEntryType.TopUp,
            AmountMinutes = 100,
            Reason = "Clearing the overdraft",
        });
        await db.SaveChangesAsync();

        Assert.Equal(MemberFloatMinutes - SlicePriceCredits + 100, await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == s.TenantId && l.UserId == s.MemberUserId).SumAsync(l => l.AmountMinutes));
    }
}
