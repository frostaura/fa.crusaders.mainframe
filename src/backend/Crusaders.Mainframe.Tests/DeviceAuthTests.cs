using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Unit-level tests for the two pure pieces of device auth: key derivation and the
/// canonical string. These need no database and no host, and they cover the parts the
/// firmware has to reproduce byte for byte on an 8-bit micro — where a mismatch
/// produces a 401 with no diagnostic and costs a trip to the club.
/// </summary>
public class DeviceKeyDerivationTests
{
    private const string Master = "unit-test-master-key-that-is-definitely-long-enough";

    private static DeviceKeyDeriver Deriver(string master = Master)
        => new(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Devices:MasterKey"] = master })
            .Build());

    [Fact]
    public void Derivation_is_deterministic()
    {
        var tenant = Guid.NewGuid();
        var device = Guid.NewGuid();

        Assert.Equal(Deriver().Derive(tenant, device, 1), Deriver().Derive(tenant, device, 1));
    }

    [Fact]
    public void Key_is_thirty_two_bytes()
    {
        Assert.Equal(32, Deriver().Derive(Guid.NewGuid(), Guid.NewGuid(), 1).Length);
    }

    /// <summary>Rotation is a version bump, so the bump must actually change the key.</summary>
    [Fact]
    public void Version_bump_changes_the_key()
    {
        var tenant = Guid.NewGuid();
        var device = Guid.NewGuid();
        var d = Deriver();

        Assert.NotEqual(d.Derive(tenant, device, 1), d.Derive(tenant, device, 2));
    }

    /// <summary>
    /// The tenant is HKDF salt. Two tenants that somehow shared a device id — a restored
    /// backup, a copy-pasted provisioning script — must still get different keys.
    /// </summary>
    [Fact]
    public void Two_tenants_with_the_same_device_id_get_different_keys()
    {
        var device = Guid.NewGuid();
        var d = Deriver();

        Assert.NotEqual(d.Derive(Guid.NewGuid(), device, 1), d.Derive(Guid.NewGuid(), device, 1));
    }

    [Fact]
    public void Two_devices_in_one_tenant_get_different_keys()
    {
        var tenant = Guid.NewGuid();
        var d = Deriver();

        Assert.NotEqual(d.Derive(tenant, Guid.NewGuid(), 1), d.Derive(tenant, Guid.NewGuid(), 1));
    }

    [Fact]
    public void Different_master_key_yields_a_different_device_key()
    {
        var tenant = Guid.NewGuid();
        var device = Guid.NewGuid();

        Assert.NotEqual(
            Deriver().Derive(tenant, device, 1),
            Deriver("a-completely-different-master-key-also-long-enough").Derive(tenant, device, 1));
    }

    [Fact]
    public void Encoded_key_is_base64url_and_padding_free()
    {
        var encoded = Deriver().DeriveEncoded(Guid.NewGuid(), Guid.NewGuid(), 1);

        Assert.DoesNotContain('=', encoded);
        Assert.DoesNotContain('+', encoded);
        Assert.DoesNotContain('/', encoded);
        Assert.Equal(43, encoded.Length);   // 32 bytes base64 minus padding
    }

    /// <summary>
    /// A missing master key must be a startup failure, not a silent fallback to a
    /// constant — which is the shape of bug that ships a fleet-wide known key.
    /// </summary>
    [Fact]
    public void Missing_master_key_throws()
    {
        var config = new ConfigurationBuilder().Build();
        Assert.Throws<InvalidOperationException>(() => new DeviceKeyDeriver(config));
    }

    [Fact]
    public void Short_master_key_throws()
    {
        Assert.Throws<InvalidOperationException>(() => Deriver("too-short"));
    }

    /// <summary>The flat env-var form is what docker-compose actually sets.</summary>
    [Fact]
    public void Flat_env_var_name_binds()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["DEVICE_MASTER_KEY"] = Master })
            .Build();

        Assert.Equal(32, new DeviceKeyDeriver(config).Derive(Guid.NewGuid(), Guid.NewGuid(), 1).Length);
    }
}

