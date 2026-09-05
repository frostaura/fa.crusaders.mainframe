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
/// The defects a dispassionate audit found in code that was already green, pinned so they
/// cannot come back.
///
/// <para>
/// Every test here failed before its fix and names what it costs, because "a security
/// test" that nobody has watched go red is a comment. They run over real HTTP against
/// real Postgres deliberately: three of the four were invisible at the service layer —
/// they lived in what the <i>route</i> passed the service, or in what the middleware did
/// not do before either of them ran.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class SecurityRegressionTests
{
    private readonly PostgresFixture _pg;

    public SecurityRegressionTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private sealed record Club(Guid TenantId, string Slug, Guid AdminId, Guid VictimId, Guid AttackerId, Guid BookingId);

    /// <summary>A club with two ordinary members, one of whom holds a paid-for booking.</summary>
    private static async Task<Club> SeedAsync(TestWebAppFactory factory, string? slugOverride = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = slugOverride ?? $"sec-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Security Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            // A penalty window wide enough that a cancellation now lands inside it, which is
            // what makes the IDOR cost the victim money rather than merely lose them a court.
            SettingsJson = """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"slice_price_credits":8,"grace_window_minutes":5,"penalty_pct":30,"penalty_window_minutes":600,"timezone":"UTC"}""",
        });

        var admin = new User { TenantId = tenant.Id, Email = $"a-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        var victim = new User { TenantId = tenant.Id, Email = $"v-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        var attacker = new User { TenantId = tenant.Id, Email = $"x-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.AddRange(admin, victim, attacker);

        db.Memberships.AddRange(
            new Membership { TenantId = tenant.Id, UserId = admin.Id, FullName = "Club Admin", MembershipNumber = $"A-{slug}", Status = MembershipStatus.Active },
            new Membership { TenantId = tenant.Id, UserId = victim.Id, FullName = "Victim Member", MembershipNumber = $"V-{slug}", Status = MembershipStatus.Active },
            new Membership { TenantId = tenant.Id, UserId = attacker.Id, FullName = "Other Member", MembershipNumber = $"X-{slug}", Status = MembershipStatus.Active });

        var court = new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1", SlicePriceCredits = 50m };
        db.Courts.Add(court);

        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = tenant.Id, UserId = victim.Id, Type = LedgerEntryType.TopUp,
            AmountCredits = 500m, ActorUserId = victim.Id, Reason = "seed",
        });

        // Charged at booking, like every row CreateAsync writes.
        var startsAt = DateTimeOffset.UtcNow.AddHours(4);
        var booking = new Booking
        {
            TenantId = tenant.Id, CourtId = court.Id, UserId = victim.Id,
            BookedByUserId = victim.Id, PaidByUserId = victim.Id,
            StartsAt = startsAt, EndsAt = startsAt.AddMinutes(60),
            SliceMinutes = 15, SliceCount = 4, AmountChargedCredits = 200m,
            Status = BookingStatus.Booked, ChargedAt = DateTimeOffset.UtcNow,
        };
        db.Bookings.Add(booking);
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = tenant.Id, UserId = victim.Id, Type = LedgerEntryType.BookingCharge,
            AmountCredits = -200m, ActorUserId = victim.Id, RelatedBookingId = booking.Id, Reason = "seed charge",
        });

        await db.SaveChangesAsync();
        return new Club(tenant.Id, slug, admin.Id, victim.Id, attacker.Id, booking.Id);
    }

    private static string Token(Guid tenantId, string slug, Guid subject, string? role, string purpose = "access")
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, subject.ToString()),
            new("tenant_id", tenantId.ToString()),
            new("tenant_slug", slug),
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

    private static HttpClient ClientFor(TestWebAppFactory factory, Club club, Guid subject, string? role = null)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", Token(club.TenantId, club.Slug, subject, role));
        return client;
    }

    private static async Task<decimal> BalanceAsync(TestWebAppFactory factory, Guid tenantId, Guid userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == tenantId && l.UserId == userId)
            .SumAsync(l => (decimal?)l.AmountCredits) ?? 0m;
    }

    /// <summary>
    /// The in-tenant IDOR: a member cancelling a stranger's booking.
    ///
    /// <para>
    /// The member route passed the caller's own id as the actor, and the service read
    /// "actor is not the owner" as an administrator acting on someone's behalf. Both halves
    /// were reasonable alone. Together they meant any member could lift a booking id off
    /// <c>GET /api/v1/schedule</c> and cancel it — and because a non-owner skipped the
    /// self-cancel guard and never waived the penalty, the victim was charged 30% for a
    /// cancellation they did not make.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_member_cannot_cancel_another_members_booking()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var before = await BalanceAsync(factory, club.TenantId, club.VictimId);

        using var attacker = ClientFor(factory, club, club.AttackerId);
        var response = await attacker.PostAsync($"/api/v1/bookings/{club.BookingId}/cancel", null);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var booking = await db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == club.BookingId);

        Assert.Equal(BookingStatus.Booked, booking.Status);
        Assert.Null(booking.CancelledAt);

        // Not one credit moved — no refund, and above all no penalty.
        Assert.Equal(before, await BalanceAsync(factory, club.TenantId, club.VictimId));
    }

    /// <summary>The owner's own cancellation still works, so the guard is a lock and not a wall.</summary>
    [SkippableFact]
    public async Task The_owner_can_still_cancel_their_own_booking()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);

        using var owner = ClientFor(factory, club, club.VictimId);
        var response = await owner.PostAsync($"/api/v1/bookings/{club.BookingId}/cancel", null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var booking = await db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == club.BookingId);
        Assert.Equal(BookingStatus.Cancelled, booking.Status);
    }

    /// <summary>An admin still cancels on a member's behalf — that path is the one being protected.</summary>
    [SkippableFact]
    public async Task An_admin_can_still_cancel_on_a_members_behalf()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);

        using var admin = ClientFor(factory, club, club.AdminId, role: "admin");
        var response = await admin.PostAsJsonAsync(
            $"/api/v1/admin/bookings/{club.BookingId}/cancel", new { waivePenalty = true });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var booking = await db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == club.BookingId);
        Assert.Equal(BookingStatus.Cancelled, booking.Status);
    }

    /// <summary>
    /// Registration lands inside a tenant.
    ///
    /// <para>
    /// <c>/api/v1/auth/</c> skipped tenant resolution entirely, so <c>AuthService</c> stamped
    /// <c>Guid.Empty</c> on the user, the membership and the audit row. The member was then
    /// invisible to the admin screen and could never be approved — and, worse, invisible to
    /// the duplicate-email check, which is filtered to that same empty tenant. The unique
    /// index is <c>(TenantId, Email)</c>, so an anonymous caller could register an address
    /// that already belonged to a real member and get a second row.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Registering_lands_the_new_member_inside_a_real_tenant()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);

        // No token and no subdomain — the shape of a real registration from the PWA.
        using var anonymous = factory.CreateClient();
        anonymous.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";

        var email = $"new-{Guid.NewGuid():N}@test.local";
        var response = await anonymous.PostAsJsonAsync("/api/v1/auth/register", new
        {
            email,
            password = "a-long-enough-password",
            fullName = "New Member",
            membershipNumber = $"N-{Guid.NewGuid():N}"[..10],
        });

        Assert.True(response.IsSuccessStatusCode, $"register returned {response.StatusCode}: {await response.Content.ReadAsStringAsync()}");

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var user = await db.Users.IgnoreQueryFilters().FirstAsync(u => u.Email == email);

        Assert.NotEqual(Guid.Empty, user.TenantId);
        Assert.Equal(club.TenantId, user.TenantId);

        // The membership too — an approvable member is one the admin screen can see.
        var membership = await db.Memberships.IgnoreQueryFilters().FirstAsync(m => m.UserId == user.Id);
        Assert.Equal(club.TenantId, membership.TenantId);
    }

    /// <summary>
    /// The consequence the empty tenant actually had: registering somebody else's address.
    /// </summary>
    [SkippableFact]
    public async Task Registering_an_address_that_already_exists_in_the_tenant_is_refused()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);

        string existingEmail;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            existingEmail = (await db.Users.IgnoreQueryFilters().FirstAsync(u => u.Id == club.AdminId)).Email;
        }

        using var anonymous = factory.CreateClient();
        anonymous.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";

        var response = await anonymous.PostAsJsonAsync("/api/v1/auth/register", new
        {
            email = existingEmail,
            password = "a-long-enough-password",
            fullName = "Impostor",
            membershipNumber = $"I-{Guid.NewGuid():N}"[..10],
        });

        Assert.False(response.IsSuccessStatusCode);

        using var check = factory.Services.CreateScope();
        var db2 = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var rows = await db2.Users.IgnoreQueryFilters().CountAsync(u => u.Email == existingEmail);
        Assert.Equal(1, rows);
    }

    /// <summary>
    /// A platform admin in one tenant is not in another tenant's user list.
    ///
    /// <para>
    /// The <c>Users</c> query filter carried <c>|| u.IsPlatformAdmin</c> — the only
    /// disjunction in the model. It put every platform-admin row in the deployment inside
    /// every tenant, and the credit-adjustment endpoint's existence check passed on one, so
    /// a tenant admin could post a ledger entry in their own tenant against a user who was
    /// not in it.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_platform_admin_from_another_tenant_cannot_be_credited()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);

        Guid outsiderId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var otherTenant = new Tenant { Slug = $"other-{Guid.NewGuid():N}"[..20], DisplayName = "Another Club" };
            db.Tenants.Add(otherTenant);
            var outsider = new User
            {
                TenantId = otherTenant.Id,
                Email = $"platform-{Guid.NewGuid():N}@test.local",
                PasswordHash = "x",
                EmailVerified = true,
                IsPlatformAdmin = true,
            };
            db.Users.Add(outsider);
            await db.SaveChangesAsync();
            outsiderId = outsider.Id;
        }

        using var admin = ClientFor(factory, club, club.AdminId, role: "admin");
        var response = await admin.PostAsJsonAsync(
            $"/api/v1/admin/credit/{outsiderId}/adjust", new { amountCredits = 1000m, reason = "gift" });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(0m, await BalanceAsync(factory, club.TenantId, outsiderId));
    }

    /// <summary>
    /// A QR code minted by one club does not identify anybody at another club's court.
    ///
    /// <para>
    /// When the QR was a JWT it carried <c>tenant_id</c> and nothing read it back. What kept
    /// a cross-tenant booking row from being written was incidental — the balance sum is
    /// tenant-filtered, so a foreign member reads as zero credits and the walk-up ends in
    /// 402. That is an arithmetic accident, not isolation, and the 400-vs-402 split it left
    /// behind was a working oracle for "is this a live member token of some other club?".
    /// The code is now a row, and the row is tenant-filtered like every other read, so the
    /// isolation is the query filter rather than a comparison somebody has to remember.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_qr_code_from_another_tenant_identifies_nobody()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var home = await SeedAsync(factory);
        var away = await SeedAsync(factory);

        // A genuine, unexpired code — for the away club's member.
        var foreignQr = await TestAccessCodes.MintIdentAsync(factory.Services, away.TenantId, away.Slug, away.VictimId);

        using var kiosk = ClientFor(factory, home, home.AdminId, role: "admin");
        var response = await kiosk.PostAsJsonAsync("/api/v1/court/1/qr/match", new { token = foreignQr });

        // 200 with matched:false, not a 4xx — the endpoint answers every unusable token
        // identically on purpose, so it cannot be used to sort real tokens from junk. What
        // this test pins is that a foreign token lands in that same bucket.
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var payload = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.False(payload.RootElement.GetProperty("matched").GetBoolean());
        Assert.Equal("invalid_or_expired", payload.RootElement.GetProperty("reason").GetString());

        // And nothing was written into the home club under the away club's member.
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.False(await db.Bookings.IgnoreQueryFilters()
            .AnyAsync(b => b.TenantId == home.TenantId && b.UserId == away.VictimId));
    }

    /// <summary>
    /// The payer override needs proof, not a guid.
    ///
    /// <para>
    /// <c>payer_user_id</c> off the request body moved a full court charge onto any member
    /// in the tenant, and the ids are handed to every authenticated member by the schedule.
    /// The <c>admin</c> role was no defence — that is the role the shared courtside kiosk
    /// runs as.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_payer_override_that_cannot_be_identified_is_refused()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var before = await BalanceAsync(factory, club.TenantId, club.AttackerId);

        using var kiosk = ClientFor(factory, club, club.AdminId, role: "admin");

        // The old exploit, expressed in the new contract: naming a member is not identifying
        // them, and a bare id is no longer even a field the endpoint reads.
        var response = await kiosk.PostAsJsonAsync(
            $"/api/v1/court/1/biometric/match",
            new { payerMethod = "qr", payerToken = club.AttackerId.ToString() });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("payer_not_recognised", body);

        Assert.Equal(before, await BalanceAsync(factory, club.TenantId, club.AttackerId));
    }

    /// <summary>
    /// A PIN cannot stand in for the volunteer either, for the reason a PIN is never a
    /// global identifier: four digits checked against the whole roll rather than against a
    /// booking's candidates.
    /// </summary>
    [SkippableFact]
    public async Task A_payer_override_by_pin_is_refused()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);

        using var kiosk = ClientFor(factory, club, club.AdminId, role: "admin");
        var response = await kiosk.PostAsJsonAsync(
            $"/api/v1/court/1/biometric/match", new { payerMethod = "pin", payerToken = "4731" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("payer_not_recognised", await response.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// A booking-activation code is not a wallet (closing re-review #19): pushed in clear to
    /// every box driving the court and held in box RAM for hours, it must open only its own
    /// booking. Presented as the volunteer's token it is refused, and the victim is charged
    /// for nobody's court.
    /// </summary>
    [SkippableFact]
    public async Task A_booking_code_is_refused_as_the_payer_override()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var before = await BalanceAsync(factory, club.TenantId, club.VictimId);
        var victimsBookingCode = await TestAccessCodes.InsertBookingCodeAsync(factory.Services, club.TenantId, club.VictimId, club.BookingId);

        using var kiosk = ClientFor(factory, club, club.AdminId, role: "admin");
        var response = await kiosk.PostAsJsonAsync(
            $"/api/v1/court/1/biometric/match",
            new { payerMethod = "qr", payerToken = victimsBookingCode });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("payer_not_recognised", await response.Content.ReadAsStringAsync());
        Assert.Equal(before, await BalanceAsync(factory, club.TenantId, club.VictimId));
    }

    /// <summary>
    /// <c>AdjustRequest.RelatedBookingId</c> was copied onto the ledger row unchecked — any
    /// GUID, any member (round-3 finding 17). The id is not decoration: it is what nets a
    /// desk adjustment against that booking's automatic reversal, so a mis-picked id changed
    /// <b>somebody else's</b> settlement, and nothing on their ledger explained it. The UI
    /// offers a free-text "another booking — enter its ID" field, so the mis-pick is the
    /// expected accident, not an attack.
    ///
    /// <para>Settlement model I4: it must exist in this tenant and its payer must be the
    /// member being adjusted.</para>
    /// </summary>
    [SkippableFact]
    public async Task An_adjustment_cannot_name_another_members_booking()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        using var admin = ClientFor(factory, club, club.AdminId, role: "admin");

        // The victim's booking id, pasted into an adjustment on the other member's wallet.
        var crossed = await admin.PostAsJsonAsync(
            $"/api/v1/admin/credit/{club.AttackerId}/adjust",
            new { amountCredits = 10m, reason = "goodwill", relatedBookingId = club.BookingId });
        Assert.Equal(HttpStatusCode.BadRequest, crossed.StatusCode);
        Assert.Contains("booking_not_members", await crossed.Content.ReadAsStringAsync());

        // A booking id that is not one at all.
        var invented = await admin.PostAsJsonAsync(
            $"/api/v1/admin/credit/{club.AttackerId}/adjust",
            new { amountCredits = 10m, reason = "goodwill", relatedBookingId = Guid.NewGuid() });
        Assert.Equal(HttpStatusCode.BadRequest, invented.StatusCode);
        Assert.Contains("booking_not_found", await invented.Content.ReadAsStringAsync());

        // Nothing was posted on either attempt.
        Assert.Equal(0m, await BalanceAsync(factory, club.TenantId, club.AttackerId));

        // The member's own booking is accepted, so the refusal is about ownership and not
        // about the field.
        var owned = await admin.PostAsJsonAsync(
            $"/api/v1/admin/credit/{club.VictimId}/adjust",
            new { amountCredits = 10m, reason = "goodwill", relatedBookingId = club.BookingId });
        Assert.Equal(HttpStatusCode.OK, owned.StatusCode);
    }
}
