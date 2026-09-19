using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The device roster: what a box is allowed to drive, and the club key it presents.
///
/// <para>
/// The logic lives here rather than inside endpoint lambdas so it can be exercised
/// without an HTTP client, and so each operation is a named method a reviewer can read
/// in one screen. Every mutation writes an <see cref="AuditLog"/> row in the same
/// <c>SaveChanges</c> as the change itself: a device that appeared, or a key that was
/// regenerated, without a matching audit row would break the <c>{actor, subject}</c>
/// guarantee the rest of the system relies on.
/// </para>
///
/// <para>
/// There is no registration, rotation, reclaim or revoke here any more. A board creates
/// its own row on its first heartbeat (<see cref="AutoRegisterAsync"/>) and an admin
/// edits or deletes it; the credential is the club's, not the row's, so rotating it is
/// <see cref="RegenerateApiKeyAsync"/> and it belongs to no device in particular.
/// </para>
/// </summary>
public sealed class DeviceRegistryService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly TenantSettingsAccessor _settings;

    public DeviceRegistryService(MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settings)
    {
        _db = db;
        _tenant = tenant;
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

        // A map the caller WROTE and that overreaches is refused: quietly rewriting what
        // somebody deliberately typed is worse than telling them it does not fit.
        //
        // An explicit CLEAR is not that. `button_map: null` means "run the club's map", and
        // refusing it left a two-court annex box unable to go back to the club default at
        // all — a one-way door out of an override, with on-screen advice ("give the box more
        // courts, or change the button map first") that a genuinely two-court box can never
        // take. Spec §8a promises the opposite: a one-court annex and a four-court main box
        // are both valid under one club default. So a clear takes the same trim
        // auto-registration and a by-hand court-list shrink already take — the club's map
        // with the buttons this box has no relay for turned off, which is exactly what the
        // admin would have typed themselves.
        if (requested is { } asked)
        {
            if (asked.Value is { } written)
            {
                return written.FirstSelectionBeyond(courtNumbers.Count) is null
                    ? new CourtAssignment(null, written, false)
                    : new CourtAssignment(ButtonMap.SelectsCourtBeyondDeviceCourts, null, false);
            }

            return settings.Buttons.FirstSelectionBeyond(courtNumbers.Count) is null
                ? new CourtAssignment(null, null, false)
                : new CourtAssignment(null, settings.Buttons.TrimmedTo(courtNumbers.Count), true);
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

    public async Task<Device> UpdateAsync(Device device, UpdateDeviceCommand cmd, Guid actorUserId, CancellationToken ct)
    {
        if (cmd.Name is not null) device.Name = cmd.Name.Trim();

        // The switch-off INSTANT, recorded on the transition rather than derived afterwards.
        //
        // `Enabled` is a boolean with no history, and the settlement asks a question about the
        // past: "was this court's door shut when that grace window closed?" (settlement-model.md
        // S5a). Answering it from the boolean alone let one click re-price every deadline still
        // inside the sweep's lookback; answering it from LastSeenAt instead reads the board's
        // last heartbeat as the click, which it is not — the gap between them is up to a
        // heartbeat cadence wide, and a deadline inside that gap was priced one way before the
        // click and the other way after it. Only the instant itself answers both, so it is
        // stamped here, where the transition actually happens.
        //
        // Cleared on the way back in: a board in service is not out of service since anything.
        if (cmd.Enabled is { } enabled && enabled != device.Enabled)
        {
            device.OutOfServiceSince = enabled ? null : DateTimeOffset.UtcNow;
        }

        if (cmd.Enabled is not null) device.Enabled = cmd.Enabled.Value;
        if (cmd.CourtNumbers is not null) device.CourtNumbers = cmd.CourtNumbers.ToList();
        if (cmd.ButtonMap is { } buttons) device.ButtonMapJson = buttons.Value?.ToJson();

        // An admin has now looked at this row, so it stops reading as "appeared by itself,
        // nobody has checked the courts it guessed". Deleting the row and letting the box
        // register again is what sets it back.
        device.AutoRegistered = false;

        Audit(actorUserId, "device.updated", new { device_id = device.Id });
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

    /// <summary>
    /// Creates the row for a board that has never called before, from nothing but its MAC.
    ///
    /// <para>
    /// This is the whole of provisioning now. It replaces a UDP discovery beacon, a claim
    /// code shown on the box's LCD, a commitment hash, a provisioning grant and a
    /// key-delivery endpoint — a chain in which every link could strand a board in a
    /// cupboard, and which existed only to hand out a per-device credential the club key
    /// makes unnecessary.
    /// </para>
    ///
    /// <para>
    /// The guesses are deliberately the ones an admin would otherwise type: the courts the
    /// club actually has, in ascending order, up to the four the relay bank can drive; the
    /// club's button map, trimmed if it selects a court this box has not got (which is the
    /// F13 rule — a box with fewer courts than the map names must not be left with inert
    /// buttons or refused outright); and a name an admin will want to change. The row is
    /// flagged <see cref="Device.AutoRegistered"/> so the Devices page says so.
    /// </para>
    /// </summary>
    public async Task<Device> AutoRegisterAsync(string macAddress, CancellationToken ct)
    {
        var courtNumbers = await _db.Courts.AsNoTracking()
            .Select(c => c.CourtNumber)
            .OrderBy(n => n)
            .Take(ButtonMap.MaxCourtsPerBox)
            .ToListAsync(ct);

        var settings = await _settings.GetAsync(ct);
        var trimmed = settings.Buttons.FirstSelectionBeyond(courtNumbers.Count) is null
            ? null
            : settings.Buttons.TrimmedTo(courtNumbers.Count);

        var device = new Device
        {
            TenantId = _tenant.TenantId,
            MacAddress = macAddress,
            DeviceCode = await AvailableDeviceCodeAsync(macAddress, ct),
            Name = "Court box",
            Kind = DeviceKind.CourtBox,
            Hardware = DeviceHardware.Esp8266,
            CourtNumbers = courtNumbers,
            ButtonMapJson = trimmed?.ToJson(),
            AutoRegistered = true,
        };

        _db.Devices.Add(device);

        // ActorUserId is Guid.Empty: nobody did this. The audit row exists so a box that
        // appeared is visible in the same trail as one an admin edited, not to name a person.
        Audit(Guid.Empty, "device.auto_registered", new
        {
            device_id = device.Id,
            device_code = device.DeviceCode,
            mac_address = device.MacAddress,
            court_numbers = device.CourtNumbers,
            button_map_trimmed = trimmed is not null,
        });
        await _db.SaveChangesAsync(ct);

        return device;
    }

    /// <summary>
    /// <c>box-&lt;last six hex of the MAC&gt;</c>, or the full MAC when a row already holds
    /// that code. The short form is what an admin reads off the board's label; the fallback
    /// exists because <c>device_code</c> is uniquely indexed and a collision would otherwise
    /// throw at the one moment nobody is watching — a box registering itself at 6am.
    /// </summary>
    private async Task<string> AvailableDeviceCodeAsync(string macAddress, CancellationToken ct)
    {
        var shortCode = $"box-{macAddress[^6..]}";
        return await DeviceCodeTakenAsync(shortCode, ct) ? $"box-{macAddress}" : shortCode;
    }

    /// <summary>Removes a device. Its board re-registers, with default courts, on its next heartbeat.</summary>
    public async Task DeleteAsync(Device device, Guid actorUserId, CancellationToken ct)
    {
        _db.Devices.Remove(device);
        Audit(actorUserId, "device.deleted", new { device_id = device.Id, device_code = device.DeviceCode });
        await _db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// The club's device API key, minting one on first read.
    ///
    /// <para>
    /// Readable, not shown-once. It is a value an admin has to paste into a
    /// <c>secrets.h</c> at a workbench, possibly weeks after the club was created, and a
    /// credential that can only be seen at the instant it is created is exactly what made
    /// the old scheme need a recovery protocol. Minting on read rather than at tenant
    /// creation means an existing club gets one the first time anybody opens the page.
    /// </para>
    /// </summary>
    public async Task<Tenant> ApiKeyAsync(Guid actorUserId, CancellationToken ct)
    {
        var tenant = await CurrentTenantAsync(ct);
        if (!string.IsNullOrEmpty(tenant.DeviceApiKey)) return tenant;

        return await IssueApiKeyAsync(tenant, actorUserId, firstIssue: true, ct);
    }

    /// <summary>
    /// Replaces the club's device API key. The old one stops working on the next request —
    /// there is no cache and no grace window — so every box has to be reflashed. That is
    /// the point: a regeneration that left the old key alive for a while would not be one.
    /// </summary>
    public async Task<Tenant> RegenerateApiKeyAsync(Guid actorUserId, CancellationToken ct)
        => await IssueApiKeyAsync(await CurrentTenantAsync(ct), actorUserId, firstIssue: false, ct);

    private async Task<Tenant> IssueApiKeyAsync(Tenant tenant, Guid actorUserId, bool firstIssue, CancellationToken ct)
    {
        tenant.DeviceApiKey = DeviceApiKey.Generate();
        tenant.DeviceApiKeyRegeneratedAt = DateTimeOffset.UtcNow;

        // The key itself is never in the audit details. An audit trail an admin can read is
        // not a place to put a live credential.
        Audit(actorUserId, "device.api_key_regenerated", new { first_issue = firstIssue });
        await _db.SaveChangesAsync(ct);

        return tenant;
    }

    /// <summary>
    /// The tenant row itself — tracked, so a key written to it is saved. <c>Tenant</c> is
    /// not tenant-scoped and carries no query filter, so this is an explicit lookup by the
    /// resolved tenant id rather than a filtered read.
    /// </summary>
    private async Task<Tenant> CurrentTenantAsync(CancellationToken ct)
        => await _db.Tenants.FirstOrDefaultAsync(t => t.Id == _tenant.TenantId, ct)
           ?? throw new InvalidOperationException("The resolved tenant no longer exists.");

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

/// <summary>
/// A null <paramref name="CourtNumbers"/> leaves the list alone; a list replaces it whole.
/// <paramref name="ButtonMap"/> is three-valued: null leaves the override alone, a value
/// holding null clears it (back to the club's map), a value holding a map sets it.
/// </summary>
public sealed record UpdateDeviceCommand(
    string? Name,
    bool? Enabled,
    IReadOnlyList<int>? CourtNumbers,
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