public class DeviceRequestSignerTests
{
    private static readonly byte[] Key = Encoding.UTF8.GetBytes("0123456789abcdef0123456789abcdef");

    [Fact]
    public void Canonical_string_has_five_newline_separated_fields()
    {
        var c = DeviceRequestSigner.CanonicalString("post", "/api/v1/device/heartbeat", 1700000000, "abc", []);
        var parts = c.Split('\n');

        Assert.Equal(5, parts.Length);
        Assert.Equal("POST", parts[0]);                      // method upper-cased
        Assert.Equal("/api/v1/device/heartbeat", parts[1]);
        Assert.Equal("1700000000", parts[2]);
        Assert.Equal("abc", parts[3]);
        Assert.Equal(64, parts[4].Length);                   // hex sha256
    }

    /// <summary>The empty-body hash is a constant the firmware hardcodes. Pin it.</summary>
    [Fact]
    public void Empty_body_hashes_to_the_known_sha256_of_nothing()
    {
        var c = DeviceRequestSigner.CanonicalString("GET", "/x", 1, "n", []);
        Assert.EndsWith("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", c);
    }

    [Theory]
    [InlineData("GET", "/api/v1/device/heartbeat", 1700000000L, "n1")]
    [InlineData("POST", "/api/v1/device/heartbeat", 1700000000L, "n1")]   // method differs
    [InlineData("GET", "/api/v1/device/other", 1700000000L, "n1")]        // path differs
    [InlineData("GET", "/api/v1/device/heartbeat", 1700000001L, "n1")]    // timestamp differs
    [InlineData("GET", "/api/v1/device/heartbeat", 1700000000L, "n2")]    // nonce differs
    public void Every_field_participates_in_the_signature(string method, string path, long ts, string nonce)
    {
        var baseline = DeviceRequestSigner.Sign(Key,
            DeviceRequestSigner.CanonicalString("GET", "/api/v1/device/heartbeat", 1700000000L, "n1", []));
        var candidate = DeviceRequestSigner.Sign(Key,
            DeviceRequestSigner.CanonicalString(method, path, ts, nonce, []));

        var isBaseline = method == "GET" && path == "/api/v1/device/heartbeat" && ts == 1700000000L && nonce == "n1";
        if (isBaseline) Assert.Equal(baseline, candidate);
        else Assert.NotEqual(baseline, candidate);
    }

    /// <summary>
    /// A query string is part of the signed path, so <c>?admin=1</c> cannot be bolted
    /// onto a captured signature.
    /// </summary>
    [Fact]
    public void Query_string_is_signed()
    {
        var plain = DeviceRequestSigner.CanonicalString("GET", "/a", 1, "n", []);
        var withQuery = DeviceRequestSigner.CanonicalString("GET", "/a?admin=1", 1, "n", []);

        Assert.NotEqual(DeviceRequestSigner.Sign(Key, plain), DeviceRequestSigner.Sign(Key, withQuery));
    }

    [Fact]
    public void Body_is_signed()
    {
        var a = DeviceRequestSigner.CanonicalString("POST", "/a", 1, "n", "{\"court\":1}"u8);
        var b = DeviceRequestSigner.CanonicalString("POST", "/a", 1, "n", "{\"court\":2}"u8);

        Assert.NotEqual(DeviceRequestSigner.Sign(Key, a), DeviceRequestSigner.Sign(Key, b));
    }

    /// <summary>
    /// The canonicalisation hole this format exists to close: fields must not be able
    /// to slide across their delimiters into one another.
    /// </summary>
    [Fact]
    public void Fields_cannot_be_smuggled_across_the_delimiter()
    {
        var honest = DeviceRequestSigner.CanonicalString("GET", "/a", 1, "n", []);
        var smuggled = DeviceRequestSigner.CanonicalString("GET", "/a\n1\nn", 1, "n", []);

        Assert.NotEqual(honest, smuggled);
    }

