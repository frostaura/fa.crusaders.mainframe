using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Registration, rotation and revocation of physical devices.
///
/// <para>
/// The logic lives here rather than inside endpoint lambdas so it can be exercised
/// without an HTTP client, and so each operation is a named method a reviewer can read
/// in one screen. Every mutation writes an <see cref="AuditLog"/> row in the same
/// <c>SaveChanges</c> as the change itself: a device that was registered, rotated or
/// revoked without a matching audit row would break the
/// <c>{actor, subject}</c> guarantee the rest of the system relies on.
/// </para>
/// </summary>
public sealed class DeviceRegistryService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly IDeviceKeyDeriver _keys;
    private readonly TenantSettingsAccessor _settings;

    public DeviceRegistryService(MainframeDbContext db, ITenantContext tenant, IDeviceKeyDeriver keys, TenantSettingsAccessor settings)
    {
        _db = db;
        _tenant = tenant;
        _keys = keys;
        _settings = settings;
    }

    /// <summary>
    /// The shape a court box's court list must have, or the error code an admin is shown.
    ///
    /// <para>
    /// One to four entries, no repeats. Four because the relay bank has four relays and
    /// the list's order is the relay mapping (see <see cref="Device.CourtNumbers"/>); no
    /// repeats because two relays wired to one court is a wiring fault, not a
    /// configuration. Shared by manual registration, update and the discovery claim so
    /// the three paths cannot disagree about what a valid box is.
    /// </para>
    /// </summary>
    public static string? ValidateCourtNumbers(IReadOnlyList<int>? courtNumbers)
    {
        if (courtNumbers is null || courtNumbers.Count == 0) return "court_numbers_required_for_court_box";
        if (courtNumbers.Count > ButtonMap.MaxCourtsPerBox) return "too_many_courts_for_relay_bank";
        if (courtNumbers.Distinct().Count() != courtNumbers.Count) return "duplicate_court_numbers";
        return null;
    }

    /// <summary>Error code when a court list names a court the tenant does not have.</summary>
    public const string CourtNumberNotFound = "court_number_not_found";

    /// <summary>
    /// Whether the map this box would run has a court button the list cannot honour —
    /// <see cref="ButtonMap.SelectsCourtBeyondDeviceCourts"/> if so — or whether the list
    /// names a court the club does not have (<see cref="CourtNumberNotFound"/>); null when
    /// the assignment is sound.
    ///
    /// <para>
    /// The map checked is the EFFECTIVE one: <paramref name="buttonMap"/> when the caller is
    /// setting an override for this box, else the box's stored override, else the club's.
    /// The other half of the rule lives in the settings PUT, which checks a new tenant map
    /// only against boxes that have no override of their own.
    /// </para>
    ///
    /// <para>
    /// Court numbers are checked against the courts table because nothing else ever did:
    /// a typo registered a relay that could never light and nothing reported it. Inactive
    /// courts are still legal — a box is wired where it is wired, and deactivating a court
    /// must not orphan the box that drives it.
    /// </para>
    /// </summary>
    public async Task<string?> CourtAssignmentErrorAsync(
        IReadOnlyList<int> courtNumbers, ButtonMap? buttonMap, string? storedOverrideJson, CancellationToken ct)
    {
        var known = await _db.Courts.AsNoTracking()
            .Where(c => courtNumbers.Contains(c.CourtNumber))
            .Select(c => c.CourtNumber)
            .ToListAsync(ct);
        if (courtNumbers.Any(n => !known.Contains(n))) return CourtNumberNotFound;

        var settings = await _settings.GetAsync(ct);
        var effective = buttonMap ?? ButtonMap.EffectiveFor(storedOverrideJson, settings.Buttons);
        return effective.FirstSelectionBeyond(courtNumbers.Count) is null
            ? null
            : ButtonMap.SelectsCourtBeyondDeviceCourts;
    }

    /// <summary>The check for a box with no override of its own: the club's map against this list.</summary>
    public Task<string?> CourtAssignmentErrorAsync(IReadOnlyList<int> courtNumbers, CancellationToken ct)
        => CourtAssignmentErrorAsync(courtNumbers, null, null, ct);

    public Task<List<Device>> ListAsync(CancellationToken ct) =>
        _db.Devices.OrderBy(d => d.Kind).ThenBy(d => d.DeviceCode).ToListAsync(ct);

    public Task<Device?> FindAsync(Guid id, CancellationToken ct) =>
        _db.Devices.FirstOrDefaultAsync(d => d.Id == id, ct);

    /// <summary>
    /// Registers a device and returns it together with its key — the only time the key
    /// is ever available, since nothing per-device is stored.
    /// </summary>
    public async Task<DeviceRegistration> RegisterAsync(RegisterDeviceCommand cmd, Guid actorUserId, CancellationToken ct)
    {
        var device = new Device
        {
            TenantId = _tenant.TenantId,
            DeviceCode = cmd.DeviceCode.Trim(),
            Name = cmd.Name.Trim(),
            Kind = cmd.Kind,
            Hardware = cmd.Hardware,
            CourtNumbers = cmd.CourtNumbers?.ToList() ?? [],
            GateKey = cmd.GateKey?.Trim(),
            MacAddress = cmd.MacAddress?.Trim().ToLowerInvariant(),
            ButtonMapJson = cmd.ButtonMap?.ToJson(),
        };

        _db.Devices.Add(device);
        Audit(actorUserId, "device.registered", new
        {
            device_id = device.Id,
            device_code = device.DeviceCode,
            kind = device.Kind.ToString(),
        });
        await _db.SaveChangesAsync(ct);

        return new DeviceRegistration(device, KeyFor(device));
    }

    /// <summary>
    /// Bumps the key version. The previous key stops verifying immediately, so the
    /// device is offline until re-provisioned — deliberately, since a rotation that
    /// left the old key working would not be a rotation.
    ///
    /// <para>
    /// How the board gets the new key: it cannot be pushed (the API never dials a board)
    /// and it cannot be granted here (a provisioning grant is redeemed with the claim code
    /// the board shows, and a provisioned board shows none). So the board's own recovery
    /// path is the delivery: its next signed call is a 401, it drops to CLAIM CODE, and the
    /// admin connects it again — <see cref="ReclaimAsync"/> re-keys this same row and
    /// issues the grant. The key is still returned here for the record and the panel.
    /// </para>
    /// </summary>
    public async Task<DeviceRegistration> RotateKeyAsync(Device device, Guid actorUserId, CancellationToken ct)
    {
        device.KeyVersion++;
        Audit(actorUserId, "device.key_rotated", new { device_id = device.Id, key_version = device.KeyVersion });
        await _db.SaveChangesAsync(ct);

        return new DeviceRegistration(device, KeyFor(device));
    }

    /// <summary>
    /// The same physical board, claimed again: the row is re-keyed and un-revoked rather
    /// than duplicated or refused.
    ///
    /// <para>
    /// A board that was reflashed, revoked, or that lost its key announces
    /// <c>st=unclaimed</c> with a fresh claim code, indistinguishable from a new board
    /// except by its MAC. The old answer to a MAC match was a refusal ("rotate that
    /// device's key") — and revoking left <c>RevokedAt</c> set for ever, nothing could
    /// clear it, and rotation issued no grant, so a box an admin had revoked was
    /// permanently unregistrable from any product surface (closing re-review #9/#10).
    /// The honest design is that the board's claim code, read off its own LCD, is proof
    /// of physical presence: whoever can present it could reflash the board anyway. So
    /// a claim against a MAC this club already owns re-keys that row — a bumped
    /// <see cref="Device.KeyVersion"/>, <see cref="Device.RevokedAt"/> cleared, enabled —
    /// takes the claim's name, courts and override, keeps its id and history, and is
    /// audited as <c>device.reclaimed</c>. One board, one row, always.
    /// </para>
    /// </summary>
    public async Task<DeviceRegistration> ReclaimAsync(Device device, RegisterDeviceCommand cmd, Guid actorUserId, CancellationToken ct)
    {
        var previousVersion = device.KeyVersion;
        var wasRevoked = device.RevokedAt is not null;

        device.KeyVersion++;
        device.RevokedAt = null;
        device.Enabled = true;
        device.DeviceCode = cmd.DeviceCode.Trim();
        device.Name = cmd.Name.Trim();
        device.Hardware = cmd.Hardware;
        device.CourtNumbers = cmd.CourtNumbers?.ToList() ?? [];
        if (cmd.ButtonMap is not null) device.ButtonMapJson = cmd.ButtonMap.ToJson();

        Audit(actorUserId, "device.reclaimed", new
        {
            device_id = device.Id,
            device_code = device.DeviceCode,
            was_revoked = wasRevoked,
            previous_key_version = previousVersion,
            key_version = device.KeyVersion,
        });
        await _db.SaveChangesAsync(ct);

        return new DeviceRegistration(device, KeyFor(device));
    }

    public async Task<Device> UpdateAsync(Device device, UpdateDeviceCommand cmd, Guid actorUserId, CancellationToken ct)
    {
        if (cmd.Name is not null) device.Name = cmd.Name.Trim();
        if (cmd.Enabled is not null) device.Enabled = cmd.Enabled.Value;
        if (cmd.CourtNumbers is not null) device.CourtNumbers = cmd.CourtNumbers.ToList();
        if (cmd.OtaChannel is not null) device.OtaChannel = cmd.OtaChannel.Value;
        if (cmd.PinnedVersion is not null) device.PinnedVersion = cmd.PinnedVersion;
        if (cmd.ButtonMap is { } buttons) device.ButtonMapJson = buttons.Value?.ToJson();

        Audit(actorUserId, "device.updated", new { device_id = device.Id });
        await _db.SaveChangesAsync(ct);

        return device;
    }

    public async Task<Device> RevokeAsync(Device device, Guid actorUserId, CancellationToken ct)
    {
        device.RevokedAt = DateTimeOffset.UtcNow;
        device.Enabled = false;

        Audit(actorUserId, "device.revoked", new { device_id = device.Id });
        await _db.SaveChangesAsync(ct);

        return device;
    }

    public Task<bool> DeviceCodeTakenAsync(string deviceCode, CancellationToken ct) =>
        _db.Devices.AnyAsync(d => d.DeviceCode == deviceCode, ct);

    /// <summary>Whether another row than <paramref name="exceptDeviceId"/> already uses this code.</summary>
    public Task<bool> DeviceCodeTakenAsync(string deviceCode, Guid exceptDeviceId, CancellationToken ct) =>
        _db.Devices.AnyAsync(d => d.DeviceCode == deviceCode && d.Id != exceptDeviceId, ct);

    /// <summary>
    /// The row that already owns this physical board, if any. Tenant-filtered like every
    /// other read here: a board registered by another club is not this club's to recognise.
    /// </summary>
    public Task<Device?> FindByMacAddressAsync(string macAddress, CancellationToken ct)
    {
        var normalised = macAddress.Trim().ToLowerInvariant();
        return _db.Devices.FirstOrDefaultAsync(d => d.MacAddress == normalised, ct);
    }

    private string KeyFor(Device device) =>
        _keys.DeriveEncoded(device.TenantId, device.Id, device.KeyVersion);

    // Block body, not an expression body: lizard's C# parser mis-scopes an
    // expression-bodied member containing braces into a *global* pseudo-function the
    // length of the file — see memory/gotchas.md.
    private void Audit(Guid actorUserId, string action, object details)
    {
        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorUserId,
            SubjectUserId = null,
            Action = action,
            DetailsJson = JsonSerializer.Serialize(details),
        });
    }
}

