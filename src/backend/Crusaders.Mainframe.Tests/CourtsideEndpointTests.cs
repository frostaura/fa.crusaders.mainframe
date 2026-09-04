using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The PIN and QR touchpoints over real HTTP, against the real schema.
///
/// <para>
/// <see cref="CourtActivationTests"/> proves the money semantics of the shared service.
/// These prove the <b>wiring</b> — that the endpoints actually reach it. Before this, both
/// were pure identity oracles: they looked a player up, returned a <c>user_id</c>, and
/// charged nothing. A correct activation service that no endpoint called would pass every
/// test in the other file.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class CourtsideEndpointTests
{
    private readonly PostgresFixture _pg;

    public CourtsideEndpointTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string Pin = "4731";

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId, Guid PlayerUserId, Guid BookingId, int CourtNumber);

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>A tenant with a court, a funded player holding a PIN, and a live booking.</summary>
    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();
        await db.Database.MigrateAsync();

        var slug = $"court-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Courtside Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = """{"slice_minutes":15,"slice_price_credits":8,"grace_window_minutes":5,"timezone":"UTC"}""",
        });

        var admin = new User { TenantId = tenant.Id, Email = $"a-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        var player = new User
        {
            TenantId = tenant.Id,
            Email = $"p-{slug}@test.local",
            PasswordHash = "x",
            EmailVerified = true,
            PinHash = hasher.Hash(Pin),
        };
        db.Users.AddRange(admin, player);

        db.Memberships.AddRange(
            new Membership { TenantId = tenant.Id, UserId = admin.Id, FullName = "Court Admin", MembershipNumber = $"A-{slug}", Status = MembershipStatus.Active, MemberClass = MemberClass.Regular },
            new Membership { TenantId = tenant.Id, UserId = player.Id, FullName = "Court Player", MembershipNumber = $"P-{slug}", Status = MembershipStatus.Active, MemberClass = MemberClass.Regular });

        var court = new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1", SlicePriceCredits = 8m };
        db.Courts.Add(court);

        // Funded, so the charge succeeds and the test is about wiring rather than balance.
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = tenant.Id,
            UserId = player.Id,
            Type = LedgerEntryType.TopUp,
            AmountCredits = 100m,
            ActorUserId = player.Id,
            Reason = "seed",
        });

        var startsAt = DateTimeOffset.UtcNow.AddMinutes(-1);
        var booking = new Booking
        {
            TenantId = tenant.Id,
            CourtId = court.Id,
            UserId = player.Id,
            BookedByUserId = player.Id,
            PaidByUserId = player.Id,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(15),
            SliceCount = 1,
            AmountChargedCredits = 8m,
            Status = BookingStatus.Booked,
        };
        db.Bookings.Add(booking);

        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, admin.Id, player.Id, booking.Id, court.CourtNumber);
    }

    private static string Token(Seeded s, Guid subject, string purpose, string? role)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, subject.ToString()),
            new("tenant_id", s.TenantId.ToString()),
            new("tenant_slug", s.Slug),
            new("purpose", purpose),
        };
        if (role is not null) claims.Add(new Claim(ClaimTypes.Role, role));

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

    private static HttpClient AdminClient(TestWebAppFactory factory, Seeded s)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", Token(s, s.AdminUserId, "access", "admin"));
        return client;
    }

    private static async Task<decimal> BalanceAsync(TestWebAppFactory factory, Seeded s)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        return await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.UserId == s.PlayerUserId)
            .SumAsync(l => l.AmountCredits);
    }

    private static async Task<Booking> BookingAsync(TestWebAppFactory factory, Seeded s)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.Bookings.IgnoreQueryFilters().AsNoTracking().SingleAsync(b => b.Id == s.BookingId);
    }

    // ---- PIN ---------------------------------------------------------------

    /// <summary>
    /// The defect, at the endpoint. This used to return <c>{matched:true, user_id}</c> and
    /// leave the balance untouched — a free game.
    /// </summary>
    [SkippableFact]
    public async Task A_correct_pin_charges_the_player_and_records_attendance()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var client = AdminClient(factory, s);

        Assert.Equal(100m, await BalanceAsync(factory, s));

        var response = await client.PostAsJsonAsync($"/api/v1/court/{s.CourtNumber}/pin/match", new { Pin });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.True(json.GetProperty("matched").GetBoolean());
        Assert.True(json.GetProperty("activated").GetBoolean());
        Assert.Equal(8m, json.GetProperty("amount_credits").GetDecimal());

        Assert.Equal(92m, await BalanceAsync(factory, s));

        var booking = await BookingAsync(factory, s);
        Assert.NotNull(booking.CheckedInAt);
        Assert.NotNull(booking.ChargedAt);
    }

    [SkippableFact]
    public async Task A_wrong_pin_charges_nothing()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var client = AdminClient(factory, s);

        var response = await client.PostAsJsonAsync($"/api/v1/court/{s.CourtNumber}/pin/match", new { Pin = "0000" });
        var body = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"status={(int)response.StatusCode} body={body}");
        var json = JsonDocument.Parse(body).RootElement;

        Assert.False(json.GetProperty("matched").GetBoolean());
        Assert.Equal(100m, await BalanceAsync(factory, s));
        Assert.Null((await BookingAsync(factory, s)).CheckedInAt);
    }

    // ---- QR ----------------------------------------------------------------

    /// <summary>
    /// The same defect on the QR path — identified, and charged nothing. The QR is an
    /// access code now, not a JWT (review H2); a member-ident code identifies the player
    /// and the booking is found from there, exactly as a scanned one would be.
    /// </summary>
    [SkippableFact]
    public async Task A_valid_qr_code_charges_the_player_and_records_attendance()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var client = AdminClient(factory, s);

        var qr = await TestAccessCodes.MintIdentAsync(factory.Services, s.TenantId, s.Slug, s.PlayerUserId);

        var response = await client.PostAsJsonAsync($"/api/v1/court/{s.CourtNumber}/qr/match", new { Token = qr });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.True(json.GetProperty("matched").GetBoolean());
        Assert.True(json.GetProperty("activated").GetBoolean());

        Assert.Equal(92m, await BalanceAsync(factory, s));

        var booking = await BookingAsync(factory, s);
        Assert.NotNull(booking.CheckedInAt);
        Assert.NotNull(booking.ChargedAt);
    }

    /// <summary>
    /// A QR token is still not a bearer token — the purpose check added earlier must survive
    /// this refactor, since the QR path now has money attached to it.
    /// </summary>
    [SkippableFact]
    public async Task A_qr_token_is_still_not_accepted_as_an_admin_bearer_token()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);

        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(
            "Bearer", Token(s, s.PlayerUserId, "qr_ident", role: "admin"));

        var response = await client.PostAsJsonAsync(
            $"/api/v1/court/{s.CourtNumber}/qr/match", new { Token = "irrelevant" });

        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(100m, await BalanceAsync(factory, s));
    }

    /// <summary>Two scans, one charge — the box retrying must not cost the member twice.</summary>
    [SkippableFact]
    public async Task Scanning_twice_charges_once()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var client = AdminClient(factory, s);

        await client.PostAsJsonAsync($"/api/v1/court/{s.CourtNumber}/pin/match", new { Pin });
        var second = await client.PostAsJsonAsync($"/api/v1/court/{s.CourtNumber}/pin/match", new { Pin });

        var json = JsonDocument.Parse(await second.Content.ReadAsStringAsync()).RootElement;
        Assert.True(json.GetProperty("already_active").GetBoolean());

        Assert.Equal(92m, await BalanceAsync(factory, s));
    }
}