    [Fact]
    public void Signature_is_lowercase_hex_of_the_expected_length()
    {
        var sig = DeviceRequestSigner.Sign(Key, "anything");

        Assert.Equal(64, sig.Length);
        Assert.Equal(sig.ToLowerInvariant(), sig);
        Assert.All(sig, c => Assert.True(Uri.IsHexDigit(c)));
    }

    [Fact]
    public void Verify_accepts_a_correct_signature_and_rejects_everything_else()
    {
        const string canonical = "GET\n/a\n1\nn\nx";
        var sig = DeviceRequestSigner.Sign(Key, canonical);

        Assert.True(DeviceRequestSigner.Verify(Key, canonical, sig));
        Assert.False(DeviceRequestSigner.Verify(Key, canonical, sig.ToUpperInvariant()));
        Assert.False(DeviceRequestSigner.Verify(Key, canonical, sig[..^1] + "0"));
        Assert.False(DeviceRequestSigner.Verify(Key, canonical, sig[..32]));
        Assert.False(DeviceRequestSigner.Verify(Key, canonical, ""));
        Assert.False(DeviceRequestSigner.Verify(Key, canonical, null!));
        Assert.False(DeviceRequestSigner.Verify(Encoding.UTF8.GetBytes("fedcba9876543210fedcba9876543210"), canonical, sig));
    }
}

