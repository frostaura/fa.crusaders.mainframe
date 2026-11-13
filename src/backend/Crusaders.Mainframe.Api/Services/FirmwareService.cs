using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>The manifest <c>src/iot/tools/ota_sign.py</c> writes beside an image.</summary>
public sealed record FirmwareManifest(
    [property: JsonPropertyName("target")] string? Target,
    [property: JsonPropertyName("version")] string? Version,
    [property: JsonPropertyName("size")] long? Size,
    [property: JsonPropertyName("sha256")] string? Sha256,
    [property: JsonPropertyName("sig")] string? Sig);

/// <summary>The rollout PATCH: any field omitted is left as it is.</summary>
public sealed record FirmwareRolloutRequest(
    [property: JsonPropertyName("rollout")] string? Rollout,
    [property: JsonPropertyName("device_id")] Guid? DeviceId,
    [property: JsonPropertyName("paused")] bool? Paused);

/// <summary>
/// The deployment's OTA verification key (<c>DeviceOta:PublicKeyModulus</c>, hex), or null when
/// OTA is not configured — then every upload is refused and no board is ever offered anything.
/// </summary>
public sealed record DeviceOtaKey(byte[]? Modulus)
{
    public const string ConfigKey = "DeviceOta:PublicKeyModulus";

    /// <summary>
    /// The startup rule: a malformed modulus, and — outside Development — one of the corpus test
    /// keys, refuse to start. A deployment that signs with a key whose private half is in the
    /// repository has handed every board in the club to anyone who reads it.
    /// </summary>
    public static DeviceOtaKey Resolve(IConfiguration config, IHostEnvironment env)
    {
        var configured = config[ConfigKey];
        if (string.IsNullOrWhiteSpace(configured)) return new DeviceOtaKey((byte[]?)null);
        var modulus = DeviceOta.ParseModulus(configured)
            ?? throw new InvalidOperationException(
                $"{ConfigKey} is set but is not a 2048-bit RSA modulus in hex (512 hex digits). Fix it or remove it.");
        if (!env.IsDevelopment() && DeviceOta.IsCorpusTestKey(modulus))
        {
            throw new InvalidOperationException(
                $"{ConfigKey} is the device-protocol corpus TEST key, whose private half is in the repository. " +
                "Generate the club's own key pair with src/iot/tools/ota_sign.py keygen and configure its modulus.");
        }
        return new DeviceOtaKey(modulus);
    }
}

/// <summary>
/// Signed firmware releases and their rollout (device-api.md §7). An upload is accepted only when
/// the board would accept it: the signature verifies against the configured key over the manifest
/// built from the manifest's own fields, the size and SHA-256 are the uploaded bytes', the target is
/// one the contract knows, the image fits its target, and the version is newer than every release
/// of that target.
/// </summary>
public sealed class FirmwareService
{
    public const string OtaNotConfigured = "ota_not_configured";
    public const string ImageRequired = "image_required";
    public const string ManifestInvalid = "manifest_invalid";
    public const string TargetUnknown = "target_unknown";
    public const string VersionFormat = "version_format";
    public const string SizeMismatch = "size_mismatch";
    public const string SizeTooLarge = "size";
    public const string Sha256Mismatch = "sha256_mismatch";
    public const string SigInvalid = "sig_invalid";
    public const string VersionNotNewer = "version_not_newer";
    public const string RolloutInvalid = "rollout_invalid";
    public const string RolloutDeviceInvalid = "rollout_device_invalid";

    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly DeviceOtaKey _key;
    private readonly AdminChangeRecorder _changes;
    private readonly TimeProvider _clock;

    public FirmwareService(MainframeDbContext db, ITenantContext tenant, DeviceOtaKey key, AdminChangeRecorder changes, TimeProvider clock)
    {
        _db = db;
        _tenant = tenant;
        _key = key;
        _changes = changes;
        _clock = clock;
    }

