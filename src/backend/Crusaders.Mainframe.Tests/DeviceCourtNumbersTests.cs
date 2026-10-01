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
/// The rest are the admin surface. There is no registration endpoint any more — a box
/// creates its own row on its first heartbeat — so every rule a court list is held to is
/// now held on the PATCH an admin uses to correct what the box guessed.
/// </para>
/// </summary>
public sealed class DeviceCourtNumbersTests : IClassFixture<PostgresFixture>
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
            new Device { TenantId = host.Tenant.Id, DeviceCode = "box-a", Name = "A", CourtNumbers = [1, 2], MacAddress = "cc0000000001" },
            new Device { TenantId = host.Tenant.Id, DeviceCode = "box-b", Name = "B", CourtNumbers = [3, 4], MacAddress = "cc0000000002" },
            new Device { TenantId = host.Tenant.Id, DeviceCode = "gate", Name = "G", Kind = DeviceKind.Gate, GateKey = "front", MacAddress = "cc0000000003" });
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

        await using var factory = _pg.SharedHost;
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var tenantId = Guid.NewGuid();
        db.Devices.AddRange(
            new Device { TenantId = tenantId, DeviceCode = "box-a", Name = "A", CourtNumbers = [1, 2], MacAddress = "dd0000000001" },
            new Device { TenantId = tenantId, DeviceCode = "box-b", Name = "B", CourtNumbers = [4, 3], MacAddress = "dd0000000002" },
            new Device { TenantId = tenantId, DeviceCode = "gate", Name = "G", Kind = DeviceKind.Gate, GateKey = "front", MacAddress = "dd0000000003" });
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

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminUserId, string DeviceApiKey);

    private static async Task<Seeded> SeedAsync(
        TestWebAppFactory factory, string settingsJson = """{"timezone":"UTC"}""", bool twoCourtsOnly = false)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"dev-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant
        {
            Slug = slug,
            DisplayName = "Device Club",
            DeviceApiKey = Crusaders.Mainframe.Api.Security.DeviceAuth.DeviceApiKey.Generate(),
            DeviceApiKeyRegeneratedAt = DateTimeOffset.UtcNow,
        };
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
        });
        // The club's courts: a court list is checked against them on every save, so a
        // typo cannot register a relay that can never light.
        for (var n = 1; n <= (twoCourtsOnly ? 2 : 4); n++)
        {
            db.Courts.Add(new Court { TenantId = tenant.Id, CourtNumber = n, Name = $"Court {n}" });
        }
        await db.SaveChangesAsync();
        return new Seeded(tenant.Id, slug, admin.Id, tenant.DeviceApiKey!);
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

    /// <summary>
    /// A box already on the roster, as a heartbeat would have left it. Registration is the
    /// board's own doing now, so a test about the admin surface starts from a row rather
    /// than creating one through it.
    /// </summary>
    private static async Task<Guid> BoxAsync(TestWebAppFactory factory, Seeded seeded, int[] courts, string? buttonMapJson = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var mac = Guid.NewGuid().ToString("N")[..12];
        var device = new Device
        {
            TenantId = seeded.TenantId,
            DeviceCode = $"box-{mac[^6..]}",
            Name = "A box",
            Kind = DeviceKind.CourtBox,
            Hardware = DeviceHardware.Esp8266,
            MacAddress = mac,
            CourtNumbers = [.. courts],
            ButtonMapJson = buttonMapJson,
            AutoRegistered = true,
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();
        return device.Id;
    }

    private static async Task<JsonElement> BodyAsync(HttpResponseMessage response)
        => JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

    /// <summary>The wire field is <c>court_numbers</c>, in both directions, in relay order.</summary>
    [SkippableFact]
    public async Task A_box_reads_back_its_courts_in_relay_order()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory);
        await BoxAsync(factory, seeded, [4, 3, 2, 1]);
        var client = AdminClient(factory, seeded);

        var listed = JsonDocument.Parse(await client.GetStringAsync(DevicesPath)).RootElement;
        var row = Assert.Single(listed.EnumerateArray());
        Assert.Equal([4, 3, 2, 1], row.GetProperty("court_numbers").EnumerateArray().Select(e => e.GetInt32()).ToArray());

        // The row says nobody has confirmed it, because nobody has.
        Assert.True(row.GetProperty("auto_registered").GetBoolean());
    }

    /// <summary>
    /// A box that registered itself under a club map naming more courts than it drives is
    /// given the club's map with the unreachable buttons off — the F13 rule, applied at the
    /// one moment nobody is watching. Read back through the admin list, because that is
    /// where an admin discovers what the box decided.
    /// </summary>
    [SkippableFact]
    public async Task A_box_that_registered_itself_appears_with_a_map_it_can_honour()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory, twoCourtsOnly: true);
        var client = AdminClient(factory, seeded);

        var mac = Guid.NewGuid().ToString("N")[..12];
        var heartbeat = new HttpRequestMessage(HttpMethod.Post, "/api/v1/device/heartbeat")
        {
            Content = new StringContent($$"""{"mac":"{{mac}}"}""", Encoding.UTF8, "application/json"),
        };
        heartbeat.Headers.Authorization = new AuthenticationHeaderValue("Bearer", seeded.DeviceApiKey);
        Assert.Equal(HttpStatusCode.OK, (await factory.CreateClient().SendAsync(heartbeat)).StatusCode);

        var row = Assert.Single(JsonDocument.Parse(await client.GetStringAsync(DevicesPath)).RootElement.EnumerateArray());
        Assert.Equal([1, 2], row.GetProperty("court_numbers").EnumerateArray().Select(e => e.GetInt32()).ToArray());
        Assert.Equal(AnnexTwoCourtMap, row.GetProperty("button_map").EnumerateArray().Select(e => e.GetString()).ToArray());
    }

    /// <summary>
    /// A court list must be one to four entries with no repeats. Four because the relay
    /// bank has four relays; no repeats because two relays wired to one court is a wiring
    /// fault, not a configuration.
    /// </summary>
    [SkippableTheory]
    [InlineData(new int[0], "court_numbers_required_for_court_box")]
    [InlineData(new[] { 1, 2, 3, 4, 5 }, "too_many_courts_for_relay_bank")]
    [InlineData(new[] { 1, 1, 2, 3 }, "duplicate_court_numbers")]
    public async Task An_unusable_court_list_is_refused_on_edit(int[] courts, string expected)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory);
        var id = await BoxAsync(factory, seeded, [1, 2, 3, 4]);
        var client = AdminClient(factory, seeded);

        var response = await client.PatchAsJsonAsync($"{DevicesPath}{id}", new { court_numbers = courts });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(expected, (await BodyAsync(response)).GetProperty("error").GetString());
    }

    /// <summary>An absent list is not an empty one: a PATCH that says nothing about the courts leaves them alone.</summary>
    [Fact]
    public void An_absent_court_list_is_not_a_refusal_but_an_empty_one_is()
    {
        Assert.Equal("court_numbers_required_for_court_box", DeviceRegistryService.ValidateCourtNumbers(null));
        Assert.Equal("court_numbers_required_for_court_box", DeviceRegistryService.ValidateCourtNumbers([]));
        Assert.Null(DeviceRegistryService.ValidateCourtNumbers([1, 2]));
    }

    /// <summary>
    /// Shrinking a box's court list turns off the court buttons it no longer has rather
    /// than refusing the edit — closing re-review #13's residual. The refusal had no way
    /// forward from the screen the admin was on: their only options were to edit the club's
    /// map, changing every other box, or to hand-compose an override.
    /// </summary>
    [SkippableFact]
    public async Task Shrinking_a_boxs_courts_trims_its_map_rather_than_refusing_the_edit()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory);
        var id = await BoxAsync(factory, seeded, [1, 2, 3, 4]);
        var client = AdminClient(factory, seeded);

        var shrink = await client.PatchAsJsonAsync($"{DevicesPath}{id}", new { court_numbers = new[] { 1 } });
        Assert.Equal(HttpStatusCode.OK, shrink.StatusCode);
        Assert.Equal(
            ["court:A", "none", "none", "none", "minutes:15", "minutes:30", "minutes:45", "minutes:60"],
            (await BodyAsync(shrink)).GetProperty("button_map").EnumerateArray().Select(e => e.GetString() ?? "").ToArray());

        // And the edit is what says a human has now looked at this row.
        Assert.False((await BodyAsync(shrink)).GetProperty("auto_registered").GetBoolean());
    }

    /// <summary>
    /// The trim applies only to a map the admin did NOT type. One they supplied that
    /// reaches past the box's courts is still refused, because quietly rewriting what
    /// somebody deliberately wrote is a worse failure than telling them it does not fit.
    /// </summary>
    [SkippableFact]
    public async Task An_override_the_admin_supplied_that_overreaches_is_still_refused()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory);
        var id = await BoxAsync(factory, seeded, [1, 2, 3, 4]);
        var client = AdminClient(factory, seeded);

        string[] reachesTooFar = ["court:A", "court:C", "none", "none", "minutes:15", "minutes:30", "minutes:45", "minutes:60"];

        var patched = await client.PatchAsJsonAsync($"{DevicesPath}{id}", new { court_numbers = new[] { 1, 2 }, button_map = reachesTooFar });
        Assert.Equal(HttpStatusCode.BadRequest, patched.StatusCode);
        Assert.Equal(ButtonMap.SelectsCourtBeyondDeviceCourts, (await BodyAsync(patched)).GetProperty("error").GetString());
    }

    /// <summary>
    /// Under a map that selects only court A, a one-court box is exactly right. This is
    /// the control for the test above: the refusal is about the map, not about the count.
    /// </summary>
    [SkippableFact]
    public async Task A_one_court_box_is_accepted_under_a_one_court_button_map()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory,
            """{"timezone":"UTC","button_map":["court:A","none","none","none","minutes:15","minutes:30","minutes:45","minutes:60"]}""");
        var id = await BoxAsync(factory, seeded, [1, 2, 3, 4]);
        var client = AdminClient(factory, seeded);

        Assert.Equal(HttpStatusCode.OK,
            (await client.PatchAsJsonAsync($"{DevicesPath}{id}", new { court_numbers = new[] { 3 } })).StatusCode);
    }

    // ---- the per-box button map (closing re-review #17) ----------------------------------

    private static readonly string[] AnnexMap = ["court:A", "none", "none", "none", "minutes:15", "minutes:30", "minutes:45", "minutes:60"];
    private static readonly string[] AnnexTwoCourtMap = ["court:A", "court:B", "none", "none", "minutes:15", "minutes:30", "minutes:45", "minutes:60"];

    /// <summary>
    /// PATCH button_map is three-valued: a list sets the override (checked against the
    /// courts), null clears it (checked against the club's map), absent leaves it alone.
    /// </summary>
    [SkippableFact]
    public async Task Patching_the_button_map_sets_checks_and_clears_the_override()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory);
        var id = await BoxAsync(factory, seeded, [1, 2, 3, 4]);
        var client = AdminClient(factory, seeded);

        // Set an override that only needs one court, then shrink the box to one court: allowed.
        var set = await client.PatchAsJsonAsync($"{DevicesPath}{id}", new { button_map = AnnexMap });
        Assert.Equal(HttpStatusCode.OK, set.StatusCode);
        Assert.Equal(AnnexMap, (await BodyAsync(set)).GetProperty("button_map").EnumerateArray().Select(e => e.GetString()).ToArray());
        Assert.Equal(HttpStatusCode.OK, (await client.PatchAsJsonAsync($"{DevicesPath}{id}", new { court_numbers = new[] { 1 } })).StatusCode);

        // An override that reaches past the box's courts is refused.
        var tooWide = await client.PatchAsJsonAsync($"{DevicesPath}{id}", new { button_map = new[] { "court:A", "court:B", "none", "none", "minutes:15", "none", "none", "none" } });
        Assert.Equal(HttpStatusCode.BadRequest, tooWide.StatusCode);
        Assert.Equal(ButtonMap.SelectsCourtBeyondDeviceCourts, (await BodyAsync(tooWide)).GetProperty("error").GetString());

        // A rename leaves the override alone.
        var rename = await client.PatchAsJsonAsync($"{DevicesPath}{id}", new { name = "Renamed" });
        Assert.Equal(JsonValueKind.Array, (await BodyAsync(rename)).GetProperty("button_map").ValueKind);

        // Clearing it on a box the club's four-court map reaches past is ACCEPTED, and the
        // box is left running that map with the buttons it has no relay for turned off —
        // the same trim auto-registration and a by-hand court-list shrink apply (spec §8a).
        //
        // This used to be a flat 400, and the screen's advice — "give the box more courts,
        // or change the button map first" — was impossible for a genuinely one-court annex:
        // the override was a one-way door, and §8a's promise that a one-court annex and a
        // four-court main box are both valid under one club default could not hold.
        var clear = await client.SendAsync(new HttpRequestMessage(HttpMethod.Patch, $"{DevicesPath}{id}")
        {
            Content = new StringContent("""{"button_map":null}""", Encoding.UTF8, "application/json"),
        });
        Assert.Equal(HttpStatusCode.OK, clear.StatusCode);
        Assert.Equal(
            new[] { "court:A", "none", "none", "none", "minutes:15", "minutes:30", "minutes:45", "minutes:60" },
            (await BodyAsync(clear)).GetProperty("button_map").EnumerateArray().Select(e => e.GetString()).ToArray());

        // A map the admin WROTE that overreaches is still refused — trimming what somebody
        // deliberately typed would be worse than telling them it does not fit.
        var stillRefused = await client.PatchAsJsonAsync($"{DevicesPath}{id}", new { button_map = AnnexTwoCourtMap });
        Assert.Equal(HttpStatusCode.BadRequest, stillRefused.StatusCode);
        Assert.Equal(ButtonMap.SelectsCourtBeyondDeviceCourts, (await BodyAsync(stillRefused)).GetProperty("error").GetString());

        // Give it the courts back, then clear: the club's map fits, so the override goes to
        // null on the wire rather than to a frozen copy of the club map.
        Assert.Equal(HttpStatusCode.OK, (await client.PatchAsJsonAsync($"{DevicesPath}{id}", new { court_numbers = new[] { 1, 2, 3, 4 } })).StatusCode);
        var cleared = await client.SendAsync(new HttpRequestMessage(HttpMethod.Patch, $"{DevicesPath}{id}")
        {
            Content = new StringContent("""{"button_map":null}""", Encoding.UTF8, "application/json"),
        });
        Assert.Equal(HttpStatusCode.OK, cleared.StatusCode);
        Assert.Equal(JsonValueKind.Null, (await BodyAsync(cleared)).GetProperty("button_map").ValueKind);
    }

    /// <summary>A court list naming a court the club does not have never made it into a row it could not light; it is refused on edit.</summary>
    [SkippableFact]
    public async Task A_court_number_the_club_does_not_have_is_refused()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory);
        var id = await BoxAsync(factory, seeded, [1, 2, 3, 4]);
        var client = AdminClient(factory, seeded);

        var typo = await client.PatchAsJsonAsync($"{DevicesPath}{id}", new { court_numbers = new[] { 1, 2, 3, 44 } });
        Assert.Equal(HttpStatusCode.BadRequest, typo.StatusCode);
        Assert.Equal(DeviceRegistryService.CourtNumberNotFound, (await BodyAsync(typo)).GetProperty("error").GetString());
    }

    /// <summary>
    /// Deleting a box is not a revocation and is not destructive: the board still holds the
    /// club key, so it comes back on its next heartbeat with default courts. That is the
    /// intended way to reset a box whose configuration has been got into a mess.
    /// </summary>
    [SkippableFact]
    public async Task A_deleted_box_comes_back_on_its_next_heartbeat()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        var seeded = await SeedAsync(factory);
        var client = AdminClient(factory, seeded);

        var mac = Guid.NewGuid().ToString("N")[..12];
        HttpRequestMessage Heartbeat()
        {
            var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/device/heartbeat")
            {
                Content = new StringContent($$"""{"mac":"{{mac}}"}""", Encoding.UTF8, "application/json"),
            };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", seeded.DeviceApiKey);
            return req;
        }

        Assert.Equal(HttpStatusCode.OK, (await factory.CreateClient().SendAsync(Heartbeat())).StatusCode);
        var id = Assert.Single(JsonDocument.Parse(await client.GetStringAsync(DevicesPath)).RootElement.EnumerateArray())
            .GetProperty("id").GetGuid();

        var deleted = await client.DeleteAsync($"{DevicesPath}{id}");
        Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
        Assert.True((await BodyAsync(deleted)).GetProperty("deleted").GetBoolean());
        Assert.Empty(JsonDocument.Parse(await client.GetStringAsync(DevicesPath)).RootElement.EnumerateArray());

        Assert.Equal(HttpStatusCode.OK, (await factory.CreateClient().SendAsync(Heartbeat())).StatusCode);
        var reborn = Assert.Single(JsonDocument.Parse(await client.GetStringAsync(DevicesPath)).RootElement.EnumerateArray());
        Assert.NotEqual(id, reborn.GetProperty("id").GetGuid());
        Assert.Equal(mac, reborn.GetProperty("mac_address").GetString());
    }
}
