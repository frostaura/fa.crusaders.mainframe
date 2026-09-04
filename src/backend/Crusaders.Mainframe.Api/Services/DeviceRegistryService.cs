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

    /// <summary>
    /// Whether the tenant's current button map has a court button this list cannot
    /// honour — <see cref="ButtonMap.SelectsCourtBeyondDeviceCourts"/> if so, else null.
    /// The other half of the check lives in the settings PUT, which runs the same test
    /// against every box when the map changes.
    /// </summary>
    public async Task<string?> CourtAssignmentErrorAsync(IReadOnlyList<int> courtNumbers, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        return settings.Buttons.FirstSelectionBeyond(courtNumbers.Count) is null
            ? null
            : ButtonMap.SelectsCourtBeyondDeviceCourts;
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
    /// </summary>
    public async Task<DeviceRegistration> RotateKeyAsync(Device device, Guid actorUserId, CancellationToken ct)
    {
        device.KeyVersion++;
        Audit(actorUserId, "device.key_rotated", new { device_id = device.Id, key_version = device.KeyVersion });
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

    private void Audit(Guid actorUserId, string action, object details) =>
        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorUserId,
            SubjectUserId = null,
            Action = action,
            DetailsJson = JsonSerializer.Serialize(details),
        });
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
}

/// <summary>A null <paramref name="CourtNumbers"/> leaves the list alone; a list replaces it whole.</summary>
public sealed record UpdateDeviceCommand(
    string? Name,
    bool? Enabled,
    IReadOnlyList<int>? CourtNumbers,
    OtaChannel? OtaChannel,
    string? PinnedVersion);
