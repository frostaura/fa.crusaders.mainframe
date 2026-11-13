namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// A club device key that is no longer the current one but may still be accepted
/// (device-api.md §6). A rotation moves the current key here and mints a new one; every row
/// with no <see cref="RetiredAt"/> still authenticates a board, which is what lets a board that
/// has not yet heard <c>key_next</c> keep calling in. Retiring stamps <see cref="RetiredAt"/>;
/// the row is kept so the console can say which key a board is still holding.
/// </summary>
/// <remarks>
/// The key is stored as the bearer token itself, exactly as <see cref="Tenant.DeviceApiKey"/>
/// is: a board presents it on every request in plain HTTP on the club LAN and the server has to
/// compare it in constant time. v3 changes how a key is replaced, not the threat model.
/// </remarks>
public sealed class DevicePreviousKey : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>The key's id number: this row is <c>k&lt;KeyId&gt;</c>.</summary>
    public int KeyId { get; set; }

    /// <summary>The bearer key.</summary>
    public required string Key { get; set; }

    /// <summary>When it stopped being the current key.</summary>
    public DateTimeOffset SupersededAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>When it stopped authenticating anything; null while it still does.</summary>
    public DateTimeOffset? RetiredAt { get; set; }

    /// <summary>Who retired it; <see cref="Guid.Empty"/> for the automatic retirement after the grace window.</summary>
    public Guid? RetiredByUserId { get; set; }
}

/// <summary>
/// The club's device network (device-api.md §8): up to two WiFi profiles and the server base URL
/// every board dials, versioned so a board can say which one it applied. One row per club.
/// </summary>
/// <remarks>
/// Passwords are write-only: stored encrypted (<see cref="Services.DeviceNetworkCipher"/>),
/// never returned by a read, never logged. They leave the server only inside the heartbeat's
/// <c>net</c> object, to an authenticated board of the same club, which is the one party that
/// needs them in the clear.
/// </remarks>
public sealed class DeviceNetwork : ITenantScoped
{
    public Guid TenantId { get; set; }

    /// <summary>Increments on every save; 0 is never a saved version (it is a board's compiled defaults).</summary>
    public int Version { get; set; }

    /// <summary><c>http://host[:port]</c>, or null to leave every board's base URL as it is.</summary>
    public string? BaseUrl { get; set; }

    public string? Wifi0Ssid { get; set; }
    public string? Wifi0PskCipher { get; set; }
    public string? Wifi1Ssid { get; set; }
    public string? Wifi1PskCipher { get; set; }

    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public Guid? UpdatedByUserId { get; set; }
}

/// <summary>
/// One signed firmware image the club may roll out to its ESP boards (device-api.md §7).
/// Accepted only after its RSA signature verified against the deployment's
/// <c>DeviceOta:PublicKeyModulus</c>, its size and SHA-256 matched the bytes uploaded, and its
/// version was newer than every release of the same target.
/// </summary>
public sealed class FirmwareRelease : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary><c>court_bridge</c> or <c>door_gate</c>.</summary>
    public required string Target { get; set; }

    /// <summary><c>major.minor.patch</c>, each part 0–999 without leading zeros.</summary>
    public required string Version { get; set; }

    public int Size { get; set; }

    /// <summary>Lowercase hex SHA-256 of <see cref="Image"/>.</summary>
    public required string Sha256 { get; set; }

    /// <summary>The 342-character base64url RSASSA-PKCS1-v1_5 signature over the manifest text.</summary>
    public required string Signature { get; set; }

    /// <summary>The image itself, served byte for byte by <c>GET /api/v1/device/firmware/{id}</c>.</summary>
    public required byte[] Image { get; set; }

    public Guid UploadedByUserId { get; set; }
    public DateTimeOffset UploadedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary><c>off</c>, <c>one</c> (only <see cref="RolloutDeviceId"/>) or <c>all</c> (every acknowledged board of the target).</summary>
    public string Rollout { get; set; } = FirmwareRollouts.Off;

    public Guid? RolloutDeviceId { get; set; }

    /// <summary>A paused rollout offers nothing, whatever <see cref="Rollout"/> says.</summary>
    public bool Paused { get; set; }

    /// <summary>The path a board GETs, relative to its own base URL (§7: an absolute URL is refused by the board).</summary>
    public string DevicePath => $"/api/v1/device/firmware/{Id:N}";
}

/// <summary>The three rollout modes of a <see cref="FirmwareRelease"/>.</summary>
public static class FirmwareRollouts
{
    public const string Off = "off";
    public const string One = "one";
    public const string All = "all";

    public static readonly string[] Values = [Off, One, All];
}