/// <summary>A device and its key. The key is derived on demand and never persisted.</summary>
public sealed record DeviceRegistration(Device Device, string DeviceKey);

/// <summary><paramref name="CourtNumbers"/> is in relay order — see <see cref="Device.CourtNumbers"/>.</summary>
public sealed record RegisterDeviceCommand(
    string DeviceCode,
    string Name,
    DeviceKind Kind,
    DeviceHardware Hardware,
    IReadOnlyList<int>? CourtNumbers,
    string? GateKey)
{
    /// <summary>Set when the device was discovered rather than typed in by hand.</summary>
    public string? MacAddress { get; init; }

    /// <summary>This box's own button map, or null to run the club's. See <see cref="Device.ButtonMapJson"/>.</summary>
    public ButtonMap? ButtonMap { get; init; }
}

/// <summary>
/// A null <paramref name="CourtNumbers"/> leaves the list alone; a list replaces it whole.
/// <paramref name="ButtonMap"/> is three-valued: null leaves the override alone, a value
/// holding null clears it (back to the club's map), a value holding a map sets it.
/// </summary>
public sealed record UpdateDeviceCommand(
    string? Name,
    bool? Enabled,
    IReadOnlyList<int>? CourtNumbers,
    OtaChannel? OtaChannel,
    string? PinnedVersion,
    Optional<ButtonMap?>? ButtonMap = null);

/// <summary>A value that is explicitly present, so "absent" and "present but null" can be told apart on a PATCH.</summary>
public readonly record struct Optional<T>(T Value);