/// <summary>
/// The device scheme over real HTTP, against the real schema.
///
/// <para>
/// These are the tests the plan calls for by name. Everything above is pure-function
/// coverage; only these prove that a signed request survives middleware ordering,
/// resolves a tenant from the device row rather than from a Host header, and is
/// rejected in every one of the ways it should be. The in-memory provider cannot
/// stand in — it does not apply migrations and does not enforce the unique index that
/// keeps two clubs' <c>court-box-1</c> apart.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DeviceAuthHttpTests
{
    private readonly PostgresFixture _pg;

    public DeviceAuthHttpTests(PostgresFixture pg) => _pg = pg;

    private const string HeartbeatPath = "/api/v1/device/heartbeat";

    private sealed record Provisioned(Guid DeviceId, byte[] Key, Guid TenantId, string Slug);

    /// <summary>
    /// Migrates, creates a tenant and a device, and returns the key the box would carry.
    ///
    /// <para>
    /// The slug is suffixed per call because every test in this class shares one
    /// database — an xUnit class fixture is created once, not once per test. The
    /// <b>device code is not</b> suffixed: "court-box-1" repeating across tenants is
    /// the condition being tested, and the unique index is scoped to the tenant.
    /// </para>
    /// </summary>
    private static async Task<Provisioned> ProvisionAsync(
        TestWebAppFactory factory, string slugPrefix, bool enabled = true, DateTimeOffset? revokedAt = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"{slugPrefix}-{Guid.NewGuid():N}"[..24];
        var tenant = new Tenant { Slug = slug, DisplayName = $"Club {slug}" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = """{"slice_minutes":15,"grace_window_minutes":5,"timezone":"UTC"}""",
        });

        var device = new Device
        {
            TenantId = tenant.Id,
            DeviceCode = "court-box-1",
            Name = "Court 1 box",
            Kind = DeviceKind.CourtBox,
            Hardware = DeviceHardware.Esp8266,
            CourtNumber = 1,
            Enabled = enabled,
            RevokedAt = revokedAt,
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();

        var keys = scope.ServiceProvider.GetRequiredService<IDeviceKeyDeriver>();
        return new Provisioned(device.Id, keys.Derive(tenant.Id, device.Id, device.KeyVersion), tenant.Id, slug);
    }

    /// <summary>Builds the request a correctly-implemented firmware would send.</summary>
    private static HttpRequestMessage Signed(
        Provisioned p,
        string method = "POST",
        string path = HeartbeatPath,
        string body = """{"running_version":"1.0.0","mega_version":"0.9.0"}""",
        long? unixSeconds = null,
        string? nonce = null,
        byte[]? signWithKey = null,
        string? overrideSignature = null)
    {
        var ts = unixSeconds ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var n = nonce ?? Guid.NewGuid().ToString("N");
        var bytes = Encoding.UTF8.GetBytes(body);

        var canonical = DeviceRequestSigner.CanonicalString(method, path, ts, n, bytes);
        var signature = overrideSignature ?? DeviceRequestSigner.Sign(signWithKey ?? p.Key, canonical);

        var req = new HttpRequestMessage(new HttpMethod(method), path)
        {
            Content = new ByteArrayContent(bytes),
        };
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        req.Headers.Add(DeviceRequestSigner.DeviceIdHeader, p.DeviceId.ToString());
        req.Headers.Add(DeviceRequestSigner.TimestampHeader, ts.ToString());
        req.Headers.Add(DeviceRequestSigner.NonceHeader, n);
        req.Headers.Add(DeviceRequestSigner.SignatureHeader, signature);
        return req;
    }

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    [SkippableFact]
    public async Task A_correctly_signed_heartbeat_is_accepted_and_resolves_the_tenant()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var p = await ProvisionAsync(factory, "alpha");
        var client = factory.CreateClient();

        var response = await client.SendAsync(Signed(p));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

        // Resolved from the device row, not from the Host header — the client's host is
        // "localhost", which resolves to no tenant at all.
        Assert.Equal(p.Slug, json.GetProperty("tenant_slug").GetString());
        Assert.Equal("court-box-1", json.GetProperty("device_code").GetString());
        Assert.Equal(1, json.GetProperty("court_number").GetInt32());
        Assert.Equal(15, json.GetProperty("config").GetProperty("slice_minutes").GetInt32());
    }

    /// <summary>
    /// The regression test for the bug this handler was written to avoid. The endpoint
    /// reads its own device row through the global query filter; if the handler failed
    /// to set the tenant, that filter would evaluate against Guid.Empty, the row would
    /// not be found, and this would 404 rather than 200.
    /// </summary>
    [SkippableFact]
    public async Task Heartbeat_writes_last_seen_and_versions_to_the_right_row()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var p = await ProvisionAsync(factory, "alpha");
        var client = factory.CreateClient();

        var response = await client.SendAsync(Signed(p, body: """{"running_version":"2.3.4","mega_version":"1.1.0"}"""));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.Id == p.DeviceId);

        Assert.NotNull(device.LastSeenAt);
        Assert.Equal("2.3.4", device.RunningVersion);
        Assert.Equal("1.1.0", device.MegaVersion);
        Assert.Equal(p.TenantId, device.TenantId);
    }

    [SkippableFact]
    public async Task Unsigned_request_is_rejected()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        await ProvisionAsync(factory, "alpha");
        var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync(HeartbeatPath, new { running_version = "1.0.0" });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [SkippableFact]
    public async Task Wrong_key_is_rejected()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var p = await ProvisionAsync(factory, "alpha");
        var client = factory.CreateClient();

        var wrong = new byte[32];
        Array.Fill(wrong, (byte)7);

        var response = await client.SendAsync(Signed(p, signWithKey: wrong));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    /// <summary>
    /// Tampering after signing. The body is hashed into the canonical string, so a
    /// captured signature cannot be re-used over different content.
    /// </summary>
    [SkippableFact]
    public async Task Body_tampered_after_signing_is_rejected()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var p = await ProvisionAsync(factory, "alpha");
        var client = factory.CreateClient();

        var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var nonce = Guid.NewGuid().ToString("N");
        var honest = """{"running_version":"1.0.0"}""";
        var signature = DeviceRequestSigner.Sign(p.Key,
            DeviceRequestSigner.CanonicalString("POST", HeartbeatPath, ts, nonce, Encoding.UTF8.GetBytes(honest)));

        var req = new HttpRequestMessage(HttpMethod.Post, HeartbeatPath)
        {
            Content = new StringContent("""{"running_version":"6.6.6"}""", Encoding.UTF8, "application/json"),
        };
        req.Headers.Add(DeviceRequestSigner.DeviceIdHeader, p.DeviceId.ToString());
        req.Headers.Add(DeviceRequestSigner.TimestampHeader, ts.ToString());
        req.Headers.Add(DeviceRequestSigner.NonceHeader, nonce);
        req.Headers.Add(DeviceRequestSigner.SignatureHeader, signature);

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(req)).StatusCode);
    }

    /// <summary>
    /// Replay. The same bytes, sent twice, must fail the second time — otherwise a
    /// captured lights-on request works forever on an open club LAN.
    /// </summary>
    [SkippableFact]
    public async Task Replayed_nonce_is_rejected()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var p = await ProvisionAsync(factory, "alpha");
        var client = factory.CreateClient();

        var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var nonce = Guid.NewGuid().ToString("N");

        var first = await client.SendAsync(Signed(p, unixSeconds: ts, nonce: nonce));
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        var replay = await client.SendAsync(Signed(p, unixSeconds: ts, nonce: nonce));
        Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);
    }

    [SkippableTheory]
    [InlineData(-3600)]   // an hour behind
    [InlineData(3600)]    // an hour ahead
    [InlineData(-300)]    // just outside the two-minute window
    public async Task Stale_or_future_timestamp_is_rejected(int offsetSeconds)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var p = await ProvisionAsync(factory, "alpha");
        var client = factory.CreateClient();

        var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + offsetSeconds;
        var response = await client.SendAsync(Signed(p, unixSeconds: ts));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    /// <summary>
    /// The recovery path for a rejected clock. The box has no RTC; a board whose clock
    /// has drifted past the skew window can never sign a valid request again, so an
    /// empty 401 would strand it until someone reprovisioned (finding C1). The
    /// challenge body carries the server's own clock — and nothing else, because why
    /// the request failed is for the log, never for the response.
    /// </summary>
    [SkippableFact]
    public async Task Stale_timestamp_gets_401_with_server_unix_body()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var p = await ProvisionAsync(factory, "alpha");
        var client = factory.CreateClient();

        var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 300;   // outside the two-minute window
        var response = await client.SendAsync(Signed(p, unixSeconds: ts));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);

        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        Assert.InRange(json.GetProperty("server_unix").GetInt64(), now - 60, now + 60);
    }

    [SkippableFact]
    public async Task Disabled_device_is_rejected()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var p = await ProvisionAsync(factory, "alpha", enabled: false);
        var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(Signed(p))).StatusCode);
    }

    [SkippableFact]
    public async Task Revoked_device_is_rejected()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var p = await ProvisionAsync(factory, "alpha", revokedAt: DateTimeOffset.UtcNow);
        var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(Signed(p))).StatusCode);
    }

    [SkippableFact]
    public async Task Unknown_device_id_is_rejected()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var p = await ProvisionAsync(factory, "alpha");
        var client = factory.CreateClient();

        var ghost = p with { DeviceId = Guid.NewGuid() };
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(Signed(ghost))).StatusCode);
    }

    [SkippableFact]
    public async Task Malformed_headers_are_rejected_rather_than_crashing()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var p = await ProvisionAsync(factory, "alpha");
        var client = factory.CreateClient();

        async Task<HttpStatusCode> SendAsync(Action<HttpRequestMessage> mutate)
        {
            var req = new HttpRequestMessage(HttpMethod.Post, HeartbeatPath)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            };
            mutate(req);
            return (await client.SendAsync(req)).StatusCode;
        }

        // Device id that is not a guid.
        Assert.Equal(HttpStatusCode.Unauthorized, await SendAsync(r =>
        {
            r.Headers.Add(DeviceRequestSigner.DeviceIdHeader, "not-a-guid");
            r.Headers.Add(DeviceRequestSigner.TimestampHeader, "1");
            r.Headers.Add(DeviceRequestSigner.NonceHeader, "n");
            r.Headers.Add(DeviceRequestSigner.SignatureHeader, "00");
        }));

        // Timestamp that is not a number.
        Assert.Equal(HttpStatusCode.Unauthorized, await SendAsync(r =>
        {
            r.Headers.Add(DeviceRequestSigner.DeviceIdHeader, p.DeviceId.ToString());
            r.Headers.Add(DeviceRequestSigner.TimestampHeader, "yesterday");
            r.Headers.Add(DeviceRequestSigner.NonceHeader, "n");
            r.Headers.Add(DeviceRequestSigner.SignatureHeader, "00");
        }));

        // Device id present, everything else missing.
        Assert.Equal(HttpStatusCode.Unauthorized, await SendAsync(r =>
            r.Headers.Add(DeviceRequestSigner.DeviceIdHeader, p.DeviceId.ToString())));
    }

    /// <summary>
    /// Rotation must actually revoke. A box still holding the old key is offline until
    /// re-provisioned — deliberately, since a rotation that left the old key working
    /// would not be a rotation.
    /// </summary>
    [SkippableFact]
    public async Task Key_rotation_invalidates_the_previous_key()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var p = await ProvisionAsync(factory, "alpha");
        var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Signed(p))).StatusCode);

        byte[] newKey;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.Id == p.DeviceId);
            device.KeyVersion++;
            await db.SaveChangesAsync();

            newKey = scope.ServiceProvider.GetRequiredService<IDeviceKeyDeriver>()
                .Derive(device.TenantId, device.Id, device.KeyVersion);
        }

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(Signed(p))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Signed(p with { Key = newKey }))).StatusCode);
    }

    /// <summary>
    /// The cross-tenant test that matters for hardware: one club's box, correctly
    /// signed, must land on its own tenant even when a second club exists in the same
    /// database with an identically-coded device.
    /// </summary>
    [SkippableFact]
    public async Task Two_tenants_with_identical_device_codes_stay_apart()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var alpha = await ProvisionAsync(factory, "alpha");
        var bravo = await ProvisionAsync(factory, "bravo");
        var client = factory.CreateClient();

        Assert.NotEqual(alpha.TenantId, bravo.TenantId);
        Assert.NotEqual(alpha.Key, bravo.Key);

        var a = JsonDocument.Parse(await (await client.SendAsync(Signed(alpha))).Content.ReadAsStringAsync()).RootElement;
        var b = JsonDocument.Parse(await (await client.SendAsync(Signed(bravo))).Content.ReadAsStringAsync()).RootElement;

        Assert.Equal(alpha.Slug, a.GetProperty("tenant_slug").GetString());
        Assert.Equal(bravo.Slug, b.GetProperty("tenant_slug").GetString());

        // Alpha's key over bravo's device id: the exact shape of a stolen-box attack.
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await client.SendAsync(Signed(bravo with { Key = alpha.Key }))).StatusCode);
    }

    /// <summary>
    /// A device credential must not open the admin surface. This is the whole reason
    /// the scheme exists rather than baking an admin JWT into a board.
    /// </summary>
    [SkippableFact]
    public async Task Device_credentials_do_not_reach_the_admin_surface()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var p = await ProvisionAsync(factory, "alpha");
        var client = factory.CreateClient();

        var response = await client.SendAsync(Signed(p, method: "GET", path: "/api/v1/admin/devices/", body: ""));

        Assert.True(
            response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden or HttpStatusCode.BadRequest,
            $"A device reached the admin surface with {(int)response.StatusCode}.");
    }
}
