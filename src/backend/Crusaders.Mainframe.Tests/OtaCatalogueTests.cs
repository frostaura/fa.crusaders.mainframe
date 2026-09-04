using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Security.Discovery;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Which firmware a given box should be running.
///
/// <para>
/// The catalogue is <b>deployment configuration, not a tenant setting</b>. A firmware
/// build belongs to this deployment of the product, not to a squash club: every tenant
/// on an instance runs the same images, and asking each club to maintain its own list
/// would mean a fix reaching some clubs and not others depending on who last edited a
/// JSON blob. Per-club and per-box control lives where it belongs instead — the
/// channel and the pin on the device row.
/// </para>
///
/// <para>
/// Since Phase 5b the promoted release also comes from the image itself: CI bakes the
/// signed court-box build and its manifest into the API container, and Stable falls back
/// to that manifest when nothing is configured. The tests below drive the fallback
/// through a temporary payload directory so they never depend on what the checkout's
/// <c>firmware-payload/</c> happens to hold.
/// </para>
/// </summary>
public class OtaCatalogueTests : IDisposable
{
    private readonly string _payloadDir = Path.Combine(Path.GetTempPath(), "ota-catalogue-" + Guid.NewGuid().ToString("N"));
    private readonly CapturingLogger _log = new();

    public OtaCatalogueTests() => Directory.CreateDirectory(_payloadDir);

    public void Dispose() => Directory.Delete(_payloadDir, recursive: true);

    private OtaCatalogue Catalogue(params (string Key, string Value)[] settings) => Catalogue(null, settings);

    private OtaCatalogue Catalogue(HttpContext? current, params (string Key, string Value)[] settings)
    {
        var all = settings.ToDictionary(s => s.Key, s => (string?)s.Value);
        // Always pinned to the test's own empty directory unless the test says otherwise,
        // so the checkout's firmware-payload/ can never leak into a "nothing configured"
        // assertion.
        all.TryAdd(FirmwarePayload.PathKey, _payloadDir);
        var config = new ConfigurationBuilder().AddInMemoryCollection(all).Build();
        return new OtaCatalogue(
            config,
            new FakeEnvironment(),
            _log,
            DiscoveryOptions.FromConfiguration(config),
            current is null ? null : new HttpContextAccessor { HttpContext = current });
    }

    private static Device Box(OtaChannel channel = OtaChannel.Stable, string? pinned = null) => new()
    {
        TenantId = Guid.NewGuid(),
        DeviceCode = "court-box-1",
        Name = "Court 1 box",
        OtaChannel = channel,
        PinnedVersion = pinned,
    };

    private static (string, string)[] Stable(string version = "1.2.0") =>
    [
        ("Ota:Stable:Version", version),
        ("Ota:Stable:Url", $"https://fw.example/{version}.bin"),
        ("Ota:Stable:SizeBytes", "328192"),
    ];

    /// <summary>What CI's iot-sign job writes beside the signed image, byte for byte in shape.</summary>
    private void BakeManifest(string version = "1.4.0", long sizeBytes = 402_176)
        => File.WriteAllText(
            Path.Combine(_payloadDir, FirmwarePayload.ManifestFileName),
            $$"""{"version":"{{version}}","url":"/firmware/court_bridge.signed.bin","sizeBytes":{{sizeBytes}}}""");

    private static HttpContext RequestOn(string host, string scheme = "http")
    {
        var ctx = new DefaultHttpContext();
        ctx.Request.Scheme = scheme;
        ctx.Request.Host = new HostString(host);
        return ctx;
    }

    // ---- configuration ---------------------------------------------------------

    [Fact]
    public void An_instance_with_no_published_firmware_offers_nothing()
    {
        // The default, and the correct behaviour for a deployment nobody has published
        // firmware for. A catalogue that defaulted to pointing somewhere is how a box
        // ends up fetching an image nobody meant it to.
        Assert.Null(Catalogue().For(Box()));
    }

    [Fact]
    public void A_stable_box_gets_the_promoted_release()
    {
        var release = Catalogue(Stable()).For(Box());
        Assert.NotNull(release);
        Assert.Equal("1.2.0", release!.Version);
        Assert.Equal(328192, release.SizeBytes);
    }

