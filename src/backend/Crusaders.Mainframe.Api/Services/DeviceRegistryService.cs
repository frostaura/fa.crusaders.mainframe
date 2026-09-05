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

    /// <summary>
    /// The court list and the map, reconciled: valid, refused, or made to fit.
    ///
    /// <para>
    /// A court list naming a court the club does not have is always refused, and so is an
    /// override the CALLER supplied that reaches past the list — they wrote it, and
    /// silently rewriting it would be worse than saying it does not fit. What is no longer
    /// refused is the case that had no way forward at all: a box with fewer courts than the
    /// club's default map selects, registered or claimed with no map of its own. That is
    /// every two- or three-court box in a club whose map names A–D, and the admin's only
    /// options were to edit the club map (changing every other box) or hand-compose an
    /// override. It gets one derived — the club's map with the unreachable court buttons
    /// turned off — which is what they would have written (closing re-review #13 residual).
    /// </para>
    /// </summary>
    /// <param name="requested">
    /// Three-valued, like the PATCH field it comes from. <c>null</c> is "no opinion" — the
    /// caller did not mention the map, so it is theirs to derive. <c>Optional(map)</c> is a
    /// map they wrote. <c>Optional(null)</c> is "run the club's map", which is also
    /// something they asked for: it is refused when the club's map does not fit, rather
    /// than answered with a derived override they did not want.
    /// </param>
    /// <param name="storedOverrideJson">The row's existing override, on an update.</param>
    public async Task<CourtAssignment> ResolveCourtAssignmentAsync(
        IReadOnlyList<int> courtNumbers, Optional<ButtonMap?>? requested, string? storedOverrideJson, CancellationToken ct)
    {
        var known = await _db.Courts.AsNoTracking()
            .Where(c => courtNumbers.Contains(c.CourtNumber))
            .Select(c => c.CourtNumber)
            .ToListAsync(ct);
        if (courtNumbers.Any(n => !known.Contains(n))) return new CourtAssignment(CourtNumberNotFound, null, false);

        var settings = await _settings.GetAsync(ct);

        // Asked for, and unusable: refuse, exactly as before. Covers both a map the caller
        // wrote and an explicit "put this box back on the club's map".
        if (requested is { } asked)
        {
            var map = asked.Value ?? settings.Buttons;
            return map.FirstSelectionBeyond(courtNumbers.Count) is null
                ? new CourtAssignment(null, asked.Value, false)
                : new CourtAssignment(ButtonMap.SelectsCourtBeyondDeviceCourts, null, false);
        }

        var stored = ButtonMap.FromJson(storedOverrideJson);
        var effective = stored ?? settings.Buttons;
        if (effective.FirstSelectionBeyond(courtNumbers.Count) is null)
        {
            // Nothing to do. Keep whatever override the row already had (null included) —
            // this path must not turn "runs the club's map" into a frozen copy of it.
            return new CourtAssignment(null, stored, false);
        }

        return new CourtAssignment(null, effective.TrimmedTo(courtNumbers.Count), true);
    }

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

    /// <summary>Error code when a hand-typed MAC is not twelve hex characters.</summary>
    public const string MacAddressInvalid = "mac_address_invalid";

    /// <summary>
    /// A MAC in the form the boards announce — twelve lowercase hex characters, no
    /// separators — or null when it could not be one.
    ///
    /// <para>
    /// Lenient about what an admin types and strict about what is stored. The separators a
    /// MAC is printed with on a label (<c>5c:cf:7f:1a:2b:3c</c>, <c>5C-CF-7F-1A-2B-3C</c>,
    /// <c>5ccf.7f1a.2b3c</c>) are all dropped, because a hand-typed MAC that does not match
    /// the announced one byte for byte is worse than useless: it silently fails to
    /// recognise the board it exists to recognise.
    /// </para>
    /// </summary>
    public static string? NormaliseMacAddress(string? macAddress)
    {
        if (string.IsNullOrWhiteSpace(macAddress)) return null;

        var text = macAddress.Trim();
        var stripped = new string(text.Where(char.IsAsciiHexDigit).ToArray()).ToLowerInvariant();
        var separators = text.Count(c => c is ':' or '-' or '.' or ' ');

        // Reject anything that carried characters which were neither hex nor a separator —
        // "5ccf7f1a2b3z" must not silently become an 11-character prefix.
        return stripped.Length == 12 && stripped.Length + separators == text.Length
            ? stripped
            : null;
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
/// <summary>
/// The outcome of reconciling a box's court list with the map it would run:
/// <c>Error</c> to refuse, else the override to store on the row — <c>null</c> meaning
/// "run the club's map" — and <c>Trimmed</c> saying whether it was derived rather than
/// asked for. See <see cref="DeviceRegistryService.ResolveCourtAssignmentAsync"/>.
///
/// <para>
/// Top-level rather than nested inside the service, and without a body, for the reason
/// the <c>Audit</c> comment gives about expression bodies: lizard's C# parser loses scope
/// at a nested record with a body and attributes every member after it to a *global*
/// pseudo-function the length of the file, which then fails the length gate. A refusal is
/// <c>new CourtAssignment(error, null, false)</c>.
/// </para>
/// </summary>
public sealed record CourtAssignment(string? Error, ButtonMap? Override, bool Trimmed);

public readonly record struct Optional<T>(T Value);
