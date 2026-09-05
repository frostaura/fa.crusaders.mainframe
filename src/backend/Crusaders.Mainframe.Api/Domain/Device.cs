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

    /// <summary>ESP8266 — the court box's brain.</summary>
    Esp8266 = 1,

    /// <summary>ESP32 — gate controllers.</summary>
    Esp32 = 2,
}

/// <summary>
/// A physical device that has talked to this tenant's API.
///
/// <para>
/// <b>This row is a record, not a credential.</b> Authentication is the club's single
/// <see cref="Tenant.DeviceApiKey"/>, presented as a bearer token; a row here says only
/// "a board with this MAC belongs to this club, drives these courts and last called at
/// this time". Nothing about it is checked before a request is authorised, which is why
/// there is no key, no key version and no revocation state on it any more — revoking a
/// row could not have stopped a board that still held the club key, so it was a control
/// that read as one and was not.
/// </para>
///
/// <para>
/// Rows are created by the box itself: an unknown MAC on a heartbeat auto-registers (see
/// <c>DeviceRegistryService.AutoRegisterAsync</c>). Deleting a row is therefore not
/// destructive — the board re-registers on its next heartbeat, with default courts — and
/// that is the intended way to reset a box an admin has misconfigured.
/// </para>
/// </summary>
public sealed class Device : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>
    /// Short human-readable identifier, unique within the tenant. Auto-registration writes
    /// <c>box-&lt;last six hex of the MAC&gt;</c>; an admin may rename it.
    /// </summary>
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
    /// The board's MAC address, lowercase hex without separators, as it announces itself
    /// in every device request body.
    ///
    /// <para>
    /// This is the whole of a device's identity. The club key says which club is calling;
    /// the MAC says which board. It is required rather than nullable because there is no
    /// longer any way to create a row without one — every row is created by a heartbeat
    /// that carried a MAC.
    /// </para>
    /// </summary>
    public required string MacAddress { get; set; }

    /// <summary>Last address the device called from. Observability only — never an authorisation input.</summary>
    public string? LastIpAddress { get; set; }

    public bool Enabled { get; set; } = true;

    public DateTimeOffset? LastSeenAt { get; set; }

    /// <summary>Firmware version last reported by heartbeat. Null until it first checks in.</summary>
    public string? RunningVersion { get; set; }

    /// <summary>
    /// For a court box, the version of the ATmega firmware behind the ESP. Tracked
    /// separately because the Mega is USB-flashed and can lag the ESP.
    /// </summary>
    public string? MegaVersion { get; set; }

    /// <summary>
    /// True while this row is still exactly as auto-registration left it — nobody has
    /// confirmed the courts it was given or the name it was called.
    ///
    /// <para>
    /// It is surfaced on the Devices page so a box that appeared by itself reads as
    /// "check me" rather than as configuration somebody chose. The first admin edit
    /// clears it; deleting the row and letting the box re-register sets it again.
    /// </para>
    /// </summary>
    public bool AutoRegistered { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>A device may act only while enabled.</summary>
    public bool IsActive => Enabled;
}