    [Theory]
    [InlineData("Ota:Stable:Version")]
    [InlineData("Ota:Stable:Url")]
    [InlineData("Ota:Stable:SizeBytes")]
    public void A_half_configured_release_is_treated_as_no_release(string missing)
    {
        // Offered-and-refused by every box in the fleet is worse than not offered:
        // it looks like the update is stuck rather than like nothing was published.
        var settings = Stable().Where(s => s.Item1 != missing).ToArray();
        Assert.Null(Catalogue(settings).For(Box()));
    }

    [Fact]
    public void A_canary_box_falls_back_to_stable_rather_than_being_stranded()
    {
        // A deployment that has not published a canary build should leave its canary
        // boxes on the promoted one, not leave them without updates entirely.
        var release = Catalogue(Stable()).For(Box(OtaChannel.Canary));
        Assert.Equal("1.2.0", release?.Version);
    }

    [Fact]
    public void A_canary_box_takes_the_canary_build_when_there_is_one()
    {
        var settings = Stable().Concat(new[]
        {
            ("Ota:Canary:Version", "1.3.0-canary"),
            ("Ota:Canary:Url", "https://fw.example/canary.bin"),
            ("Ota:Canary:SizeBytes", "330000"),
        }).ToArray();

        Assert.Equal("1.3.0-canary", Catalogue(settings).For(Box(OtaChannel.Canary))?.Version);
        // ...and the rest of the fleet is untouched, which is the whole point of one
        // box going first.
        Assert.Equal("1.2.0", Catalogue(settings).For(Box())?.Version);
    }

    [Fact]
    public void A_pinned_box_stays_pinned_even_when_the_pin_is_older()
    {
        // The point of pinning: a club holding one court on a build they trust while a
        // regression is investigated must not have it dragged forward by the next
        // heartbeat.
        var settings = Stable("2.0.0").Concat(new[]
        {
            ("Ota:Versions:1.1.0:Version", "1.1.0"),
            ("Ota:Versions:1.1.0:Url", "https://fw.example/1.1.0.bin"),
            ("Ota:Versions:1.1.0:SizeBytes", "320000"),
        }).ToArray();

        Assert.Equal("1.1.0", Catalogue(settings).For(Box(OtaChannel.Pinned, "1.1.0"))?.Version);
    }

    [Fact]
    public void A_pin_naming_the_promoted_version_needs_no_second_entry()
    {
        Assert.Equal("1.2.0", Catalogue(Stable()).For(Box(OtaChannel.Pinned, "1.2.0"))?.Version);
    }

    [Fact]
    public void A_pin_to_something_unpublished_offers_nothing_rather_than_something_else()
    {
        // Silently promoting a box whose pin cannot be honoured would defeat the pin at
        // exactly the moment it mattered.
        Assert.Null(Catalogue(Stable()).For(Box(OtaChannel.Pinned, "9.9.9")));
        Assert.Null(Catalogue(Stable()).For(Box(OtaChannel.Pinned, null)));
    }

    // ---- the baked payload (Phase 5b) -------------------------------------------

    [Fact]
    public void The_image_own_firmware_is_offered_when_nothing_is_configured()
    {
        // The ordinary deployment: CI signed the build, baked it beside its manifest,
        // and nobody set Ota:* — the firmware that ships with the API is the firmware
        // the fleet gets.
        BakeManifest("1.4.0", 402_176);

        var release = Catalogue().For(Box());
        Assert.NotNull(release);
        Assert.Equal("1.4.0", release!.Version);
        Assert.Equal(402_176, release.SizeBytes);
        Assert.EndsWith("/firmware/court_bridge.signed.bin", release.Url);
    }

    [Fact]
    public void Configuration_wins_over_the_baked_manifest()
    {
        // How a deployment pins the fleet to an image other than the one in its own
        // container: explicit configuration is never second to what happened to be baked.
        BakeManifest("1.4.0");
        Assert.Equal("1.2.0", Catalogue(Stable("1.2.0")).For(Box())?.Version);
    }

    [Fact]
    public void An_unsigned_payload_is_no_release()
    {
        // What the image holds when OTA_PRIVATE_KEY was unset: a README and nothing else.
        // Unchanged behaviour — nothing is offered — and nothing to warn about either,
        // because CI already did, loudly, when it wrote this file.
        File.WriteAllText(Path.Combine(_payloadDir, "README.txt"), "UNSIGNED BUILD — no firmware baked into this image.");

        Assert.Null(Catalogue().For(Box()));
        Assert.Empty(_log.Warnings);
    }

