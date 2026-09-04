using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// What the member's phone is told to show.
///
/// <para>
/// <c>POST /api/v1/me/qr/generate</c> answers with an access code, never a JWT — the box's
/// scanner pipeline carries 24 bytes and a token never fitted (review H2). Which code it
/// answers with depends on whether a booking is in reach: the booking's own code when
/// one is, so the box finds the roster entry without a search; a short-lived member-ident
/// code otherwise, for walk-ups and the payer override.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class QrEndpointHttpTests
{
    private readonly PostgresFixture _pg;

    public QrEndpointHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string GeneratePath = "/api/v1/me/qr/generate";

    private sealed record Seeded(Guid TenantId, string Slug, Guid MemberId, Guid CourtId);

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static async Task<Seeded> SeedAsync(
        TestWebAppFactory factory,
        string settingsJson = """{"slice_minutes":15,"grace_window_minutes":5,"timezone":"UTC","qr_lifetime_seconds":45,"roster_window_minutes":120,"activation_cue_window_minutes":10}""")
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"qr-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "QR Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = settingsJson });

        var member = new User { TenantId = tenant.Id, Email = $"{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.Add(member);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = member.Id,
            FullName = "QR Member",
            MembershipNumber = slug,
            Status = MembershipStatus.Active,
            MemberClass = MemberClass.Regular,
        });

        var court = new Court { TenantId = tenant.Id, CourtNumber = 2, Name = "Court 2", SlicePriceCredits = 8m };
        db.Courts.Add(court);

        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, member.Id, court.Id);
    }

    private static async Task<Guid> BookAsync(TestWebAppFactory factory, Seeded s, DateTimeOffset startsAt, int minutes = 30)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var booking = new Booking
        {
            TenantId = s.TenantId,
            CourtId = s.CourtId,
            UserId = s.MemberId,
            BookedByUserId = s.MemberId,
            PaidByUserId = s.MemberId,
            ActorUserId = s.MemberId,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(minutes),
            SliceMinutes = 15,
            SliceCount = minutes / 15,
            AmountChargedCredits = 8m * (minutes / 15),
            Status = BookingStatus.Booked,
            ChargedAt = DateTimeOffset.UtcNow,
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking.Id;
    }

    private static HttpClient MemberClient(TestWebAppFactory factory, Seeded s)
    {
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, s.MemberId.ToString()),
                new Claim("tenant_id", s.TenantId.ToString()),
                new Claim("tenant_slug", s.Slug),
                new Claim("purpose", "access"),
            ],
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));

        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", new JwtSecurityTokenHandler().WriteToken(token));
        return client;
    }

    private static async Task<JsonElement> GenerateAsync(HttpClient client)
    {
        var response = await client.PostAsync(GeneratePath, null);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
    }

    /// <summary>
    /// A booking an hour away is inside the roster window, so the phone shows that
    /// booking's code — lazily minted here, since the row was seeded without one — and
    /// says which booking, which court and when.
    /// </summary>
    [SkippableFact]
    public async Task A_member_with_a_booking_in_reach_is_shown_that_bookings_code()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        var startsAt = DateTimeOffset.UtcNow.AddHours(1);
        var bookingId = await BookAsync(factory, s, startsAt);

        var json = await GenerateAsync(MemberClient(factory, s));

        Assert.Equal("booking", json.GetProperty("kind").GetString());
        Assert.Equal(bookingId, json.GetProperty("booking_id").GetGuid());
        Assert.Equal(2, json.GetProperty("court_number").GetInt32());
        Assert.Equal(startsAt.ToUniversalTime(), json.GetProperty("starts_at").GetDateTimeOffset().ToUniversalTime(), TimeSpan.FromSeconds(1));

        var code = json.GetProperty("code").GetString()!;
        Assert.Equal(AccessCode.Length, code.Length);
        Assert.All(code, ch => Assert.Contains(ch, AccessCodeService.Alphabet));

        // Lives until the booking ends plus the grace window (5): 60 + 30 + 5 minutes from now.
        var expiresIn = json.GetProperty("expires_in_seconds").GetInt32();
        Assert.InRange(expiresIn, 95 * 60 - 30, 95 * 60);

        // Asking again shows the SAME code — one booking, one code.
        var again = await GenerateAsync(MemberClient(factory, s));
        Assert.Equal(code, again.GetProperty("code").GetString());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.AccessCodes.IgnoreQueryFilters().SingleAsync(c => c.BookingId == bookingId);
        Assert.Equal(AccessCodePurpose.BookingActivation, row.Purpose);
        Assert.Equal(code, row.Code);
    }

    /// <summary>
    /// No booking in reach — none at all, or one too far ahead for the roster window — so
    /// the phone shows a member-ident code that lives <c>qr_lifetime_seconds</c>.
    /// </summary>
    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_member_with_no_booking_in_reach_is_shown_an_ident_code(bool bookingTooFarAhead)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        if (bookingTooFarAhead)
        {
            // Roster window 120 + cue 10 = 130 minutes of reach; three hours is past it.
            await BookAsync(factory, s, DateTimeOffset.UtcNow.AddHours(3));
        }

        var json = await GenerateAsync(MemberClient(factory, s));

        Assert.Equal("ident", json.GetProperty("kind").GetString());
        Assert.False(json.TryGetProperty("booking_id", out _));

        var code = json.GetProperty("code").GetString()!;
        Assert.Equal(AccessCode.Length, code.Length);

        // The tenant's qr_lifetime_seconds (45 in this fixture), not a hardcoded 60.
        var expiresIn = json.GetProperty("expires_in_seconds").GetInt32();
        Assert.InRange(expiresIn, 40, 45);

        // Reused while it lives.
        var again = await GenerateAsync(MemberClient(factory, s));
        Assert.Equal(code, again.GetProperty("code").GetString());
        Assert.True(again.GetProperty("expires_in_seconds").GetInt32() <= expiresIn);
    }

    /// <summary>
    /// The cue window reaches BEFORE a booking starts: a booking whose start is just past
    /// the roster horizon but whose cue window is inside it still counts as in reach.
    /// </summary>
    [SkippableFact]
    public async Task The_cue_window_extends_the_reach_ahead_of_a_bookings_start()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);

        // Roster 120 + cue 10 = 130; a booking at +125 is in reach, one at +135 is not.
        var near = await BookAsync(factory, s, DateTimeOffset.UtcNow.AddMinutes(125));
        var json = await GenerateAsync(MemberClient(factory, s));
        Assert.Equal("booking", json.GetProperty("kind").GetString());
        Assert.Equal(near, json.GetProperty("booking_id").GetGuid());

        var far = await SeedAsync(factory);
        await BookAsync(factory, far, DateTimeOffset.UtcNow.AddMinutes(135));
        Assert.Equal("ident", (await GenerateAsync(MemberClient(factory, far))).GetProperty("kind").GetString());
    }

    /// <summary>The whole loop: the code the phone was shown opens the court at the camera.</summary>
    [SkippableFact]
    public async Task The_code_the_phone_shows_is_the_code_the_court_accepts()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var s = await SeedAsync(factory);
        await BookAsync(factory, s, DateTimeOffset.UtcNow.AddMinutes(-1));

        var code = (await GenerateAsync(MemberClient(factory, s))).GetProperty("code").GetString()!;

        var admin = MemberClient(factory, s);   // any authenticated principal; role is added below
        admin.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", AdminToken(s));
        var match = await admin.PostAsJsonAsync("/api/v1/court/2/qr/match", new { Token = code });

        Assert.Equal(HttpStatusCode.OK, match.StatusCode);
        var json = JsonDocument.Parse(await match.Content.ReadAsStringAsync()).RootElement;
        Assert.True(json.GetProperty("matched").GetBoolean());
    }

    private static string AdminToken(Seeded s)
    {
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, s.MemberId.ToString()),
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
}