    /// <summary>The refusal code for an upload, or null when <paramref name="image"/> and <paramref name="manifest"/> make a release a board would boot.</summary>
    public async Task<(FirmwareRelease? Release, string? Error)> UploadAsync(
        byte[]? image, FirmwareManifest? manifest, Guid actorUserId, CancellationToken ct)
    {
        if (Refusal(image, manifest) is { } refused) return (null, refused);
        var sha = Convert.ToHexStringLower(SHA256.HashData(image!));
        if (!string.Equals(sha, manifest!.Sha256, StringComparison.Ordinal)) return (null, Sha256Mismatch);

        var text = DeviceOta.ManifestText(manifest.Target!, manifest.Version!, image!.Length, sha);
        if (DeviceOta.Verify(text, manifest.Sig!, _key.Modulus!) != "ok") return (null, SigInvalid);

        var versions = await _db.FirmwareReleases.AsNoTracking()
            .Where(r => r.Target == manifest.Target)
            .Select(r => r.Version)
            .ToListAsync(ct);
        if (versions.Any(v => !DeviceOta.IsNewer(manifest.Version, v))) return (null, VersionNotNewer);

        var release = new FirmwareRelease
        {
            TenantId = _tenant.TenantId,
            Target = manifest.Target!,
            Version = manifest.Version!,
            Size = image.Length,
            Sha256 = sha,
            Signature = manifest.Sig!,
            Image = image,
            UploadedByUserId = actorUserId,
            UploadedAt = _clock.GetUtcNow(),
        };
        _db.FirmwareReleases.Add(release);
        await _changes.StageAsync(new AdminChange(
            Action: AdminChangeActions.FirmwareUploaded,
            ActorUserId: actorUserId,
            SubjectKind: AdminChangeSubjects.Device,
            SubjectId: release.Id,
            SubjectLabel: $"{TargetWords(release.Target)} {release.Version}",
            After: new { target = release.Target, version = release.Version, size = release.Size, sha256 = sha }), ct);
        await _db.SaveChangesAsync(ct);
        return (release, null);
    }

    /// <summary>The refusal decided from the request alone — configuration, presence, target, version and size — or null.</summary>
    private string? Refusal(byte[]? image, FirmwareManifest? manifest)
    {
        if (_key.Modulus is null) return OtaNotConfigured;
        if (image is null || image.Length == 0) return ImageRequired;
        if (manifest is null || manifest.Target is null || manifest.Version is null || manifest.Size is null
            || manifest.Sha256 is null || manifest.Sig is null)
        {
            return ManifestInvalid;
        }
        if (!DeviceOta.TargetMaxBytes.TryGetValue(manifest.Target, out var max)) return TargetUnknown;
        if (DeviceOta.VersionTuple(manifest.Version) is null) return VersionFormat;
        if (manifest.Size != image.Length) return SizeMismatch;
        return image.Length > max ? SizeTooLarge : null;
    }

    /// <summary>
    /// A target as the change record says it: the board, in words, never the wire code
    /// (<c>court_bridge</c> reached the console's change log raw).
    /// </summary>
    public static string TargetWords(string target) => target switch
    {
        DeviceOta.CourtBridge => "Court box bridge",
        DeviceOta.DoorGate => "Door gate",
        _ => "Board",
    };

    /// <summary><c>GET …/firmware</c>: every release, newest first, with its rollout and the boards of its target by state.</summary>
    public async Task<object> ListAsync(CancellationToken ct)
    {
        var releases = await _db.FirmwareReleases.AsNoTracking()
            .Select(r => new
            {
                r.Id,
                r.Target,
                r.Version,
                r.Size,
                r.Sha256,
                r.UploadedAt,
                r.UploadedByUserId,
                r.Rollout,
                r.RolloutDeviceId,
                r.Paused,
            })
            .ToListAsync(ct);
        var boards = (await _db.Devices.AsNoTracking().Where(d => d.Enabled).ToListAsync(ct))
            .Where(Endpoints.MemberCodeHeartbeat.Acknowledged).ToList();
        var names = await PersonNames.ForAsync(_db, releases.Select(r => (Guid?)r.UploadedByUserId), ct);

        return releases
            .OrderBy(r => r.Target, StringComparer.Ordinal)
            .ThenByDescending(r => DeviceOta.VersionTuple(r.Version))
            .Select(r =>
            {
                var ofTarget = boards.Where(d => DeviceOta.TargetOf(d.Kind) == r.Target).ToList();
                var included = r.Rollout == FirmwareRollouts.All
                    ? ofTarget
                    : ofTarget.Where(d => r.Rollout == FirmwareRollouts.One && d.Id == r.RolloutDeviceId).ToList();
                return new
                {
                    id = r.Id,
                    target = r.Target,
                    version = r.Version,
                    size = r.Size,
                    sha256 = r.Sha256,
                    uploaded_at = r.UploadedAt,
                    uploaded_by = PersonNames.Of(r.UploadedByUserId, names),
                    rollout = r.Rollout,
                    rollout_device_id = r.RolloutDeviceId,
                    paused = r.Paused,
                    boards = new
                    {
                        of_target = ofTarget.Count,
                        included = included.Count,
                        running = ofTarget.Count(d => d.RunningVersion == r.Version),
                        downloading = included.Count(d => d.FwState == "downloading"),
                        probation = ofTarget.Count(d => d.RunningVersion == r.Version && d.FwState == "probation"),
                        failed = ofTarget.Count(d => d.FwFailedVersions.Contains(r.Version)),
                        cannot_update = ofTarget.Count(d => !DeviceCaps.Has(d, DeviceCaps.Ota1)),
                    },
                };
            })
            .ToList();
    }

