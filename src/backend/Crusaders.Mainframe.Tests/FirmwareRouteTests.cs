using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The firmware baked into the API image, over the wire.
///
/// <para>
/// Two halves. The static route: what a box's <c>ESPhttpUpdate</c> GET — anonymous, no
/// device signature, plain HTTP — gets back from <c>/firmware/</c>, and what it must not
/// get back (the config file next door, a listing, the unsigned-build README). And the
/// heartbeat: with a manifest baked and nothing configured, a box on an older build is
/// offered exactly that image, at a URL it can open, that serves those bytes.
/// </para>
///
/// <para>
/// In the postgres-http collection because the factory configures the application
/// through process environment variables, and so does the payload directory here.
/// The heartbeat tests need Postgres and skip cleanly without it; the route tests do not.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class FirmwareRouteTests
{
    private readonly PostgresFixture _pg;

    public FirmwareRouteTests(PostgresFixture pg) => _pg = pg;

    private const string HeartbeatPath = "/api/v1/device/heartbeat";
    private const string BinName = "court_bridge.signed.bin";

    // ---- the route ----------------------------------------------------------------

    [Fact]
    public async Task The_signed_image_is_served_as_an_octet_stream_with_the_exact_bytes()
    {
        using var payload = Payload.Signed("1.4.0");
        await using var factory = new TestWebAppFactory();
        var client = factory.CreateClient();

        var response = await client.GetAsync($"/firmware/{BinName}");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/octet-stream", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal(payload.Bytes, await response.Content.ReadAsByteArrayAsync());
        Assert.Equal(payload.Bytes.Length, response.Content.Headers.ContentLength);
        Assert.True(response.Headers.CacheControl?.MaxAge <= TimeSpan.FromMinutes(5), "cache header should be modest");
    }

    [Fact]
    public async Task The_manifest_is_served_as_json()
    {
        using var payload = Payload.Signed("1.4.0");
        await using var factory = new TestWebAppFactory();

        var response = await factory.CreateClient().GetAsync($"/firmware/{FirmwarePayload.ManifestFileName}");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("1.4.0", body.GetProperty("version").GetString());
        Assert.Equal($"/firmware/{BinName}", body.GetProperty("url").GetString());
        Assert.Equal(payload.Bytes.Length, body.GetProperty("sizeBytes").GetInt64());
    }

    /// <summary>
    /// The unsigned build's README, and anything else that is not an image or a manifest,
    /// is not a document this route hands out — only .bin and .json have a content type.
    /// </summary>
    [Fact]
    public async Task Only_images_and_manifests_are_served()
    {
        using var payload = Payload.Unsigned();
        await using var factory = new TestWebAppFactory();

        var response = await factory.CreateClient().GetAsync("/firmware/README.txt");

        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
        Assert.DoesNotContain("UNSIGNED", await response.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// The three spellings of "up one directory" that reach the server: the client
    /// normalises a literal <c>..</c> before sending, so the encoded forms are the ones
    /// that actually test the provider. None may reach appsettings.json.
    /// </summary>
    [Theory]
    [InlineData("/firmware/../appsettings.json")]
    [InlineData("/firmware/%2e%2e/appsettings.json")]
    [InlineData("/firmware/..%2fappsettings.json")]
    [InlineData("/firmware/%2e%2e%2fappsettings.json")]
    public async Task Traversal_out_of_the_payload_directory_is_refused(string path)
    {
        using var payload = Payload.Signed("1.4.0");
        await using var factory = new TestWebAppFactory();

        var response = await factory.CreateClient().GetAsync(path);

        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
        Assert.DoesNotContain("ConnectionStrings", await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("/firmware/")]
    [InlineData("/firmware")]
    public async Task The_directory_is_not_listed(string path)
    {
        using var payload = Payload.Signed("1.4.0");
        await using var factory = new TestWebAppFactory();

        var response = await factory.CreateClient().GetAsync(path);

        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
        Assert.DoesNotContain(BinName, await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task An_image_that_is_not_there_is_not_found()
    {
        using var payload = Payload.Unsigned();
        await using var factory = new TestWebAppFactory();

        var response = await factory.CreateClient().GetAsync($"/firmware/{BinName}");

        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
    }

    // ---- the heartbeat ------------------------------------------------------------

    /// <summary>
    /// The whole loop: nothing configured, a manifest baked, a box on 1.0.0 heartbeats and
    /// is offered 1.4.0 at an ABSOLUTE URL built from the address its heartbeat used —
    /// and fetching that URL serves the image the manifest describes.
    /// </summary>
    [SkippableFact]
    public async Task A_box_on_an_older_build_is_offered_the_baked_image_at_a_url_it_can_open()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        using var payload = Payload.Signed("1.4.0");
        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var box = await SeedAsync(factory);
        var client = factory.CreateClient();

        var response = await client.SendAsync(Signed(box, HeartbeatPath, new { running_version = "1.0.0" }));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        var ota = body.GetProperty("ota");
        Assert.Equal(JsonValueKind.Object, ota.ValueKind);
        Assert.Equal("1.4.0", ota.GetProperty("ota_version").GetString());
        Assert.Equal(payload.Bytes.Length, ota.GetProperty("ota_size").GetInt64());

        var url = ota.GetProperty("ota_url").GetString()!;
        // Absolute, with a scheme: HTTPClient::begin on the ESP8266 refuses anything else.
        Assert.True(Uri.TryCreate(url, UriKind.Absolute, out var absolute), $"ota_url must be absolute, was '{url}'");
        Assert.Equal(client.BaseAddress!.Scheme, absolute!.Scheme);
        Assert.Equal(client.BaseAddress.Host, absolute.Host);
        Assert.Equal($"/firmware/{BinName}", absolute.AbsolutePath);

        // ...and the URL the box was told is the URL that serves the image.
        var image = await client.GetAsync(absolute.PathAndQuery);
        Assert.Equal(HttpStatusCode.OK, image.StatusCode);
        Assert.Equal(payload.Bytes, await image.Content.ReadAsByteArrayAsync());
    }

    [SkippableFact]
    public async Task An_advertised_base_url_is_what_the_heartbeat_hands_out()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        using var payload = Payload.Signed("1.4.0");
        using var advertised = new EnvVar("Discovery__AdvertisedBaseUrl", "http://10.1.2.3:8088");
        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var box = await SeedAsync(factory);

        var response = await factory.CreateClient().SendAsync(Signed(box, HeartbeatPath, new { running_version = "1.0.0" }));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal($"http://10.1.2.3:8088/firmware/{BinName}", body.GetProperty("ota").GetProperty("ota_url").GetString());
    }

    /// <summary>
    /// Behind the documented gateway (closing re-review #8). nginx forwards a port-less
    /// Host, so the URL composed from it pointed at port 80 where nothing listens; the
    /// gateway now sends X-Forwarded-Host with the port the box used, and the API believes
    /// it from a trusted proxy. A box that reached the API at http://ip:8088 is offered
    /// an image at http://ip:8088/…; a direct call on :5000 is offered :5000.
    /// </summary>
    [SkippableFact]
    public async Task Behind_the_gateway_the_image_url_carries_the_forwarded_host_and_port()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        using var payload = Payload.Signed("1.4.0");
        await using var factory = new TestWebAppFactory
        {
            ConnectionString = _pg.ConnectionString,
            RemoteIpAddress = System.Net.IPAddress.Loopback,
        };
        var box = await SeedAsync(factory);

        var forwarded = Signed(box, HeartbeatPath, new { running_version = "1.0.0" });
        forwarded.Headers.Add("X-Forwarded-For", "192.168.68.150");
        forwarded.Headers.Add("X-Forwarded-Proto", "http");
        forwarded.Headers.Add("X-Forwarded-Host", "192.168.68.20:8088");
        var response = await factory.CreateClient().SendAsync(forwarded);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal($"http://192.168.68.20:8088/firmware/{BinName}", body.GetProperty("ota").GetProperty("ota_url").GetString());

        var direct = factory.CreateClient();
        direct.BaseAddress = new Uri("http://localhost:5000");
        var plain = await direct.SendAsync(Signed(box, HeartbeatPath, new { running_version = "1.0.0" }));
        Assert.Equal(HttpStatusCode.OK, plain.StatusCode);
        var plainBody = await plain.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal($"http://localhost:5000/firmware/{BinName}", plainBody.GetProperty("ota").GetProperty("ota_url").GetString());
    }

    /// <summary>
    /// The download is anonymous and 400 KB; it was the one unmetered surface on a
    /// host-networked on-prem box. A modest per-address ceiling, after the limiter.
    /// </summary>
    [Fact]
    public async Task The_firmware_download_is_rate_limited_per_address()
    {
        using var payload = Payload.Signed("1.4.0");
        await using var factory = new TestWebAppFactory
        {
            RateLimits = new Dictionary<string, int> { ["FirmwarePerMinute"] = 2 },
            RemoteIpAddress = System.Net.IPAddress.Parse("192.168.68.150"),
        };
        var client = factory.CreateClient();

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 5; i++) statuses.Add((await client.GetAsync($"/firmware/{BinName}")).StatusCode);

        Assert.Equal(HttpStatusCode.OK, statuses[0]);
        Assert.Equal(HttpStatusCode.OK, statuses[1]);
        Assert.Contains(HttpStatusCode.TooManyRequests, statuses.Skip(2));
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/healthz")).StatusCode);   // only the download is throttled
    }

    [SkippableFact]
    public async Task A_box_already_on_the_baked_version_is_offered_nothing()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        using var payload = Payload.Signed("1.4.0");
        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var box = await SeedAsync(factory);

        var response = await factory.CreateClient().SendAsync(Signed(box, HeartbeatPath, new { running_version = "1.4.0" }));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(JsonValueKind.Null, body.GetProperty("ota").ValueKind);
    }

    [SkippableFact]
    public async Task An_unsigned_image_offers_nothing_over_the_wire()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        using var payload = Payload.Unsigned();
        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var box = await SeedAsync(factory);

        var response = await factory.CreateClient().SendAsync(Signed(box, HeartbeatPath, new { running_version = "1.0.0" }));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(JsonValueKind.Null, body.GetProperty("ota").ValueKind);
    }

    // ---- scaffolding ------------------------------------------------------------------

    /// <summary>A process environment variable, set for the life of the scope and cleared after — the factory reads configuration this way.</summary>
    private sealed class EnvVar : IDisposable
    {
        private readonly string _name;
        public EnvVar(string name, string? value) { _name = name; Environment.SetEnvironmentVariable(name, value); }
        public void Dispose() => Environment.SetEnvironmentVariable(_name, null);
    }

    /// <summary>
    /// A temporary payload directory standing in for <c>/app/firmware</c>, in exactly the two
    /// shapes CI's iot-sign job produces, pointed at through <c>Firmware__PayloadPath</c>.
    /// </summary>
    private sealed class Payload : IDisposable
    {
        private readonly string _dir = Path.Combine(Path.GetTempPath(), "firmware-route-" + Guid.NewGuid().ToString("N"));
        private readonly EnvVar _env;

        public byte[] Bytes { get; private set; } = [];

        private Payload()
        {
            Directory.CreateDirectory(_dir);
            _env = new EnvVar("Firmware__PayloadPath", _dir);
        }

        public static Payload Signed(string version)
        {
            var payload = new Payload();
            payload.Bytes = RandomNumberGenerator.GetBytes(4096);
            File.WriteAllBytes(Path.Combine(payload._dir, BinName), payload.Bytes);
            File.WriteAllText(
                Path.Combine(payload._dir, FirmwarePayload.ManifestFileName),
                $$"""{"version":"{{version}}","url":"/firmware/{{BinName}}","sizeBytes":{{payload.Bytes.Length}}}""" + "\n");
            return payload;
        }

        public static Payload Unsigned()
        {
            var payload = new Payload();
            File.WriteAllText(Path.Combine(payload._dir, "README.txt"), "UNSIGNED BUILD — no firmware baked into this image.\n");
            return payload;
        }

        public void Dispose()
        {
            _env.Dispose();
            Directory.Delete(_dir, recursive: true);
        }
    }

    private sealed record Box(Guid DeviceId, byte[] Key);

    /// <summary>A tenant and one claimed court box, enough for a heartbeat to answer.</summary>
    private static async Task<Box> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"fw-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Firmware Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = """{"slice_minutes":15,"slice_price_credits":8,"grace_window_minutes":5,"timezone":"UTC","peak_hours":"16:00-19:00"}""",
        });
        db.Courts.Add(new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1", SlicePriceCredits = 8m });

        var device = new Device
        {
            TenantId = tenant.Id,
            DeviceCode = "court-box-1",
            Name = "Court 1 box",
            Kind = DeviceKind.CourtBox,
            Hardware = DeviceHardware.Esp8266,
            CourtNumbers = [1],
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();

        var keys = scope.ServiceProvider.GetRequiredService<IDeviceKeyDeriver>();
        return new Box(device.Id, keys.Derive(tenant.Id, device.Id, device.KeyVersion));
    }

    /// <summary>The device signature, as DeviceEventHttpTests builds it — copied rather than shared so this file stands alone.</summary>
    private static HttpRequestMessage Signed(Box box, string path, object payload)
    {
        var body = JsonSerializer.Serialize(payload);
        var bytes = Encoding.UTF8.GetBytes(body);
        var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var nonce = Guid.NewGuid().ToString("N");

        var canonical = DeviceRequestSigner.CanonicalString("POST", path, ts, nonce, bytes);
        var req = new HttpRequestMessage(HttpMethod.Post, path) { Content = new ByteArrayContent(bytes) };
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        req.Headers.Add(DeviceRequestSigner.DeviceIdHeader, box.DeviceId.ToString());
        req.Headers.Add(DeviceRequestSigner.TimestampHeader, ts.ToString());
        req.Headers.Add(DeviceRequestSigner.NonceHeader, nonce);
        req.Headers.Add(DeviceRequestSigner.SignatureHeader, DeviceRequestSigner.Sign(box.Key, canonical));
        return req;
    }
}
