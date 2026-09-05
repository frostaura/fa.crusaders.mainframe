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
/// Getting a revoked HAND-REGISTERED box back, which nothing could do.
///
/// <para>
/// <c>ReclaimAsync</c> closed this for discovered boards: a board that was reflashed,
/// revoked or lost its key announces <c>st=unclaimed</c>, the claim finds its row BY MAC,
/// re-keys it and clears <c>RevokedAt</c>. A hand-registered row had no MAC — the manual
/// registration endpoint never accepted one — so the lookup could never find it. Revoking
/// such a box was final: <c>RevokedAt</c> is set for ever and nothing clears it, rotation
/// issues no provisioning grant, and the only way to get the hardware working again was to
/// register it a second time under a different device code, leaving a dead row and two
/// identities for one physical box.
/// </para>
///
/// <para>
/// The manual endpoint takes a <c>mac_address</c> now, and reclaims on a match exactly as
/// the discovery claim does. Same row, same id, same history — a bumped key version, the
/// revocation cleared, and the claim's name and courts.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DeviceRecoveryTests
{
    private readonly PostgresFixture _pg;

    public DeviceRecoveryTests(PostgresFixture pg) => _pg = pg;

    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";
    private const string DevicesPath = "/api/v1/admin/devices/";
    private const string Mac = "5ccf7f1a2b3c";

    private sealed record Seeded(Guid TenantId, string Slug, Guid AdminId);

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"rec-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Recovery Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = """{"timezone":"UTC"}""" });

        var admin = new User { TenantId = tenant.Id, Email = $"{slug}@test.local", PasswordHash = "x", EmailVerified = true, IsAdmin = true };
        db.Users.Add(admin);

        for (var n = 1; n <= 4; n++)
        {
            db.Courts.Add(new Court { TenantId = tenant.Id, CourtNumber = n, Name = $"Court {n}", SlicePriceCredits = 8m });
        }

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
                new Claim(JwtRegisteredClaimNames.Sub, s.AdminId.ToString()),
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

    private static object Register(string deviceCode, string? mac = null) => new
    {
        deviceCode,
        name = "Court box",
        kind = (int)DeviceKind.CourtBox,
        hardware = (int)DeviceHardware.Esp8266,
        court_numbers = new[] { 1, 2, 3, 4 },
        mac_address = mac,
    };

    /// <summary>
    /// Register with a MAC, revoke, register again with the same MAC: one row throughout,
    /// re-keyed and enabled. The device code is free to be the same one, because the row it
    /// belongs to is the row being reclaimed.
    /// </summary>
    [SkippableFact]
    public async Task A_revoked_hand_registered_box_is_recovered_by_registering_it_again_with_its_mac()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var s = await SeedAsync(factory);
        var client = AdminClient(factory, s);

        var first = await client.PostAsJsonAsync(DevicesPath, Register("court-box-1", Mac));
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var firstBody = JsonDocument.Parse(await first.Content.ReadAsStringAsync()).RootElement;
        Assert.False(firstBody.GetProperty("reclaimed").GetBoolean());
        var id = firstBody.GetProperty("device").GetProperty("id").GetGuid();
        var firstKey = firstBody.GetProperty("device_key").GetString();
        Assert.Equal(1, firstBody.GetProperty("key_version").GetInt32());

        var revoked = await client.PostAsync($"{DevicesPath}{id}/revoke", null);
        Assert.Equal(HttpStatusCode.OK, revoked.StatusCode);
        Assert.NotEqual(JsonValueKind.Null,
            JsonDocument.Parse(await revoked.Content.ReadAsStringAsync()).RootElement.GetProperty("revoked_at").ValueKind);

        // The recovery. Same code, same MAC — and the device_code_taken conflict that used
        // to make this impossible does not fire, because the row holding that code is the
        // one being reclaimed.
        var again = await client.PostAsJsonAsync(DevicesPath, Register("court-box-1", Mac));
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        var body = JsonDocument.Parse(await again.Content.ReadAsStringAsync()).RootElement;

        Assert.True(body.GetProperty("reclaimed").GetBoolean());
        Assert.Equal(2, body.GetProperty("key_version").GetInt32());
        Assert.NotEqual(firstKey, body.GetProperty("device_key").GetString());

        var device = body.GetProperty("device");
        Assert.Equal(id, device.GetProperty("id").GetGuid());               // one row, kept its history
        Assert.Equal(JsonValueKind.Null, device.GetProperty("revoked_at").ValueKind);
        Assert.True(device.GetProperty("enabled").GetBoolean());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Single(await db.Devices.IgnoreQueryFilters().Where(d => d.TenantId == s.TenantId).ToListAsync());

        var audit = await db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == s.TenantId && a.Action == "device.reclaimed").ToListAsync();
        Assert.Single(audit);
    }

    /// <summary>
    /// A second physical board is still a second row. Recovery keys on the MAC, so a
    /// registration without one — or with a different one — never absorbs another box.
    /// </summary>
    [SkippableFact]
    public async Task A_different_board_is_still_a_second_row()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var s = await SeedAsync(factory);
        var client = AdminClient(factory, s);

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync(DevicesPath, Register("court-box-1", Mac))).StatusCode);

        var other = await client.PostAsJsonAsync(DevicesPath, Register("court-box-2", "001122334455"));
        Assert.Equal(HttpStatusCode.OK, other.StatusCode);
        Assert.False(JsonDocument.Parse(await other.Content.ReadAsStringAsync()).RootElement.GetProperty("reclaimed").GetBoolean());

        // And the device-code conflict still stands between two DIFFERENT boards.
        Assert.Equal(HttpStatusCode.Conflict,
            (await client.PostAsJsonAsync(DevicesPath, Register("court-box-1", "aabbccddeeff"))).StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(2, await db.Devices.IgnoreQueryFilters().CountAsync(d => d.TenantId == s.TenantId));
    }

    /// <summary>
    /// A MAC stays optional — a box registered without one behaves exactly as before, and
    /// is simply not recoverable this way. Said in a test because "many devices may have no
    /// mac at all" is a uniqueness property the row store depends on.
    /// </summary>
    [SkippableFact]
    public async Task A_registration_without_a_mac_is_still_accepted()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var s = await SeedAsync(factory);
        var client = AdminClient(factory, s);

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync(DevicesPath, Register("box-a"))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync(DevicesPath, Register("box-b"))).StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(2, await db.Devices.IgnoreQueryFilters().CountAsync(d => d.TenantId == s.TenantId && d.MacAddress == null));
    }

    /// <summary>
    /// However the label prints it, the stored MAC is the twelve lowercase hex characters
    /// the boards announce — a hand-typed MAC that does not match byte for byte is worse
    /// than none, because it silently fails to recognise the board it exists to recognise.
    /// </summary>
    [Theory]
    [InlineData("5ccf7f1a2b3c", "5ccf7f1a2b3c")]
    [InlineData("5C:CF:7F:1A:2B:3C", "5ccf7f1a2b3c")]
    [InlineData("5c-cf-7f-1a-2b-3c", "5ccf7f1a2b3c")]
    [InlineData("5ccf.7f1a.2b3c", "5ccf7f1a2b3c")]
    [InlineData("  5ccf7f1a2b3c  ", "5ccf7f1a2b3c")]
    public void A_mac_is_normalised_to_the_form_the_boards_announce(string typed, string expected)
        => Assert.Equal(expected, DeviceRegistryService.NormaliseMacAddress(typed));

    [Theory]
    [InlineData("5ccf7f1a2b3")]          // eleven
    [InlineData("5ccf7f1a2b3cd")]        // thirteen
    [InlineData("5ccf7f1a2b3z")]         // not hex — must not silently become an 11-char prefix
    [InlineData("not a mac at all")]
    [InlineData("")]
    [InlineData(null)]
    public void A_mac_that_could_not_be_one_is_refused(string? typed)
        => Assert.Null(DeviceRegistryService.NormaliseMacAddress(typed));

    /// <summary>And the endpoint says so rather than storing nonsense.</summary>
    [SkippableFact]
    public async Task An_unusable_mac_is_refused_at_registration()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var s = await SeedAsync(factory);

        var response = await AdminClient(factory, s).PostAsJsonAsync(DevicesPath, Register("court-box-1", "5ccf7f1a2b3z"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(DeviceRegistryService.MacAddressInvalid,
            JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("error").GetString());
    }

    // ---- the cadence the page reads off a device (round-3 finding 22) ---------------------

    /// <summary>
    /// Every device view carries the interval the box will actually run at and the silence
    /// that means offline, so the Devices page derives its threshold from the club's own
    /// setting instead of a hardcoded 180 000 ms against a stale "every 30 s" comment.
    /// </summary>
    [SkippableFact]
    public async Task A_device_view_carries_the_effective_interval_and_the_offline_threshold()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var s = await SeedAsync(factory);
        var client = AdminClient(factory, s);

        // The seeded settings carry no heartbeat_seconds, so this is the default.
        var registered = await client.PostAsJsonAsync(DevicesPath, Register("court-box-1", Mac));
        var device = JsonDocument.Parse(await registered.Content.ReadAsStringAsync()).RootElement.GetProperty("device");

        Assert.Equal(TenantSettingsView.DefaultHeartbeatSeconds, device.GetProperty("effective_heartbeat_seconds").GetInt32());
        Assert.Equal(
            HeartbeatCadence.OfflineAfterSeconds(TenantSettingsView.DefaultHeartbeatSeconds),
            device.GetProperty("offline_after_seconds").GetInt32());

        // And it moves with the setting rather than staying at 180.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.TenantSettings.IgnoreQueryFilters().SingleAsync(x => x.TenantId == s.TenantId);
            row.SettingsJson = """{"timezone":"UTC","heartbeat_seconds":300}""";
            await db.SaveChangesAsync();
        }

        var listed = await client.GetFromJsonAsync<JsonElement>(DevicesPath);
        var box = listed.EnumerateArray().Single();
        Assert.Equal(300, box.GetProperty("effective_heartbeat_seconds").GetInt32());
        Assert.Equal(900, box.GetProperty("offline_after_seconds").GetInt32());
    }
}
