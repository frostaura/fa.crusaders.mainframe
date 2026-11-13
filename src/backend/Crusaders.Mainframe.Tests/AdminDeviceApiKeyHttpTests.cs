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
/// The club's device API key, over the admin surface the Devices page uses.
///
/// <para>
/// Two routes and one shape. It is deliberately <b>readable</b> rather than shown-once —
/// an admin has to be able to paste it into a <c>secrets.h</c> at a workbench weeks after
/// the club was created, and a credential that can only be seen at the instant it is
/// created is precisely what made the scheme it replaced need a discovery protocol, a
/// claim code and an LCD ceremony to recover from.
/// </para>
/// </summary>
public sealed class AdminDeviceApiKeyHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public AdminDeviceApiKeyHttpTests(PostgresFixture pg) => _pg = pg;

    private const string KeyPath = "/api/v1/admin/devices/api-key";
    private const string RotatePath = "/api/v1/admin/devices/api-key/rotate";
    private const string RetirePath = "/api/v1/admin/devices/api-key/retire";
    private const string RestorePath = "/api/v1/admin/devices/api-key/restore";
    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId, Guid MemberUserId);

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"key-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Key Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = """{"timezone":"UTC"}""" });

        var admin = new User { TenantId = tenant.Id, Email = $"admin-{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        var member = new User { TenantId = tenant.Id, Email = $"member-{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.AddRange(admin, member);
        await db.SaveChangesAsync();

        return new Seeded(tenant.Id, slug, admin.Id, member.Id);
    }

    private static HttpClient ClientFor(TestWebAppFactory factory, Seeded s, Guid userId, bool admin)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, userId.ToString()),
            new("tenant_id", s.TenantId.ToString()),
            new("tenant_slug", s.Slug),
            new("purpose", "access"),
        };
        if (admin) claims.Add(new Claim(ClaimTypes.Role, "admin"));

        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims: claims,
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));

        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", new JwtSecurityTokenHandler().WriteToken(token));
        return client;
    }

    private static async Task<JsonElement> BodyAsync(HttpResponseMessage response)
        => JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

    /// <summary>
    /// The page is never empty: a club that has never asked for a key is given one on the
    /// first read, so "copy this into secrets.h" is always something an admin can do.
    /// </summary>
    [SkippableFact]
    public async Task Reading_the_key_mints_one_on_first_use_and_returns_the_same_one_after()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory);
        var client = ClientFor(factory, seeded, seeded.AdminUserId, admin: true);

        var first = await client.GetAsync(KeyPath);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var firstBody = await BodyAsync(first);

        var key = firstBody.GetProperty("api_key").GetString();
        Assert.False(string.IsNullOrWhiteSpace(key));
        Assert.NotEqual(default, firstBody.GetProperty("regenerated_at").GetDateTimeOffset());

        // Readable, not shown-once: a second read is the same key, not a new one.
        Assert.Equal(key, (await BodyAsync(await client.GetAsync(KeyPath))).GetProperty("api_key").GetString());
    }

    /// <summary>
    /// Device contract v3 §6 (BA-01, BD-3): v2's Regenerate is gone — it killed the old key on the
    /// next request and every board needed a cable. A rotation mints the next key and keeps the old
    /// one valid; the route that used to regenerate no longer exists.
    /// </summary>
    [SkippableFact]
    public async Task Rotating_mints_the_next_key_and_keeps_the_old_one_and_regenerate_is_gone()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory);
        var client = ClientFor(factory, seeded, seeded.AdminUserId, admin: true);

        var before = await BodyAsync(await client.GetAsync(KeyPath));
        Assert.Equal("k1", before.GetProperty("key_id").GetString());
        Assert.Equal(JsonValueKind.Null, before.GetProperty("rotation").ValueKind);

        var rotated = await client.PostAsync(RotatePath, null);
        Assert.Equal(HttpStatusCode.OK, rotated.StatusCode);
        var after = await BodyAsync(rotated);
        Assert.NotEqual(before.GetProperty("api_key").GetString(), after.GetProperty("api_key").GetString());
        Assert.Equal("k2", after.GetProperty("key_id").GetString());
        Assert.Equal("k2", after.GetProperty("rotation").GetProperty("next_id").GetString());

        // A second rotation while one is in progress is refused: two old keys alive at once is
        // a board that can hold neither of them.
        var again = await client.PostAsync(RotatePath, null);
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        Assert.Equal("rotation_in_progress", (await BodyAsync(again)).GetProperty("error").GetString());

        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync("/api/v1/admin/devices/api-key/regenerate", null)).StatusCode);

        // The old key still resolves to the club, as k1; the new one as k2.
        using var scope = factory.Services.CreateScope();
        var resolver = scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceKeyResolver>();
        Assert.Equal(1, (await resolver.ResolveKeyAsync(before.GetProperty("api_key").GetString()!))?.KeyId);
        Assert.Equal(2, (await resolver.ResolveKeyAsync(after.GetProperty("api_key").GetString()!))?.KeyId);
    }

    /// <summary>
    /// Every mutation of a credential is auditable, and the credential itself is never in
    /// the audit details — a trail an admin can read is not a place to put a live key.
    /// </summary>
    [SkippableFact]
    public async Task Minting_and_rotating_are_audited_without_a_key_in_them()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory);
        var client = ClientFor(factory, seeded, seeded.AdminUserId, admin: true);

        var first = (await BodyAsync(await client.GetAsync(KeyPath))).GetProperty("api_key").GetString()!;
        var key = (await BodyAsync(await client.PostAsync(RotatePath, null))).GetProperty("api_key").GetString()!;

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var rows = await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == seeded.TenantId && (a.Action == "device.api_key_regenerated" || a.Action == "device.api_key_rotated"))
            .ToListAsync();

        Assert.Equal(["device.api_key_regenerated", "device.api_key_rotated"], rows.Select(r => r.Action).Order());
        Assert.All(rows, r => Assert.Equal(seeded.AdminUserId, r.ActorUserId));
        Assert.All(rows, r => Assert.DoesNotContain(key, r.DetailsJson));
        Assert.All(rows, r => Assert.DoesNotContain(first, r.DetailsJson));
    }

    /// <summary>A member is not an admin, and the key is what opens every court in the club.</summary>
    [SkippableFact]
    public async Task A_member_cannot_read_rotate_retire_or_restore_the_key()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory);
        var client = ClientFor(factory, seeded, seeded.MemberUserId, admin: false);

        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(KeyPath)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsync(RotatePath, null)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(RetirePath, new { confirm = "retire the old key" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(RestorePath, new { key = new string('A', 43), confirm = "restore this key" })).StatusCode);
    }

    [SkippableFact]
    public async Task An_anonymous_caller_cannot_read_the_key()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = _pg.SharedHost;
        await SeedAsync(factory);

        // BadRequest is as good as Unauthorized here and not a weakening: the admin surface
        // resolves its tenant from the JWT or the Host, and an anonymous caller on
        // "localhost" has neither, so the request dies at tenant resolution. What matters is
        // that it never returns a key.
        var response = await factory.CreateClient().GetAsync(KeyPath);
        Assert.True(
            response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.BadRequest,
            $"An anonymous caller got {(int)response.StatusCode} from the key route.");
        Assert.DoesNotContain("api_key", await response.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// One club's admin must never see another club's key. The key IS the other club's
    /// device credential, so this is the cross-tenant test that matters most on this route.
    /// </summary>
    [SkippableFact]
    public async Task Two_clubs_get_two_different_keys()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = _pg.SharedHost;
        var alpha = await SeedAsync(factory);
        var bravo = await SeedAsync(factory);

        var a = (await BodyAsync(await ClientFor(factory, alpha, alpha.AdminUserId, true).GetAsync(KeyPath))).GetProperty("api_key").GetString();
        var b = (await BodyAsync(await ClientFor(factory, bravo, bravo.AdminUserId, true).GetAsync(KeyPath))).GetProperty("api_key").GetString();

        Assert.NotEqual(a, b);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(a, (await db.Tenants.SingleAsync(t => t.Id == alpha.TenantId)).DeviceApiKey);
        Assert.Equal(b, (await db.Tenants.SingleAsync(t => t.Id == bravo.TenantId)).DeviceApiKey);
    }
}
