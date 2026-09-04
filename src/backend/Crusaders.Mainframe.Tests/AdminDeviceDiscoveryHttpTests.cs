using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.Discovery;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The discovery endpoints over real HTTP: routing, admin authorisation, and the shapes an
/// admin UI binds to.
///
/// <para>
/// Joins <see cref="HttpTestCollection"/> because <see cref="TestWebAppFactory"/> configures
/// the application through <b>process environment variables</b> — two factories built
/// concurrently race, and the loser silently gets the other's connection string.
/// </para>
///
/// <para>
/// The factory strips every <c>IHostedService</c>, so the listener never runs here. That is
/// not a limitation of the test — it is the exact condition the status endpoint exists to
/// report, and the same one an on-prem deployment is in when someone forgets
/// <c>docker-compose.onprem.yml</c>.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class AdminDeviceDiscoveryHttpTests
{
    private readonly PostgresFixture _pg;

    public AdminDeviceDiscoveryHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string DiscoveredPath = "/api/v1/admin/devices/discovered";
    private const string StatusPath = "/api/v1/admin/devices/discovery-status";
    private const string ClaimPath = "/api/v1/admin/devices/claim";
    private const string Code = "K7RM4XPT";
    private const string Nonce = "a1b2c3d4e5f60718";

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId);

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"disc-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Discovery Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = """{"timezone":"UTC"}""" });

        var admin = new User
        {
            TenantId = tenant.Id,
            Email = $"{slug}@test.local",
            PasswordHash = "x",
            EmailVerified = true,
            IsAdmin = true,
        };
        db.Users.Add(admin);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = admin.Id,
            FullName = "Discovery Admin",
            MembershipNumber = slug,
            Status = MembershipStatus.Active,
            MemberClass = MemberClass.Regular,
        });

        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, admin.Id);
    }

    /// <summary>Mints the token the application would mint: same key, same issuer, same audience, admin role.</summary>
    private static string AdminToken(Seeded s)
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

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static HttpClient AdminClient(TestWebAppFactory factory, Seeded s)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", AdminToken(s));
        return client;
    }

    private static DiscoveryStore Store(TestWebAppFactory factory)
    {
        var store = factory.Services.GetRequiredService<DiscoveryStore>();

        // The store is a singleton and the factory reuses one application per test class, so
        // a board left behind by a previous test would leak into the next one's list.
        store.Clear();
        return store;
    }

    private static DiscoveredBoard Board(string mac = "5ccf7f1a2b3c") => new()
    {
        Mac = mac,
        Address = "192.168.68.150",
        Nonce = Nonce,
        Hardware = "esp8266",
        Firmware = "1.0.0",
        Commitment = DiscoveryBeacon.ClaimCommitment(Code, Nonce),
        UptimeSeconds = 42,
        FirstSeenAt = DateTimeOffset.UtcNow,
        LastSeenAt = DateTimeOffset.UtcNow,
    };

    [SkippableFact]
    public async Task All_three_endpoints_require_an_admin()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);

        // The Host header carries the tenant. Without it the tenant middleware short-circuits
        // with 400 tenant_unresolved before authorisation is ever consulted, and the test
        // would pass without proving anything about the admin policy.
        var anonymous = factory.CreateClient();
        anonymous.DefaultRequestHeaders.Host = $"{seeded.Slug}.example.com";

        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync(DiscoveredPath)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync(StatusPath)).StatusCode);
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await anonymous.PostAsJsonAsync(ClaimPath, new { claim_code = Code })).StatusCode);
    }

    /// <summary>
    /// The endpoint that stops a deployment mistake from looking like a firmware fault.
    ///
    /// <para>
    /// No hosted services run under the test factory, so the listener never started — which
    /// is precisely the state this endpoint has to describe rather than hide. An empty board
    /// list plus "the listener is not running" is a diagnosis; an empty board list alone is a
    /// trip to the club to open a cupboard.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Discovery_status_reports_that_the_listener_is_not_running()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        Store(factory);

        var json = await ReadAsync(await AdminClient(factory, seeded).GetAsync(StatusPath));

        Assert.Equal("NotStarted", json.GetProperty("state").GetString());
        Assert.False(json.GetProperty("listening").GetBoolean());
        Assert.Equal(0, json.GetProperty("packets_received").GetInt64());
        Assert.Equal(0, json.GetProperty("announcers").GetInt32());
        Assert.False(string.IsNullOrWhiteSpace(json.GetProperty("hint").GetString()));
    }

    [SkippableFact]
    public async Task Discovered_lists_the_candidates_with_what_an_admin_needs_to_pick_one()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        Store(factory).Upsert(Board());

        var json = await ReadAsync(await AdminClient(factory, seeded).GetAsync(DiscoveredPath));
        var board = Assert.Single(json.EnumerateArray().ToList());

        Assert.Equal("5ccf7f1a2b3c", board.GetProperty("mac").GetString());
        Assert.Equal("esp8266", board.GetProperty("hardware").GetString());
        Assert.Equal("1.0.0", board.GetProperty("firmware").GetString());
        Assert.Equal("192.168.68.150", board.GetProperty("address").GetString());
        Assert.False(board.GetProperty("claimed").GetBoolean());
        Assert.True(board.GetProperty("claimable").GetBoolean());
        Assert.Equal(JsonValueKind.Null, board.GetProperty("signature_verified").ValueKind);
        Assert.NotEqual(default, board.GetProperty("last_seen_at").GetDateTimeOffset());
    }

    [SkippableFact]
    public async Task A_claim_returns_the_device_and_the_key_the_board_needs()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        Store(factory).Upsert(Board());

        var response = await AdminClient(factory, seeded).PostAsJsonAsync(ClaimPath, new
        {
            claim_code = Code,
            device_code = $"court-box-{Guid.NewGuid():N}"[..20],
            name = "Court 1 box",
            court_numbers = new[] { 1, 2, 3, 4 },
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

        Assert.Equal(43, json.GetProperty("device_key").GetString()!.Length);
        Assert.Equal(1, json.GetProperty("key_version").GetInt32());
        Assert.Equal("CourtBox", json.GetProperty("device").GetProperty("kind").GetString());
        Assert.Equal("5ccf7f1a2b3c", json.GetProperty("board").GetProperty("mac").GetString());

        // The device row landed on the admin's own tenant, resolved from the JWT.
        var deviceId = json.GetProperty("device").GetProperty("id").GetGuid();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.Id == deviceId);
        Assert.Equal(seeded.TenantId, device.TenantId);
    }

    [SkippableFact]
    public async Task A_claim_that_matches_nothing_is_a_404_with_a_reason()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        Store(factory);

        var response = await AdminClient(factory, seeded).PostAsJsonAsync(ClaimPath, new
        {
            claim_code = Code,
            device_code = "court-box-nomatch",
            name = "Court 1 box",
            court_numbers = new[] { 1, 2, 3, 4 },
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("claim_no_match", json.GetProperty("error").GetString());
    }

    /// <summary>Two announcers with one commitment: a 409 that says so, not a coin flip.</summary>
    [SkippableFact]
    public async Task A_duplicate_commitment_is_a_409_that_says_so()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);

        var store = Store(factory);
        store.Upsert(Board());
        store.Upsert(Board(mac: "aabbccddeeff"));

        var response = await AdminClient(factory, seeded).PostAsJsonAsync(ClaimPath, new
        {
            claim_code = Code,
            device_code = "court-box-ambiguous",
            name = "Court 1 box",
            court_numbers = new[] { 1, 2, 3, 4 },
        });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("claim_ambiguous", json.GetProperty("error").GetString());
    }

    [SkippableFact]
    public async Task A_malformed_claim_code_is_a_400()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var seeded = await SeedAsync(factory);
        Store(factory).Upsert(Board());

        var response = await AdminClient(factory, seeded).PostAsJsonAsync(ClaimPath, new
        {
            claim_code = "lowercase",
            device_code = "court-box-bad",
            name = "Court 1 box",
            court_numbers = new[] { 1, 2, 3, 4 },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("claim_code_invalid", json.GetProperty("error").GetString());
    }

    private static async Task<JsonElement> ReadAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
    }
}
