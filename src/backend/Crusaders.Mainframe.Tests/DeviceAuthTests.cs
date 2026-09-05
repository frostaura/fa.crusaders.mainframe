using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The two pure pieces of the device credential: how a key is minted, and how one is
/// compared. Both are small enough that the risk is in the details — an encoding a C
/// string literal cannot carry, or a comparison that returns early.
/// </summary>
public class DeviceApiKeyTests
{
    [Fact]
    public void A_key_is_url_safe_and_padding_free()
    {
        var key = DeviceApiKey.Generate();

        Assert.Equal(43, key.Length);                  // 32 bytes, base64 minus padding
        Assert.DoesNotContain('=', key);
        Assert.DoesNotContain('+', key);
        Assert.DoesNotContain('/', key);
    }

    [Fact]
    public void Two_keys_are_never_the_same()
        => Assert.NotEqual(DeviceApiKey.Generate(), DeviceApiKey.Generate());

    [Fact]
    public void Matching_accepts_only_the_exact_key()
    {
        var key = DeviceApiKey.Generate();

        Assert.True(DeviceApiKey.Matches(key, key));
        Assert.False(DeviceApiKey.Matches(key, key[..^1]));            // a prefix
        Assert.False(DeviceApiKey.Matches(key, key + "x"));            // an extension
        Assert.False(DeviceApiKey.Matches(key, key[..^1] + "!"));      // one byte out
        Assert.False(DeviceApiKey.Matches(key, key.ToUpperInvariant()));
    }

    /// <summary>
    /// A null or empty stored key is what a club that has never opened the Devices page
    /// has. It must never be matchable — least of all by an empty bearer header.
    /// </summary>
    [Theory]
    [InlineData(null, "anything")]
    [InlineData("", "anything")]
    [InlineData("a-real-key", null)]
    [InlineData("a-real-key", "")]
    [InlineData(null, null)]
    [InlineData("", "")]
    public void An_absent_key_matches_nothing(string? stored, string? presented)
        => Assert.False(DeviceApiKey.Matches(stored, presented));

    [Theory]
    [InlineData("Bearer abc", "abc")]
    [InlineData("bearer abc", "abc")]           // header schemes are case-insensitive
    [InlineData("Bearer   abc  ", "abc")]
    [InlineData("abc", null)]                   // not a bearer header at all
    [InlineData("Basic abc", null)]
    [InlineData("Bearer ", null)]
    [InlineData("Bearer", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void The_bearer_key_is_read_off_the_header(string? header, string? expected)
        => Assert.Equal(expected, DeviceApiKey.FromAuthorizationHeader(header));

    /// <summary>
    /// A bound on what an unauthenticated caller can make the server hold and compare.
    /// </summary>
    [Fact]
    public void An_absurdly_long_bearer_value_is_dropped_rather_than_compared()
        => Assert.Null(DeviceApiKey.FromAuthorizationHeader("Bearer " + new string('a', DeviceApiKey.MaxLength + 1)));
}

/// <summary>
/// The device scheme over real HTTP, against the real schema.
///
/// <para>
/// Everything above is pure-function coverage; only these prove that a request carrying
/// the club key survives middleware ordering, resolves a tenant from the key rather than
/// from a Host header, registers an unknown board, and is rejected in every one of the
/// ways it should be. The in-memory provider cannot stand in — it does not apply
/// migrations and does not enforce the unique index that keeps two clubs' boxes apart.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DeviceAuthHttpTests
{
    private readonly PostgresFixture _pg;

    public DeviceAuthHttpTests(PostgresFixture pg) => _pg = pg;

    private const string HeartbeatPath = "/api/v1/device/heartbeat";
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed record Club(Guid TenantId, string Slug, string Key);

    /// <summary>
    /// Migrates and creates a club with a device key — and no devices at all, because a
    /// box registering itself is the path under test.
    ///
    /// <para>
    /// The slug is suffixed per call because every test in this class shares one database:
    /// an xUnit class fixture is created once, not once per test.
    /// </para>
    /// </summary>
    private static async Task<Club> ClubAsync(TestWebAppFactory factory, string slugPrefix)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"{slugPrefix}-{Guid.NewGuid():N}"[..24];
        var tenant = new Tenant
        {
            Slug = slug,
            DisplayName = $"Club {slug}",
            DeviceApiKey = DeviceApiKey.Generate(),
            DeviceApiKeyRegeneratedAt = DateTimeOffset.UtcNow,
        };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = """{"slice_minutes":15,"grace_window_minutes":5,"timezone":"UTC","heartbeat_seconds":45}""",
        });
        db.Courts.Add(new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1", SlicePriceCredits = 8m });
        await db.SaveChangesAsync();

        return new Club(tenant.Id, slug, tenant.DeviceApiKey!);
    }

