using System.Text.Json;
using System.Text.Json.Serialization;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The court-box firmware baked into this image.
///
/// <para>
/// CI's <c>iot-sign</c> job fills <c>firmware-payload/</c> with either
/// <c>court_bridge.signed.bin</c> + <c>firmware.manifest.json</c>
/// (<c>{"version","url","sizeBytes"}</c>) or a <c>README.txt</c> saying the build was
/// unsigned, and the Dockerfile copies whichever it was to <c>/app/firmware/</c>. This
/// class is the one place that decides where that directory is — <c>Program.cs</c>
/// serves it at <see cref="RequestPath"/> and <see cref="OtaCatalogue"/> reads the
/// manifest out of it — so the two cannot disagree about which directory "the payload"
/// means.
/// </para>
///
/// <para>
/// A README-only payload has no manifest and reads as no release, which is the same
/// answer an instance with no configuration gives: nothing is offered to the fleet. A
/// manifest that is present but unreadable is also no release, but it is logged, because
/// a build that was signed and packaged and then silently never offered is the failure
/// nobody would notice for a week.
/// </para>
/// </summary>
public sealed class FirmwarePayload
{
    /// <summary>Configuration key naming the payload directory. Relative paths resolve against the content root.</summary>
    public const string PathKey = "Firmware:PayloadPath";

    /// <summary>Where the Dockerfile puts it (<c>COPY firmware-payload/ /app/firmware/</c>).</summary>
    public const string ContainerPath = "/app/firmware";

    /// <summary>The URL prefix the payload is served under; what the manifest's relative <c>url</c> is relative to.</summary>
    public const string RequestPath = "/firmware";

    public const string ManifestFileName = "firmware.manifest.json";

    private readonly ILogger _logger;
    private readonly object _gate = new();
    private (DateTime WrittenAt, long Length)? _seen;
    private FirmwareRelease? _cached;

    public FirmwarePayload(string directory, ILogger logger)
    {
        Directory = directory;
        _logger = logger;
    }

    /// <summary>The resolved payload directory. May not exist.</summary>
    public string Directory { get; }

    /// <summary>
    /// The payload directory: <see cref="PathKey"/> when set, else <see cref="ContainerPath"/>
    /// when it exists (the image), else the repository's <c>firmware-payload/</c> three
    /// levels above the API project's content root (a developer checkout). Local dev
    /// therefore sees the same placeholder README the image would, without configuration.
    /// </summary>
    public static string ResolvePath(IConfiguration config, string contentRoot)
    {
        var configured = config[PathKey];
        if (!string.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured, contentRoot);
        if (System.IO.Directory.Exists(ContainerPath)) return ContainerPath;
        return Path.GetFullPath(Path.Combine(contentRoot, "..", "..", "..", "firmware-payload"));
    }

    /// <summary>
    /// The release the manifest describes, or null when there is no manifest or it cannot
    /// be used. The <c>url</c> is returned as written — relative to <see cref="RequestPath"/>
    /// — and it is the catalogue's job to make it absolute for the box.
    ///
    /// <para>
    /// Re-parsed only when the file's timestamp or length changes. The heartbeat calls this
    /// once a minute per box, and the file changes once per image, so this is mostly a
    /// stat; it also means a malformed manifest is logged once per change rather than once
    /// per heartbeat per box.
    /// </para>
    /// </summary>
    public FirmwareRelease? Manifest()
    {
        var info = new FileInfo(Path.Combine(Directory, ManifestFileName));
        if (!info.Exists)
        {
            lock (_gate) { _seen = null; _cached = null; }
            return null;
        }

        var stamp = (info.LastWriteTimeUtc, info.Length);
        lock (_gate)
        {
            if (_seen == stamp) return _cached;
            _cached = Parse(info.FullName);
            _seen = stamp;
            return _cached;
        }
    }

    private FirmwareRelease? Parse(string path)
    {
        ManifestDocument? doc;
        try
        {
            using var stream = File.OpenRead(path);
            doc = JsonSerializer.Deserialize<ManifestDocument>(stream, ManifestJson);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Firmware manifest {Path} could not be read; no baked release will be offered.", path);
            return null;
        }

        var release = new FirmwareRelease(doc?.Version ?? "", doc?.Url ?? "", doc?.SizeBytes ?? 0);
        if (release.Usable) return release;

        _logger.LogWarning(
            "Firmware manifest {Path} is missing version, url or a positive sizeBytes; no baked release will be offered.", path);
        return null;
    }

    private static readonly JsonSerializerOptions ManifestJson = new() { PropertyNameCaseInsensitive = true };

    private sealed record ManifestDocument(
        [property: JsonPropertyName("version")] string? Version,
        [property: JsonPropertyName("url")] string? Url,
        [property: JsonPropertyName("sizeBytes")] long? SizeBytes);
}
