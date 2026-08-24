using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.Discovery;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>Why a claim was refused. <see cref="None"/> is the success case.</summary>
public enum ClaimFailure
{
    None = 0,
    InvalidClaimCode,
    InvalidRegistration,
    NoMatch,
    Ambiguous,
    BoardAlreadyClaimed,
    DeviceCodeTaken,

    /// <summary>This physical board already has a row in this tenant, matched by MAC.</summary>
    BoardAlreadyRegistered,
}

/// <summary>The claim code read off the board's LCD, plus the registration details for the row it will create.</summary>
public sealed record ClaimBoardCommand(string ClaimCode, string DeviceCode, string Name, int? CourtNumber);

public sealed record ClaimResult(
    ClaimFailure Failure,
    string? Detail,
    DiscoveredBoard? Board,
    DeviceRegistration? Registration)
{
    public bool Succeeded => Failure == ClaimFailure.None;
}

/// <summary>
/// The admin side of discovery: which boards this tenant may see, and turning one of them
/// into a <see cref="Device"/>.
///
/// <para>
/// Extracted from the endpoint for the same reason <see cref="DeviceRegistryService"/> was:
/// the claim decision is a security decision, and a security decision inside a routing
/// lambda can only be exercised through an HTTP client. Registration itself is delegated —
/// this class never creates a <c>Device</c> or writes a <c>device.registered</c> row of its
/// own, because two places that both know how to mint a device credential is one too many.
/// </para>
/// </summary>
public sealed class DeviceDiscoveryService
{
    private readonly DiscoveryStore _store;
    private readonly DeviceRegistryService _devices;
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly ProvisioningGrants _grants;

    public DeviceDiscoveryService(
        DiscoveryStore store, DeviceRegistryService devices, MainframeDbContext db,
        ITenantContext tenant, ProvisioningGrants grants)
    {
        _store = store;
        _devices = devices;
        _db = db;
        _tenant = tenant;
        _grants = grants;
    }

    public DiscoveryStatus Status() => _store.Status();

    /// <summary>
    /// The announcers this tenant's admin may see.
    ///
    /// <para>
    /// A board whose signature verified against a real device row belongs to that device's
    /// tenant and is hidden from every other one — the store itself is process-wide, so this
    /// is where the tenant boundary is drawn. An <b>unclaimed</b> board is shown to whoever
    /// asks, because it belongs to no tenant yet and that is the entire point of discovery;
    /// what it leaks is a MAC, a firmware version and an uptime, which is what anyone on the
    /// same WiFi already gets from ARP.
    /// </para>
    /// </summary>
    public IReadOnlyList<DiscoveredBoard> Visible()
    {
        var tenantId = _tenant.TenantId;
        return _store.Snapshot().Where(b => b.OwnerTenantId is null || b.OwnerTenantId == tenantId).ToList();
    }

    /// <summary>
    /// Matches a claim code against the live announcers and registers the board that
    /// committed to it.
    ///
    /// <para>
    /// Every outcome writes an audit row, refusals included. A failed claim is precisely the
    /// event someone investigating a board that will not connect — or someone investigating
    /// an attempt to steal one — needs to find in the log.
    /// </para>
    /// </summary>
    public async Task<ClaimResult> ClaimAsync(ClaimBoardCommand cmd, Guid actorUserId, CancellationToken ct)
    {
        var invalid = Validate(cmd);
        if (invalid is not null) return await RefuseAsync(invalid.Value, null, cmd, actorUserId, ct);

        var announcers = _store.Snapshot();
        var (failure, board) = Match(announcers, cmd.ClaimCode.Trim());
        if (failure != ClaimFailure.None) return await RefuseAsync(failure, board, cmd, actorUserId, ct);

        if (await _devices.DeviceCodeTakenAsync(cmd.DeviceCode.Trim(), ct))
        {
            return await RefuseAsync(ClaimFailure.DeviceCodeTaken, board, cmd, actorUserId, ct);
        }

        // A board that was reflashed, or whose key was lost, announces st=unclaimed with no
        // device id — indistinguishable from a new board except by its MAC. Registering it
        // again would leave two rows for one piece of hardware, both deriving working keys,
        // both looking legitimate. The answer is to rotate the existing row's key, not to
        // create a second one, so this refuses and says which row already owns the board.
        var existing = await _devices.FindByMacAddressAsync(board!.Mac, ct);
        if (existing is not null)
        {
            return await RefuseAsync(
                ClaimFailure.BoardAlreadyRegistered, board, cmd, actorUserId, ct,
                detail: existing.DeviceCode);
        }

        var registration = await _devices.RegisterAsync(
            new RegisterDeviceCommand(
                cmd.DeviceCode, cmd.Name, DeviceKind.CourtBox, HardwareOf(board.Hardware), cmd.CourtNumber, null)
            { MacAddress = board.Mac },
            actorUserId, ct);

        _store.MarkClaimed(board.Mac, registration.Device.Id, registration.Device.TenantId);

        // The board can now collect this key itself by presenting the code it is
        // displaying. The key is still returned to the admin as well: a technician with a
        // serial cable is the fallback for a board that cannot reach the API yet, and an
        // automatic path with no manual equivalent is the thing the discovery spec
        // explicitly refuses to ship.
        _grants.Issue(new ProvisioningGrant
        {
            Mac = board.Mac,
            ClaimCodeHash = ProvisioningGrants.HashCode(cmd.ClaimCode),
            DeviceId = registration.Device.Id,
            TenantId = registration.Device.TenantId,
            TenantSlug = _tenant.TenantSlug,
            KeyVersion = registration.Device.KeyVersion,
            ExpiresAt = DateTimeOffset.UtcNow.Add(ProvisioningGrants.Lifetime),
        });

        Audit(actorUserId, "device.claimed", new
        {
            device_id = registration.Device.Id,
            device_code = registration.Device.DeviceCode,
            mac = board.Mac,
            address = board.Address,
            hardware = board.Hardware,
            firmware = board.Firmware,
        });
        await _db.SaveChangesAsync(ct);

        return new ClaimResult(ClaimFailure.None, null, board, registration);
    }

