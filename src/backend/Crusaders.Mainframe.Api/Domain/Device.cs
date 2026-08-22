namespace Crusaders.Mainframe.Api.Domain;

public enum DeviceKind
{
    /// <summary>The court-control panel: relays, LCD, keypad, QR scanner.</summary>
    CourtBox = 0,

    /// <summary>A door/gate controller. Modelled now, not built — the hardware is undecided.</summary>
    Gate = 1,
}

public enum DeviceHardware
{
    /// <summary>ATmega2560 — thin I/O layer, USB-flashed.</summary>
    Mega2560 = 0,

    /// <summary>ESP8266 — the court box's brain, OTA-updatable.</summary>
    Esp8266 = 1,

    /// <summary>ESP32 — gate controllers.</summary>
    Esp32 = 2,
}

public enum OtaChannel
{
    /// <summary>Follows the promoted stable version.</summary>
    Stable = 0,

    /// <summary>Takes new versions first, so one box can be watched before the rest follow.</summary>
    Canary = 1,

    /// <summary>Held at <see cref="Device.PinnedVersion"/> regardless of what is promoted.</summary>
    Pinned = 2,
}

/// <summary>
/// A physical device authorised to talk to this tenant's API.
///
/// <para>
/// This exists because the courtside endpoints previously required
/// <c>RequireRole("admin")</c> on a 15-minute token. Shipping the court box under
/// that scheme would have meant baking an admin JWT into a board in an unlocked
/// electrical cupboard — and it would have gone permanently dead a quarter of an
/// hour after its last refresh.
/// </para>
///
/// <para>
/// No secret is stored here. The per-device key is derived on demand from a master
/// KEK, the tenant id, the device id and <see cref="KeyVersion"/>, so rotation is a
/// version bump and there is no credential in the database to leak. See
/// <c>DeviceKeyDeriver</c>.
/// </para>
/// </summary>
public sealed class Device : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>Short human-readable identifier, unique within the tenant — e.g. "court-box-1".</summary>
    public required string DeviceCode { get; set; }

    public required string Name { get; set; }
    public DeviceKind Kind { get; set; } = DeviceKind.CourtBox;
    public DeviceHardware Hardware { get; set; } = DeviceHardware.Esp8266;

    /// <summary>Which court this box drives, for a <see cref="DeviceKind.CourtBox"/>. Null for gates.</summary>
    public int? CourtNumber { get; set; }

    /// <summary>Which gate this controller opens, for a <see cref="DeviceKind.Gate"/>. Null for court boxes.</summary>
    public string? GateKey { get; set; }

    /// <summary>
    /// Bumped to rotate the derived key. The device is re-provisioned with the new
    /// version; the old key stops verifying immediately.
    /// </summary>
    public int KeyVersion { get; set; } = 1;

    /// <summary>Last address the device called from. Observability only — never an authorisation input.</summary>
    public string? LastIpAddress { get; set; }

    public bool Enabled { get; set; } = true;

    /// <summary>Set when the device is decommissioned. A revoked device authenticates as nothing.</summary>
    public DateTimeOffset? RevokedAt { get; set; }

    public DateTimeOffset? LastSeenAt { get; set; }

    /// <summary>Firmware version last reported by heartbeat. Null until it first checks in.</summary>
    public string? RunningVersion { get; set; }

    /// <summary>
    /// For a court box, the version of the ATmega firmware behind the ESP. Tracked
    /// separately because the Mega is USB-flashed and can lag the OTA-updated ESP.
    /// </summary>
    public string? MegaVersion { get; set; }

    public OtaChannel OtaChannel { get; set; } = OtaChannel.Stable;
    public string? PinnedVersion { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>A device may authenticate only while enabled and unrevoked.</summary>
    public bool IsActive => Enabled && RevokedAt is null;
}