    /// <summary><c>PATCH …/firmware/{id}</c>: the rollout mode, its one board, and pause. Null error on success.</summary>
    public async Task<(bool Found, string? Error)> SetRolloutAsync(Guid id, FirmwareRolloutRequest req, Guid actorUserId, CancellationToken ct)
    {
        var release = await _db.FirmwareReleases.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (release is null) return (false, null);

        var rollout = req.Rollout ?? release.Rollout;
        if (!FirmwareRollouts.Values.Contains(rollout)) return (true, RolloutInvalid);

        var deviceId = req.DeviceId ?? release.RolloutDeviceId;
        if (rollout == FirmwareRollouts.One)
        {
            var board = deviceId is { } d ? await _db.Devices.AsNoTracking().FirstOrDefaultAsync(x => x.Id == d, ct) : null;
            if (board is null || !Endpoints.MemberCodeHeartbeat.Acknowledged(board) || DeviceOta.TargetOf(board.Kind) != release.Target)
            {
                return (true, RolloutDeviceInvalid);
            }
        }

        var before = new { rollout = release.Rollout, device_id = release.RolloutDeviceId, paused = release.Paused };
        release.Rollout = rollout;
        release.RolloutDeviceId = rollout == FirmwareRollouts.One ? deviceId : null;
        release.Paused = req.Paused ?? release.Paused;
        await _changes.StageAsync(new AdminChange(
            Action: AdminChangeActions.FirmwareRolloutChanged,
            ActorUserId: actorUserId,
            SubjectKind: AdminChangeSubjects.Device,
            SubjectId: release.Id,
            SubjectLabel: $"{TargetWords(release.Target)} {release.Version}",
            Before: before,
            After: new { rollout = release.Rollout, device_id = release.RolloutDeviceId, paused = release.Paused }), ct);
        await _db.SaveChangesAsync(ct);
        return (true, null);
    }

    /// <summary>
    /// The heartbeat's <c>ota</c> offer for this board, or null (§7): an <c>ota:1</c>, acknowledged
    /// board the newest unpaused rollout of its own target includes, whose running version is older
    /// and which has never reported that version as failed.
    /// </summary>
    public async Task<JsonObject?> OfferForAsync(Device device, CancellationToken ct)
    {
        if (!DeviceCaps.Has(device, DeviceCaps.Ota1) || !Endpoints.MemberCodeHeartbeat.Acknowledged(device)) return null;
        var target = DeviceOta.TargetOf(device.Kind);
        var candidates = await _db.FirmwareReleases.AsNoTracking()
            .Where(r => r.Target == target && !r.Paused
                        && (r.Rollout == FirmwareRollouts.All || (r.Rollout == FirmwareRollouts.One && r.RolloutDeviceId == device.Id)))
            .Select(r => new { r.Id, r.Target, r.Version, r.Size, r.Sha256, r.Signature })
            .ToListAsync(ct);

        var best = candidates
            .Where(r => DeviceOta.IsNewer(r.Version, device.RunningVersion) && !device.FwFailedVersions.Contains(r.Version))
            .OrderByDescending(r => DeviceOta.VersionTuple(r.Version))
            .FirstOrDefault();
        if (best is null) return null;

        return OfferObject(best.Target, best.Version, best.Size, best.Sha256, best.Signature, $"/api/v1/device/firmware/{best.Id:N}");
    }

    /// <summary>The <c>ota</c> object in the wire's key order.</summary>
    public static JsonObject OfferObject(string target, string version, long size, string sha256, string sig, string path)
    {
        return new JsonObject
        {
            ["target"] = target,
            ["version"] = version,
            ["size"] = size,
            ["sha256"] = sha256,
            ["sig"] = sig,
            ["path"] = path,
        };
    }

    /// <summary>The image a board of this club downloads, or null — another club's id is not found, not forbidden.</summary>
    public async Task<byte[]?> ImageAsync(string id, CancellationToken ct)
    {
        if (!Guid.TryParseExact(id, "N", out var guid)) return null;
        return await _db.FirmwareReleases.AsNoTracking().Where(r => r.Id == guid).Select(r => r.Image).FirstOrDefaultAsync(ct);
    }

    /// <summary>The manifest JSON an upload carries, or null when it is not one.</summary>
    public static FirmwareManifest? ParseManifest(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            return JsonSerializer.Deserialize<FirmwareManifest>(json);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