    [Theory]
    [InlineData("{\"version\":\"1.4.0\",\"url\":\"/firmware/court_bridge.signed.bin\"")]                 // truncated
    [InlineData("""{"version":"1.4.0","url":"/firmware/court_bridge.signed.bin","sizeBytes":0}""")]     // unusable
    [InlineData("""{"version":"","url":"/firmware/court_bridge.signed.bin","sizeBytes":12}""")]         // no version
    [InlineData("""["not","an","object"]""")]
    public void A_manifest_that_cannot_be_used_offers_nothing_and_is_logged(string manifest)
    {
        // A build that was signed, packaged and then silently never offered is the
        // failure nobody notices for a week; the log line is the difference between
        // "nothing published" and "something is wrong".
        File.WriteAllText(Path.Combine(_payloadDir, FirmwarePayload.ManifestFileName), manifest);

        Assert.Null(Catalogue().For(Box()));
        Assert.Contains(_log.Warnings, w => w.Contains("manifest", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void A_canary_box_falls_back_to_the_baked_stable_and_a_pin_to_it_resolves()
    {
        BakeManifest("1.4.0");

        Assert.Equal("1.4.0", Catalogue().For(Box(OtaChannel.Canary))?.Version);
        Assert.Equal("1.4.0", Catalogue().For(Box(OtaChannel.Pinned, "1.4.0"))?.Version);
        Assert.Null(Catalogue().For(Box(OtaChannel.Pinned, "1.3.9")));
    }

    // ---- the URL the box is handed ---------------------------------------------

    [Fact]
    public void A_relative_url_is_made_absolute_against_the_request_the_box_made()
    {
        // The firmware hands ota_url straight to ESPhttpUpdate, whose HTTPClient::begin
        // refuses anything without a scheme. The heartbeat that is asking arrived on an
        // address that works from where the box stands, so that is the base.
        BakeManifest();

        var release = Catalogue(RequestOn("192.168.1.20:8088")).For(Box());
        Assert.Equal("http://192.168.1.20:8088/firmware/court_bridge.signed.bin", release?.Url);
    }

    [Fact]
    public void An_advertised_base_url_wins_over_the_request()
    {
        // The same rule provisioning applies: a club that fronts the API with a name the
        // boards must use gets that name, whatever address the heartbeat came in on.
        BakeManifest();

        var release = Catalogue(RequestOn("192.168.1.20:8088"), ("Discovery:AdvertisedBaseUrl", "https://courts.club.example/"))
            .For(Box());
        Assert.Equal("https://courts.club.example/firmware/court_bridge.signed.bin", release?.Url);
    }

    [Fact]
    public void With_no_request_the_configured_public_base_is_the_last_resort()
    {
        BakeManifest();

        var release = Catalogue(("App:PublicBaseUrl", "http://localhost:8088")).For(Box());
        Assert.Equal("http://localhost:8088/firmware/court_bridge.signed.bin", release?.Url);
    }

    [Fact]
    public void A_relative_configured_url_is_resolved_the_same_way()
    {
        // .env.example documents Ota__Stable__Url as "relative to this API or absolute";
        // relative only works if somebody resolves it, and the box will not.
        var settings = new[]
        {
            ("Ota:Stable:Version", "1.2.0"),
            ("Ota:Stable:Url", "/firmware/court_bridge.signed.bin"),
            ("Ota:Stable:SizeBytes", "328192"),
        };

        var release = Catalogue(RequestOn("10.0.0.5:8088"), settings).For(Box());
        Assert.Equal("http://10.0.0.5:8088/firmware/court_bridge.signed.bin", release?.Url);
    }

    [Fact]
    public void An_absolute_url_is_passed_through_untouched()
    {
        var release = Catalogue(RequestOn("10.0.0.5:8088"), Stable()).For(Box());
        Assert.Equal("https://fw.example/1.2.0.bin", release?.Url);
    }

    // ---- scaffolding ------------------------------------------------------------

    private sealed class FakeEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Testing";
        public string ApplicationName { get; set; } = "Crusaders.Mainframe.Tests";
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class CapturingLogger : ILogger<OtaCatalogue>
    {
        public List<string> Warnings { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => NullLogger.Instance.BeginScope(state);
        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (logLevel >= LogLevel.Warning) Warnings.Add(formatter(state, exception));
        }
    }
}