    /// <summary>A random MAC, so tests in this shared database never collide on the unique index.</summary>
    private static string NewMac() => Guid.NewGuid().ToString("N")[..12];

    /// <summary>The request a correctly-implemented firmware would send.</summary>
    private static HttpRequestMessage Heartbeat(
        string? key, string mac, string? runningVersion = null, string? megaVersion = null, string? firmwareVersion = null)
    {
        var body = new JsonObject { ["mac"] = mac };
        if (runningVersion is not null) body["running_version"] = runningVersion;
        if (megaVersion is not null) body["mega_version"] = megaVersion;
        if (firmwareVersion is not null) body["firmware_version"] = firmwareVersion;

        var req = new HttpRequestMessage(HttpMethod.Post, HeartbeatPath)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        if (key is not null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        return req;
    }

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    [SkippableFact]
    public async Task An_unknown_board_registers_itself_and_the_response_resolves_the_tenant()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "alpha");
        var mac = NewMac();
        var client = factory.CreateClient();

        var response = await client.SendAsync(Heartbeat(club.Key, mac));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

        // Resolved from the key, not from the Host header — the client's host is
        // "localhost", which resolves to no tenant at all.
        Assert.Equal(club.Slug, json.GetProperty("tenant_slug").GetString());
        Assert.Equal($"box-{mac[^6..]}", json.GetProperty("device_code").GetString());
        Assert.Equal(15, json.GetProperty("config").GetProperty("slice_minutes").GetInt32());

        // The interval is the tenant's setting, not a hardcoded 60.
        Assert.Equal(45, json.GetProperty("heartbeat_seconds").GetInt32());

        // The club has exactly one court, so that is what the box was given.
        Assert.Equal(new[] { 1 }, json.GetProperty("court_numbers").EnumerateArray().Select(e => e.GetInt32()));