    /// <summary>
    /// Finds the single announcer that committed to this code.
    ///
    /// <para>
    /// The commitment is <c>SHA256(code || ":" || nonce)</c> truncated to 16 hex, and the
    /// code is never on the wire — so an impostor that fabricates a commitment simply never
    /// matches. An impostor that <i>copies</i> a real board's nonce and commitment produces
    /// two announcers that both match, and the answer to that is to refuse loudly rather
    /// than to pick one: picking one is a coin flip on which physical box receives a key.
    /// The residual attack is denial of service, which is visible, instead of key theft,
    /// which is not.
    /// </para>
    /// </summary>
    private static (ClaimFailure Failure, DiscoveredBoard? Board) Match(
        IReadOnlyList<DiscoveredBoard> announcers, string code)
    {
        var matches = announcers
            .Where(b => b.Commitment is not null
                        && string.Equals(DiscoveryBeacon.ClaimCommitment(code, b.Nonce), b.Commitment, StringComparison.Ordinal))
            .ToList();

        if (matches.Count == 0) return (ClaimFailure.NoMatch, null);
        if (matches.Count > 1) return (ClaimFailure.Ambiguous, null);

        var board = matches[0];

        // A second announcer carrying the same commitment string — even one asserting
        // st=claimed to dodge the match above — is a copied beacon. Same refusal.
        if (announcers.Count(b => string.Equals(b.Commitment, board.Commitment, StringComparison.Ordinal)) > 1)
        {
            return (ClaimFailure.Ambiguous, null);
        }

        return board.Claimed ? (ClaimFailure.BoardAlreadyClaimed, board) : (ClaimFailure.None, board);
    }

    private static ClaimFailure? Validate(ClaimBoardCommand cmd)
    {
        if (!DiscoveryBeacon.IsWellFormedClaimCode(cmd.ClaimCode?.Trim())) return ClaimFailure.InvalidClaimCode;

        if (string.IsNullOrWhiteSpace(cmd.DeviceCode) || cmd.DeviceCode.Length > 64
            || string.IsNullOrWhiteSpace(cmd.Name) || cmd.CourtNumber is null)
        {
            // A court box that drives no court cannot have a heartbeat routed to anything,
            // so the court number is required here exactly as it is on manual registration.
            return ClaimFailure.InvalidRegistration;
        }

        return null;
    }

    private static DeviceHardware HardwareOf(string? announced)
    {
        return announced switch
        {
            "esp32" => DeviceHardware.Esp32,
            "mega2560" => DeviceHardware.Mega2560,

            // Default to the ESP8266 rather than refusing: the hardware string is
            // self-asserted and cosmetic, and refusing on it would let a typo in firmware
            // block a claim.
            _ => DeviceHardware.Esp8266,
        };
    }

    private async Task<ClaimResult> RefuseAsync(
        ClaimFailure failure, DiscoveredBoard? board, ClaimBoardCommand cmd, Guid actorUserId,
        CancellationToken ct, string? detail = null)
    {
        // The claim code itself is never logged. It is a secret the board is displaying, and
        // an audit log is read by more people than can stand in front of the cupboard.
        Audit(actorUserId, "device.claim_failed", new
        {
            reason = failure.ToString(),
            device_code = cmd.DeviceCode,
            mac = board?.Mac,
            announcers = _store.Snapshot().Count,
        });

        await _db.SaveChangesAsync(ct);
        return new ClaimResult(failure, detail, board, null);
    }

    private void Audit(Guid actorUserId, string action, object details)
    {
        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorUserId,

            // A device has no subject user. The {actor, subject} pair is still honoured:
            // the actor is the admin who pressed the button, and there is no member on
            // whose behalf a board is claimed.
            SubjectUserId = null,
            Action = action,
            DetailsJson = JsonSerializer.Serialize(details),
        });
    }
}
