using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Security.Discovery;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>One firmware image the fleet can be offered.</summary>
public sealed record FirmwareRelease(string Version, string Url, long SizeBytes)
{
    /// <summary>An entry missing any of its three fields cannot be installed, so it is
    /// treated as no release at all rather than offered and refused by every box.</summary>
    public bool Usable => !string.IsNullOrWhiteSpace(Version)
        && !string.IsNullOrWhiteSpace(Url)
        && SizeBytes > 0;
}

/// <summary>
/// What firmware each channel currently points at.
///
/// <para>
/// <b>Deployment configuration, not a tenant setting.</b> A firmware build is a
/// property of this deployment of the product, not of a squash club — every tenant
/// on an instance runs the same images, and asking each club to maintain its own
/// release catalogue would mean a fix reaching some clubs and not others depending
/// on who edited a JSON blob. Per-club and per-box control is where it belongs
/// instead: <see cref="Device.OtaChannel"/> and <see cref="Device.PinnedVersion"/>.
/// </para>
///
/// <para>
/// Empty by default, deliberately. An instance with no configured release and no
/// firmware baked into its image offers no updates, which is the correct behaviour
/// for one nobody has published firmware for — the alternative, a default pointing
/// somewhere, is how a box ends up fetching an image from a URL nobody meant it to.
/// </para>
///
/// <para>
/// <b>Stable falls back to the image's own payload.</b> CI signs the court-box build
/// and bakes it into this image beside a manifest (<see cref="FirmwarePayload"/>), so
/// the ordinary deployment needs no <c>Ota:*</c> configuration at all: the firmware
/// that ships with the API is the firmware the fleet is offered. Explicit
/// <c>Ota:Stable:*</c> configuration still wins, which is how a deployment pins the
/// fleet to an image other than the one in its own container. Canary and pinned
/// semantics are unchanged; a pin naming the baked version resolves to it.
/// </para>
///
/// <para>
/// <b>URLs handed to a box are absolute.</b> The firmware passes <c>ota_url</c> straight
/// to <c>ESPhttpUpdate.update(client, url)</c>, and the ESP8266 core's
/// <c>HTTPClient::begin</c> refuses a URL with no scheme before a byte leaves the board —
/// a relative <c>/firmware/...</c>, which is what the manifest carries and what
/// <c>.env.example</c> shows for <c>Ota__Stable__Url</c>, would fail every update with
/// "UPDATE FAILED" on the display. So a relative URL is resolved here against the base
/// the box already reaches this API on, in the same order provisioning hands one out:
/// <c>Discovery:AdvertisedBaseUrl</c> when set, else the scheme and host of the current
/// request (the heartbeat that is asking — by construction an address that works from
/// where the box stands), else <c>App:PublicBaseUrl</c>. An absolute URL is passed through.
/// </para>
/// </summary>
public sealed class OtaCatalogue
{
    private readonly IConfiguration _config;
    private readonly FirmwarePayload _payload;
    private readonly DiscoveryOptions _discovery;
    private readonly IHttpContextAccessor? _http;

    /// <param name="http">
    /// Optional so the catalogue still constructs where no accessor is registered; without
    /// one, relative URLs fall back to the configured bases only.
    /// </param>
    public OtaCatalogue(
        IConfiguration config,
        IHostEnvironment env,
        ILogger<OtaCatalogue> logger,
        DiscoveryOptions discovery,
        IHttpContextAccessor? http = null)
    {
        _config = config;
        _payload = new FirmwarePayload(FirmwarePayload.ResolvePath(config, env.ContentRootPath), logger);
        _discovery = discovery;
        _http = http;
    }

    /// <summary>
    /// What <paramref name="device"/> should be running, or null if nothing is
    /// published for it.
    ///
    /// <para>
    /// A pinned box is held at its pinned version even when that version is not the
    /// promoted one — including when it is OLDER. That is the point of pinning: a
    /// club that has one court on a build they trust while a regression is
    /// investigated must not have it dragged forward by the next heartbeat.
    /// </para>
    /// </summary>
    public FirmwareRelease? For(Device device)
    {
        if (device.OtaChannel == OtaChannel.Pinned)
        {
            return string.IsNullOrWhiteSpace(device.PinnedVersion) ? null : Release(device.PinnedVersion);
        }

        var release = device.OtaChannel == OtaChannel.Canary ? Read("Ota:Canary") : Stable();

        // Canary falling back to Stable rather than to nothing: a deployment that has
        // not published a canary build should leave its canary boxes on the promoted
        // one, not strand them without updates.
        if (release is null && device.OtaChannel == OtaChannel.Canary) release = Stable();
        return Absolute(release);
    }

    /// <summary>A specific version by name, for a pinned device. Null when unpublished.</summary>
    public FirmwareRelease? Release(string version)
    {
        var release = Read($"Ota:Versions:{version}");
        if (release is not null) return Absolute(release);

        // A pin naming the promoted version is the common case and should not need a
        // second entry in configuration.
        foreach (var candidate in new[] { Stable(), Read("Ota:Canary") })
        {
            if (candidate is not null && string.Equals(candidate.Version, version, StringComparison.Ordinal))
            {
                return Absolute(candidate);
            }
        }
        return null;
    }

    /// <summary>The promoted release: configuration when it is complete, else the image's baked manifest.</summary>
    private FirmwareRelease? Stable() => Read("Ota:Stable") ?? _payload.Manifest();

    private FirmwareRelease? Read(string section)
    {
        var version = _config[$"{section}:Version"];
        var url = _config[$"{section}:Url"];
        if (!long.TryParse(_config[$"{section}:SizeBytes"], out var size)) size = 0;

        var release = new FirmwareRelease(version ?? "", url ?? "", size);
        return release.Usable ? release : null;
    }

    /// <summary>A release whose URL the box can actually open — see the class remarks.</summary>
    private FirmwareRelease? Absolute(FirmwareRelease? release)
    {
        if (release is null || !release.Url.StartsWith('/') || release.Url.StartsWith("//", StringComparison.Ordinal))
        {
            return release;
        }

        var baseUrl = BaseUrl();
        return baseUrl is null ? release : release with { Url = baseUrl.TrimEnd('/') + release.Url };
    }

    /// <summary>The base a board reaches this API on, in the order provisioning uses.</summary>
    private string? BaseUrl()
    {
        if (!string.IsNullOrWhiteSpace(_discovery.AdvertisedBaseUrl)) return _discovery.AdvertisedBaseUrl;

        var request = _http?.HttpContext?.Request;
        if (request is not null && request.Host.HasValue) return $"{request.Scheme}://{request.Host}";

        return string.IsNullOrWhiteSpace(_discovery.FallbackBaseUrl) ? null : _discovery.FallbackBaseUrl;
    }
}
