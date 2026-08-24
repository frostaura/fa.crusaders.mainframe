using Crusaders.Mainframe.Api.Domain;

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
/// Empty by default, deliberately. An instance with no configured release offers no
/// updates, which is the correct behaviour for one nobody has published firmware for
/// — the alternative, a default pointing somewhere, is how a box ends up fetching an
/// image from a URL nobody meant it to.
/// </para>
/// </summary>
public sealed class OtaCatalogue
{
    private readonly IConfiguration _config;

    public OtaCatalogue(IConfiguration config) => _config = config;

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

        var channel = device.OtaChannel == OtaChannel.Canary ? "Canary" : "Stable";
        var release = Read($"Ota:{channel}");

        // Canary falling back to Stable rather than to nothing: a deployment that has
        // not published a canary build should leave its canary boxes on the promoted
        // one, not strand them without updates.
        if (release is null && device.OtaChannel == OtaChannel.Canary) release = Read("Ota:Stable");
        return release;
    }

    /// <summary>A specific version by name, for a pinned device. Null when unpublished.</summary>
    public FirmwareRelease? Release(string version)
    {
        var release = Read($"Ota:Versions:{version}");
        if (release is not null) return release;

        // A pin naming the promoted version is the common case and should not need a
        // second entry in configuration.
        foreach (var channel in new[] { "Ota:Stable", "Ota:Canary" })
        {
            var candidate = Read(channel);
            if (candidate is not null && string.Equals(candidate.Version, version, StringComparison.Ordinal))
            {
                return candidate;
            }
        }
        return null;
    }

    private FirmwareRelease? Read(string section)
    {
        var version = _config[$"{section}:Version"];
        var url = _config[$"{section}:Url"];
        if (!long.TryParse(_config[$"{section}:SizeBytes"], out var size)) size = 0;

        var release = new FirmwareRelease(version ?? "", url ?? "", size);
        return release.Usable ? release : null;
    }
}
