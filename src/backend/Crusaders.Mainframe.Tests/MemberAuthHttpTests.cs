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
/// The member-facing auth defects that only exist at the HTTP boundary: a status code, a response
/// body, a middleware that runs before the endpoint. None of them is visible at the service layer,
/// which is exactly why they survived a green suite.
///
/// <para>
/// Postgres-backed, because two of them turn on the real unique index and the real migration —
/// the duplicate membership number reached <c>SaveChangesAsync</c> and came back as a 500, and no
/// in-memory provider enforces an index at all.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class MemberAuthHttpTests
{
    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    private readonly PostgresFixture _pg;

    public MemberAuthHttpTests(PostgresFixture pg) => _pg = pg;

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private sealed record Club(Guid TenantId, string Slug, Guid AdminId, Guid MemberId, Guid MembershipId, string MemberEmail);

    private static async Task<Club> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();
        await db.Database.MigrateAsync();

        var slug = $"auth-{Guid.NewGuid():N}"[..18];
        var tenant = new Tenant { Slug = slug, DisplayName = "Auth Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = """{"slice_minutes":15,"slice_price_credits":8,"timezone":"UTC"}""",
        });

        var admin = new User { TenantId = tenant.Id, Email = $"a-{slug}@test.local", PasswordHash = hasher.Hash("AdminPass1!"), EmailVerified = true, IsAdmin = true };
        var member = new User { TenantId = tenant.Id, Email = $"m-{slug}@test.local", PasswordHash = hasher.Hash("MemberPass1!"), EmailVerified = true };
        db.Users.AddRange(admin, member);

        var adminMembership = new Membership { TenantId = tenant.Id, UserId = admin.Id, FullName = "Club Admin", MembershipNumber = $"A-{slug}", Status = MembershipStatus.Active };
        var memberMembership = new Membership { TenantId = tenant.Id, UserId = member.Id, FullName = "Ordinary Member", MembershipNumber = $"M-{slug}", Status = MembershipStatus.Active };
        db.Memberships.AddRange(adminMembership, memberMembership);

        await db.SaveChangesAsync();
        return new Club(tenant.Id, slug, admin.Id, member.Id, memberMembership.Id, member.Email);
    }

    private static string Token(Guid tenantId, string slug, Guid subject, string? role = null)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, subject.ToString()),
            new("tenant_id", tenantId.ToString()),
            new("tenant_slug", slug),
            new("purpose", "access"),
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
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Token(club.TenantId, club.Slug, subject, role));
        return client;
    }

    private static HttpClient AnonymousClientFor(TestWebAppFactory factory, Club club)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";
        return client;
    }

    private static async Task<string?> ErrorCodeAsync(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        if (string.IsNullOrWhiteSpace(body)) return null;
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : null;
    }

    /// <summary>
    /// The 500 a browser found: a membership number already in use reached the unique index, and
    /// the applicant was shown "Registration failed. Try again."
    /// </summary>
    [Fact]
    public async Task A_duplicate_membership_number_is_a_named_conflict_not_a_500()
    {
        if (!_pg.Available) return;
        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        using var client = AnonymousClientFor(factory, club);

        var response = await client.PostAsJsonAsync("/api/v1/auth/register", new
        {
            email = $"clash-{Guid.NewGuid():N}@test.local",
            password = "Pass1234!",
            fullName = "Number Clash",
            membershipNumber = $"M-{club.Slug}",   // already the seeded member's
            photoUrl = (string?)null,
        });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("membership_number_in_use", await ErrorCodeAsync(response));
    }

    /// <summary>
    /// Eight applicants claim the same membership number at once: one gets it, seven are told so,
    /// and nobody sees a 500.
    ///
    /// <para>
    /// The pre-check cannot decide this on its own — none of the eight has committed when the
    /// others look — so this is the branch that catches the unique violation and answers it with
    /// the same conflict the ordinary path returns. Without that branch the losers get the
    /// <c>DbUpdateException</c> back as an unhandled 500, which is the original defect with a
    /// narrower window.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Eight_applicants_racing_for_one_membership_number_produce_one_winner_and_no_500s()
    {
        if (!_pg.Available) return;
        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        var contested = $"RACE-{Guid.NewGuid():N}"[..16];

        var attempts = Enumerable.Range(0, 8).Select(async i =>
        {
            using var client = AnonymousClientFor(factory, club);
            return await client.PostAsJsonAsync("/api/v1/auth/register", new
            {
                email = $"racer-{i}-{Guid.NewGuid():N}@test.local",
                password = "Pass1234!",
                fullName = $"Racer {i}",
                membershipNumber = contested,
                photoUrl = (string?)null,
            });
        });

        var responses = await Task.WhenAll(attempts);
        try
        {
            Assert.DoesNotContain(responses, r => (int)r.StatusCode >= 500);
            Assert.Single(responses, r => r.StatusCode == HttpStatusCode.OK);
            Assert.All(responses.Where(r => r.StatusCode != HttpStatusCode.OK),
                r => Assert.Equal(HttpStatusCode.Conflict, r.StatusCode));
        }
        finally
        {
            foreach (var r in responses) r.Dispose();
        }
    }

    /// <summary>
    /// An unverified address must be answerable as itself. It used to be a bodyless 403, which the
    /// sign-in screen could only render as "Your account isn't approved yet" — to a member who was
    /// approved.
    /// </summary>
    [Fact]
    public async Task Login_names_an_unverified_address_separately_from_an_unapproved_membership()
    {
        if (!_pg.Available) return;
        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var user = await db.Users.IgnoreQueryFilters().FirstAsync(u => u.Id == club.MemberId);
            user.EmailVerified = false;
            await db.SaveChangesAsync();
        }

        using var client = AnonymousClientFor(factory, club);
        var response = await client.PostAsJsonAsync("/api/v1/auth/login", new { email = club.MemberEmail, password = "MemberPass1!" });

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("email_not_verified", await ErrorCodeAsync(response));
    }

    /// <summary>The resend endpoint exists, is anonymous, and says the same thing to everyone.</summary>
    [Fact]
    public async Task Resend_verification_answers_the_same_for_a_member_and_a_stranger()
    {
        if (!_pg.Available) return;
        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);
        using var client = AnonymousClientFor(factory, club);

        var known = await client.PostAsJsonAsync("/api/v1/auth/resend-verification", new { email = club.MemberEmail });
        var unknown = await client.PostAsJsonAsync("/api/v1/auth/resend-verification", new { email = "nobody-here@test.local" });

        Assert.Equal(HttpStatusCode.OK, known.StatusCode);
        Assert.Equal(HttpStatusCode.OK, unknown.StatusCode);
        Assert.Equal(await known.Content.ReadAsStringAsync(), await unknown.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// The whole D-F9 / F2 chain over HTTP: an admin resets, the member's session then reaches
    /// nothing but the change-password call, and changing it opens the app back up.
    ///
    /// <para>
    /// The enforcement has to be server-side. Routing the browser to a change-password screen is a
    /// suggestion to whatever holds the token, and the token was a full session.
    /// </para>
    /// </summary>
    [Fact]
    public async Task An_admin_reset_locks_the_session_to_the_change_password_call()
    {
        if (!_pg.Available) return;
        await using var factory = CreateFactory();
        var club = await SeedAsync(factory);

        string tempPassword;
        using (var admin = ClientFor(factory, club, club.AdminId, "admin"))
        {
            var reset = await admin.PostAsync($"/api/v1/admin/members/{club.MembershipId}/reset-password", content: null);
            Assert.Equal(HttpStatusCode.OK, reset.StatusCode);
            using var doc = JsonDocument.Parse(await reset.Content.ReadAsStringAsync());
            tempPassword = doc.RootElement.GetProperty("temp_password").GetString()!;
        }

        using (var anon = AnonymousClientFor(factory, club))
        {
            var login = await anon.PostAsJsonAsync("/api/v1/auth/login", new { email = club.MemberEmail, password = tempPassword });
            Assert.Equal(HttpStatusCode.OK, login.StatusCode);
            using var doc = JsonDocument.Parse(await login.Content.ReadAsStringAsync());
            Assert.True(doc.RootElement.GetProperty("must_change_password").GetBoolean());
        }

        using var member = ClientFor(factory, club, club.MemberId);

        var blocked = await member.GetAsync("/api/v1/me/profile");
        Assert.Equal(HttpStatusCode.Forbidden, blocked.StatusCode);
        Assert.Equal("password_change_required", await ErrorCodeAsync(blocked));

        // Wrong current password is a 400, never a 401 — a 401 here is the client's
        // session-expired signal and would sign the member out for a typo.
        var wrong = await member.PostAsJsonAsync("/api/v1/me/password", new { currentPassword = "not-it", newPassword = "ChosenByMe1!" });
        Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);
        Assert.Equal("current_password_incorrect", await ErrorCodeAsync(wrong));

        var changed = await member.PostAsJsonAsync("/api/v1/me/password", new { currentPassword = tempPassword, newPassword = "ChosenByMe1!" });
        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);

        var afterwards = await member.GetAsync("/api/v1/me/profile");
        Assert.Equal(HttpStatusCode.OK, afterwards.StatusCode);

        using (var anon = AnonymousClientFor(factory, club))
        {
            var replay = await anon.PostAsJsonAsync("/api/v1/auth/login", new { email = club.MemberEmail, password = tempPassword });
            Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);
        }
    }

    /// <summary>
    /// A session token that no longer validates, on a host that carries no tenant subdomain, is a
    /// 401 and says so.
    ///
    /// <para>
    /// It answered <c>400 tenant_unresolved</c> — because on such a host the JWT is the only place
    /// a tenant can come from, so a dead token failed resolution before authorization was ever
    /// consulted. A 400 is not a session signal, so the browser kept the signed-in chrome up and
    /// told the member to check their connection. The host shape is not hypothetical: the club
    /// addresses its own on-prem API by LAN IP.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("localhost")]
    public async Task A_dead_token_on_a_tenantless_host_is_a_401(string host)
    {
        if (!_pg.Available) return;
        await using var factory = CreateFactory();
        await SeedAsync(factory);

        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Host = host;
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "not.a.valid.token");

        var response = await client.GetAsync("/api/v1/me/profile");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("invalid_token", await ErrorCodeAsync(response));
    }

    /// <summary>
    /// The other half of that decision: a caller with no token at all still gets
    /// <c>tenant_unresolved</c>, because for them it is the truth and nothing about their session
    /// has expired.
    /// </summary>
    [Fact]
    public async Task A_caller_with_no_token_still_gets_tenant_unresolved()
    {
        if (!_pg.Available) return;
        await using var factory = CreateFactory();
        await SeedAsync(factory);

        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Host = "127.0.0.1";

        var response = await client.GetAsync("/api/v1/me/profile");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("tenant_unresolved", await ErrorCodeAsync(response));
    }
}
