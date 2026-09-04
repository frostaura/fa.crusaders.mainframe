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

    /// <summary>
    /// The courts this box drives, for a <see cref="DeviceKind.CourtBox"/>. Empty for gates.
    ///
    /// <para>
    /// <b>The list order is the relay mapping.</b> Index 0 is relay A, index 1 relay B,
    /// index 2 relay C, index 3 relay D. The wiring is fixed — relays A–D are screwed
    /// to pins 2–5 in a cupboard — and it is the list that adapts to it: a box wired to
    /// courts 3 and 4 on relays A and B carries <c>[3, 4]</c>, and a
    /// <c>ButtonAction.SelectCourt(1)</c> on the tenant's button map means "the second
    /// entry here", whatever court number that happens to be.
    /// </para>
    ///
    /// <para>
    /// A list rather than the single <c>CourtNumber</c> this replaced because one
    /// physical box has one scanner and four relays (review C4): the per-court model
    /// could structurally light at most one court at the club's only scanner, and
    /// members booked on the other three were refused as WrongCourt.
    /// </para>
    /// </summary>
    public List<int> CourtNumbers { get; set; } = [];

    /// <summary>Which gate this controller opens, for a <see cref="DeviceKind.Gate"/>. Null for court boxes.</summary>
    public string? GateKey { get; set; }

    /// <summary>
    /// This box's own button map, as the eight-entry wire array (<c>ButtonMap.ToWire()</c>)
    /// serialised to JSON — or null to use the club's map from <c>tenant_settings</c>.
    ///
    /// <para>
    /// The map used to be tenant-wide only, and validated against every box's court count
    /// at both save points, so a club with a four-court box and a one-court annex box had
    /// no valid configuration at all: a map the annex could honour left three buttons on
    /// the main box inert, and the default map refused to register the annex (closing
    /// re-review #17). The invariant "a court button selects a wired court" is a property
    /// of one box, so it is held per box: the EFFECTIVE map — this override, else the
    /// tenant's — is what a device save is checked against, what the tenant-map save
    /// checks only for boxes with no override, and what the heartbeat sends.
    /// </para>
    /// </summary>
    public string? ButtonMapJson { get; set; }

    /// <summary>
    /// The board's MAC address, lowercase hex without separators, as it announces itself.
    /// Null for a device registered by hand rather than discovered.
    ///
    /// <para>
    /// This is the only stable link between a physical board and its row. A board that has
    /// been reflashed, or whose key was lost, announces <c>st=unclaimed</c> with no device
    /// id — so without a MAC the API cannot tell it apart from a brand-new board, and an
    /// admin reconnecting it silently creates a <i>second</i> row for the same hardware.
    /// Both rows then derive working keys, both look legitimate, and the court has two
    /// identities. Recognising the MAC turns that into "this board is already registered
    /// as court-box-1 — rotate its key" instead.
    /// </para>
    /// </summary>
    public string? MacAddress { get; set; }

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

    /// <summary>
    /// A version this box installed, rebooted through its allowance, and never once
    /// managed a successful call on. Reported by the box itself, because the box is
    /// the only thing that can know it.
    ///
    /// <para>
    /// It is here so a human finds out. The firmware's own guard already refuses to
    /// reinstall the build — that is what stops a whole club reflashing in a loop —
    /// but a fleet quietly declining an update is exactly the kind of silence that
    /// gets noticed a week later, by which time the release has been promoted
    /// everywhere.
    /// </para>
    /// </summary>
    public string? FailedVersion { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>A device may authenticate only while enabled and unrevoked.</summary>
    public bool IsActive => Enabled && RevokedAt is null;
}
