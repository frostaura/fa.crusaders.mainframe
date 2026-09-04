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
/// A court box drives a set of courts (review C4).
///
/// <para>
/// The first two tests pin that the list is queryable — <c>CourtNumbers.Contains(n)</c>
/// has to translate on both providers, because "which box drives court 3?" is the
/// question the activation and roster paths will ask, and a primitive collection that
/// silently evaluates client-side on one provider is a full table scan nobody notices.
/// The rest are the admin surface: the wire shape, and the two rules a court list is
/// held to at write time.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DeviceCourtNumbersTests
{
    private readonly PostgresFixture _pg;

    public DeviceCourtNumbersTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string DevicesPath = "/api/v1/admin/devices/";

    // ---- The predicate translates ----------------------------------------

    [Fact]
    public async Task Contains_on_the_court_list_works_in_memory()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        db.Devices.AddRange(
            new Device { TenantId = host.Tenant.Id, DeviceCode = "box-a", Name = "A", CourtNumbers = [1, 2] },
            new Device { TenantId = host.Tenant.Id, DeviceCode = "box-b", Name = "B", CourtNumbers = [3, 4] },
            new Device { TenantId = host.Tenant.Id, DeviceCode = "gate", Name = "G", Kind = DeviceKind.Gate, GateKey = "front" });
        await db.SaveChangesAsync();

        var drivesThree = await db.Devices.Where(d => d.CourtNumbers.Contains(3)).Select(d => d.DeviceCode).ToListAsync();
        Assert.Equal(["box-b"], drivesThree);

        var reloaded = await db.Devices.AsNoTracking().SingleAsync(d => d.DeviceCode == "box-a");
        Assert.Equal([1, 2], reloaded.CourtNumbers);   // order survives: it is the relay mapping
    }

    [SkippableFact]
    public async Task Contains_on_the_court_list_translates_on_postgres()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var tenantId = Guid.NewGuid();
        db.Devices.AddRange(
            new Device { TenantId = tenantId, DeviceCode = "box-a", Name = "A", CourtNumbers = [1, 2] },
            new Device { TenantId = tenantId, DeviceCode = "box-b", Name = "B", CourtNumbers = [4, 3] },
            new Device { TenantId = tenantId, DeviceCode = "gate", Name = "G", Kind = DeviceKind.Gate, GateKey = "front" });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();

        var drivesThree = await db.Devices.IgnoreQueryFilters()
            .Where(d => d.TenantId == tenantId && d.CourtNumbers.Contains(3))
            .Select(d => d.DeviceCode)
            .ToListAsync();
        Assert.Equal(["box-b"], drivesThree);

        var reloaded = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.TenantId == tenantId && d.DeviceCode == "box-b");
        Assert.Equal([4, 3], reloaded.CourtNumbers);

        var gate = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.TenantId == tenantId && d.DeviceCode == "gate");
        Assert.Empty(gate.CourtNumbers);
    }

    // ---- The admin surface --------------------------------------------------

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId);

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory, string settingsJson = """{"timezone":"UTC"}""")
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"dev-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Device Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = settingsJson });
        var admin = new User { TenantId = tenant.Id, Email = $"{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        db.Users.Add(admin);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = admin.Id,
            FullName = "Device Admin",
            MembershipNumber = slug,
            Status = MembershipStatus.Active,
            MemberClass = MemberClass.Regular,
        });
        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, admin.Id);
    }

    private static HttpClient AdminClient(TestWebAppFactory factory, Seeded s)
    {
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe",
            audience: "crusaders.mainframe.app",
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, s.AdminUserId.ToString()),
                new Claim("tenant_id", s.TenantId.ToString()),
                new Claim("tenant_slug", s.Slug),
                new Claim("purpose", "access"),
                new Claim(ClaimTypes.Role, "admin"),
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

    // Enums bind as their integer values: the application configures no string-enum
    // converter, and the admin screen sends numbers.
    private static object Register(string deviceCode, int[]? courts) => new
    {
        deviceCode,
        name = "A box",
        kind = (int)DeviceKind.CourtBox,
        hardware = (int)DeviceHardware.Esp8266,
        court_numbers = courts,
    };

    /// <summary>The wire field is <c>court_numbers</c>, in both directions, in relay order.</summary>
    [SkippableFact]
    public async Task A_registered_box_reads_back_its_courts_in_relay_order()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var response = await client.PostAsJsonAsync(DevicesPath, Register("court-box-1", [4, 3, 2, 1]));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

        var courts = json.GetProperty("device").GetProperty("court_numbers").EnumerateArray().Select(e => e.GetInt32()).ToArray();
        Assert.Equal([4, 3, 2, 1], courts);

        var listed = JsonDocument.Parse(await client.GetStringAsync(DevicesPath)).RootElement;
        var row = Assert.Single(listed.EnumerateArray());
        Assert.Equal([4, 3, 2, 1], row.GetProperty("court_numbers").EnumerateArray().Select(e => e.GetInt32()).ToArray());
    }

    [SkippableTheory]
    [InlineData(null, "court_numbers_required_for_court_box")]
    [InlineData(new int[0], "court_numbers_required_for_court_box")]
    [InlineData(new[] { 1, 2, 3, 4, 5 }, "too_many_courts_for_relay_bank")]
    [InlineData(new[] { 1, 1, 2, 3 }, "duplicate_court_numbers")]
    public async Task An_unusable_court_list_is_refused_at_registration(int[]? courts, string expected)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var response = await client.PostAsJsonAsync(DevicesPath, Register("court-box-bad", courts));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal(expected, json.GetProperty("error").GetString());
    }

    /// <summary>
    /// The default button map selects courts A–D. A box that would drive two of them
    /// leaves two buttons selecting nothing, and the admin is told at the moment of
    /// assigning the courts — on registration and on update alike.
    /// </summary>
    [SkippableFact]
    public async Task A_box_with_fewer_courts_than_the_button_map_selects_is_refused_on_register_and_update()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var refused = await client.PostAsJsonAsync(DevicesPath, Register("court-box-1", [1, 2]));
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal(ButtonMap.SelectsCourtBeyondDeviceCourts,
            JsonDocument.Parse(await refused.Content.ReadAsStringAsync()).RootElement.GetProperty("error").GetString());

        var ok = await client.PostAsJsonAsync(DevicesPath, Register("court-box-1", [1, 2, 3, 4]));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var id = JsonDocument.Parse(await ok.Content.ReadAsStringAsync()).RootElement.GetProperty("device").GetProperty("id").GetGuid();

        var shrink = await client.PatchAsJsonAsync($"{DevicesPath}{id}", new { court_numbers = new[] { 1 } });
        Assert.Equal(HttpStatusCode.BadRequest, shrink.StatusCode);
        Assert.Equal(ButtonMap.SelectsCourtBeyondDeviceCourts,
            JsonDocument.Parse(await shrink.Content.ReadAsStringAsync()).RootElement.GetProperty("error").GetString());

        // A reorder keeps the count and is fine: the relay mapping is the admin's to choose.
        var reorder = await client.PatchAsJsonAsync($"{DevicesPath}{id}", new { court_numbers = new[] { 2, 1, 4, 3 } });
        Assert.Equal(HttpStatusCode.OK, reorder.StatusCode);
        var courts = JsonDocument.Parse(await reorder.Content.ReadAsStringAsync()).RootElement
            .GetProperty("court_numbers").EnumerateArray().Select(e => e.GetInt32()).ToArray();
        Assert.Equal([2, 1, 4, 3], courts);
    }

    /// <summary>
    /// Under a map that selects only court A, a one-court box is exactly right. This is
    /// the control for the test above: the refusal is about the map, not about the count.
    /// </summary>
    [SkippableFact]
    public async Task A_one_court_box_is_accepted_under_a_one_court_button_map()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var seeded = await SeedAsync(factory,
            """{"timezone":"UTC","button_map":["court:A","none","none","none","minutes:15","minutes:30","minutes:45","minutes:60"]}""");
        var client = AdminClient(factory, seeded);

        var response = await client.PostAsJsonAsync(DevicesPath, Register("court-box-1", [3]));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