        // Nothing that belonged to the retired scheme survives on the wire.
        Assert.False(json.TryGetProperty("server_unix", out _));
        Assert.False(json.TryGetProperty("ota", out _));

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == mac);
        Assert.Equal(club.TenantId, device.TenantId);
        Assert.True(device.AutoRegistered);
    }

    /// <summary>A second heartbeat is the same board, not a second row.</summary>
    [SkippableFact]
    public async Task A_second_heartbeat_from_the_same_board_does_not_register_it_again()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "alpha");
        var mac = NewMac();
        var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, mac))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, mac))).StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(1, await db.Devices.IgnoreQueryFilters().CountAsync(d => d.MacAddress == mac));
    }

    /// <summary>
    /// The regression test for the bug the scheme was written to avoid. The endpoint reads
    /// its own device row through the global query filter; if the handler failed to set the
    /// tenant, that filter would evaluate against Guid.Empty and the row would be
    /// re-created on every call instead of updated.
    /// </summary>
    [SkippableFact]
    public async Task Heartbeat_writes_last_seen_and_versions_to_the_right_row()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "alpha");
        var mac = NewMac();
        var client = factory.CreateClient();

        var response = await client.SendAsync(
            Heartbeat(club.Key, mac, runningVersion: "2.3.4", megaVersion: "1.1.0"));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == mac);

        Assert.NotNull(device.LastSeenAt);
        Assert.Equal("2.3.4", device.RunningVersion);
        Assert.Equal("1.1.0", device.MegaVersion);
        Assert.Equal(club.TenantId, device.TenantId);
    }

    /// <summary>
    /// The contract calls the field <c>firmware_version</c> and the firmware writes
    /// <c>running_version</c>. Both are read, so a rename on either side degrades to a
    /// column that keeps updating rather than one that silently stops.
    /// </summary>
    [SkippableFact]
    public async Task Firmware_version_is_accepted_as_a_synonym_of_running_version()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "alpha");
        var mac = NewMac();
        var client = factory.CreateClient();

        await client.SendAsync(Heartbeat(club.Key, mac, firmwareVersion: "2.0.0"));

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal("2.0.0", (await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == mac)).RunningVersion);
    }

    [SkippableFact]
    public async Task A_request_with_no_key_is_rejected()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        await ClubAsync(factory, "alpha");
        var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync(HeartbeatPath, new { mac = NewMac() });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [SkippableFact]
    public async Task An_unrecognised_key_is_rejected()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        await ClubAsync(factory, "alpha");
        var client = factory.CreateClient();

        var response = await client.SendAsync(Heartbeat(DeviceApiKey.Generate(), NewMac()));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    /// <summary>
    /// Near-misses. A key one character short, one character long or one byte different
    /// must all be refused — this is what the constant-time comparison is comparing.
    /// </summary>
    [SkippableFact]
    public async Task A_key_that_is_nearly_right_is_rejected()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "alpha");
        var client = factory.CreateClient();

        foreach (var wrong in new[] { club.Key[..^1], club.Key + "x", club.Key[..^1] + (club.Key[^1] == 'a' ? 'b' : 'a') })
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(Heartbeat(wrong, NewMac()))).StatusCode);
        }
    }

    /// <summary>
    /// Regenerating has to bite on the next request. A grace window would mean a key an
    /// admin believes they have replaced still opens the club's courts.
    /// </summary>
    [SkippableFact]
    public async Task Regenerating_the_key_invalidates_the_previous_one_immediately()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "alpha");
        var mac = NewMac();
        var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, mac))).StatusCode);

        string replacement;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var tenant = await db.Tenants.SingleAsync(t => t.Id == club.TenantId);
            replacement = tenant.DeviceApiKey = DeviceApiKey.Generate();
            await db.SaveChangesAsync();
        }

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(Heartbeat(club.Key, mac))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(replacement, mac))).StatusCode);
    }

    /// <summary>A club that has never opened the Devices page has no key, and nothing opens it.</summary>
    [SkippableFact]
    public async Task A_club_with_no_key_cannot_be_reached_by_an_empty_one()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "alpha");
        var client = factory.CreateClient();

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var tenant = await db.Tenants.SingleAsync(t => t.Id == club.TenantId);
            tenant.DeviceApiKey = null;
            await db.SaveChangesAsync();
        }

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(Heartbeat("", NewMac()))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(Heartbeat(club.Key, NewMac()))).StatusCode);
    }

    /// <summary>
    /// The MAC is the board's whole identity, so a request without a usable one cannot be
    /// answered — and must say so rather than 404, which would read as "unknown board".
    /// </summary>
    [SkippableTheory]
    [InlineData("")]
    [InlineData("not-a-mac")]
    [InlineData("5ccf7f1a2b3")]
    public async Task A_heartbeat_without_a_usable_mac_is_a_bad_request(string mac)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "alpha");
        var client = factory.CreateClient();

        var response = await client.SendAsync(Heartbeat(club.Key, mac));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    /// <summary>
    /// A box an admin switched off is refused rather than silently re-registered around
    /// the disable — which would make the switch a lie.
    /// </summary>
    [SkippableFact]
    public async Task A_disabled_box_is_refused()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "alpha");
        var mac = NewMac();
        var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(club.Key, mac))).StatusCode);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == mac);
            device.Enabled = false;
            await db.SaveChangesAsync();
        }

        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(Heartbeat(club.Key, mac))).StatusCode);
    }

    /// <summary>
    /// One club's key must never reach another club's board. With per-device keys this was
    /// a stolen-box attack; with a club key it is the whole of tenant isolation on this
    /// surface, so it is worth proving rather than assuming.
    /// </summary>
    [SkippableFact]
    public async Task A_clubs_key_only_ever_registers_boards_into_that_club()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var alpha = await ClubAsync(factory, "alpha");
        var bravo = await ClubAsync(factory, "bravo");
        var client = factory.CreateClient();

        Assert.NotEqual(alpha.TenantId, bravo.TenantId);
        Assert.NotEqual(alpha.Key, bravo.Key);

        var alphaMac = NewMac();
        var bravoMac = NewMac();

        var a = JsonDocument.Parse(await (await client.SendAsync(Heartbeat(alpha.Key, alphaMac))).Content.ReadAsStringAsync()).RootElement;
        var b = JsonDocument.Parse(await (await client.SendAsync(Heartbeat(bravo.Key, bravoMac))).Content.ReadAsStringAsync()).RootElement;

        Assert.Equal(alpha.Slug, a.GetProperty("tenant_slug").GetString());
        Assert.Equal(bravo.Slug, b.GetProperty("tenant_slug").GetString());

        // Bravo's key naming alpha's board: a new row in BRAVO, never alpha's row.
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Heartbeat(bravo.Key, alphaMac))).StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var rows = await db.Devices.IgnoreQueryFilters().Where(d => d.MacAddress == alphaMac).ToListAsync();
        Assert.Equal(2, rows.Count);
        Assert.Contains(rows, r => r.TenantId == alpha.TenantId);
        Assert.Contains(rows, r => r.TenantId == bravo.TenantId);
    }

    /// <summary>
    /// A device credential must not open the admin surface. This is the whole reason the
    /// scheme exists rather than baking an admin JWT into a board.
    /// </summary>
    [SkippableFact]
    public async Task Device_credentials_do_not_reach_the_admin_surface()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "alpha");
        var client = factory.CreateClient();

        var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/admin/devices/");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", club.Key);

        var response = await client.SendAsync(req);

        // BadRequest is a legitimate outcome here and not a weakening of the assertion: the
        // admin surface resolves its tenant from the JWT or the Host, and a device key is
        // neither, so the request dies at tenant resolution rather than at authorisation.
        // What matters is that it is never 200 with a device list in it.
        Assert.True(
            response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden or HttpStatusCode.BadRequest,
            $"A device reached the admin surface with {(int)response.StatusCode}.");
    }
}
