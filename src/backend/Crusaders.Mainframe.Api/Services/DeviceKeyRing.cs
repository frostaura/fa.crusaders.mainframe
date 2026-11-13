using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>A board as the key-rotation status lists it.</summary>
public sealed record KeyBoard(Guid Id, string DeviceCode, string? Name, string Kind, string? LastKeyId);

/// <summary>What a rotation would strand: the boards that would lose the API if the old key were retired now.</summary>
public sealed record KeyStranding(IReadOnlyList<KeyBoard> OnOld, IReadOnlyList<KeyBoard> CannotRotate)
{
    public IReadOnlyList<KeyBoard> All => [.. OnOld, .. CannotRotate];
}

/// <summary>The outcome of a key operation the endpoint turns into a status code.</summary>
public sealed record KeyResult(string? Error, object? Detail = null)
{
    public static readonly KeyResult Ok = new((string?)null);
}

/// <summary>
/// The club's device keys under device contract v3 (device-api.md §6): rotate with an overlap
/// window delivered over the heartbeat, retire only when no board is stranded (or on a typed
/// confirmation that names the ones that will be), and restore a known key after a database loss.
///
/// <para>
/// <b>Why v2's Regenerate is gone.</b> It killed the old key "on the next request", and the key
/// is compiled into every board, so one click meant reflashing every court box and door — and the
/// founder's last-flash rule removed that option (BA-01, BD-3, IO-02). Now every unretired key
/// authenticates, so a rotation is safe to start at any time, and the only irreversible step is
/// retiring, which refuses to strand a board without saying which.
/// </para>
/// </summary>
public sealed class DeviceKeyRing
{
    /// <summary>The phrase an admin types to retire a key that would strand boards.</summary>
    public const string RetirePhrase = "retire the old key";

    /// <summary>The phrase an owner types to restore a known key.</summary>
    public const string RestorePhrase = "restore this key";

    public const string RotationInProgress = "rotation_in_progress";
    public const string NoRotation = "no_rotation";
    public const string BoardsWouldBeStranded = "boards_would_be_stranded";
    public const string ConfirmationRequired = "confirmation_required";
    public const string KeyInvalid = "key_invalid";

    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly AdminChangeRecorder _changes;
    private readonly TimeProvider _clock;

    public DeviceKeyRing(MainframeDbContext db, ITenantContext tenant, AdminChangeRecorder changes, TimeProvider clock)
    {
        _db = db;
        _tenant = tenant;
        _changes = changes;
        _clock = clock;
    }

    /// <summary>
    /// <c>GET …/api-key</c>: the current key (minted on first read, as v2 did), its id, and the
    /// rotation in progress — or null when the current key is the only valid one.
    /// </summary>
    public async Task<object> StatusAsync(Guid actorUserId, TenantSettingsView settings, CancellationToken ct)
    {
        var tenant = await TenantAsync(ct);
        if (string.IsNullOrEmpty(tenant.DeviceApiKey))
        {
            tenant.DeviceApiKey = DeviceApiKey.Generate();
            tenant.DeviceApiKeyRegeneratedAt = _clock.GetUtcNow();
            Audit(actorUserId, "device.api_key_regenerated", new { first_issue = true, key_id = DeviceProvision.KeyId(tenant.DeviceApiKeyId) });
            await _db.SaveChangesAsync(ct);
        }

        object? rotation = null;
        if (tenant.DeviceKeyRotationStartedAt is { } started)
        {
            var boards = await AcknowledgedBoardsAsync(ct);
            var onNew = boards.Where(d => d.LastKeyId == tenant.DeviceApiKeyId).Select(Board).ToList();
            var stranding = Stranding(boards, tenant.DeviceApiKeyId);
            rotation = new
            {
                next_id = DeviceProvision.KeyId(tenant.DeviceApiKeyId),
                started_at = started,
                grace_ends_at = started.AddHours(DeviceSettings.Value(settings, DeviceSettings.KeyGraceHours)),
                boards_on_new = onNew,
                boards_on_old = stranding.OnOld,
                boards_cannot_rotate = stranding.CannotRotate,
            };
        }

        return new
        {
            api_key = tenant.DeviceApiKey,
            key_id = DeviceProvision.KeyId(tenant.DeviceApiKeyId),
            regenerated_at = tenant.DeviceApiKeyRegeneratedAt,
            rotation,
        };
    }

    /// <summary><c>POST …/api-key/rotate</c>: a new current key; the old one stays valid until retired.</summary>
    public async Task<KeyResult> RotateAsync(Guid actorUserId, CancellationToken ct)
    {
        var tenant = await TenantAsync(ct);
        if (string.IsNullOrEmpty(tenant.DeviceApiKey)) return new KeyResult(NoRotation);
        if (await _db.DevicePreviousKeys.AnyAsync(k => k.RetiredAt == null, ct)) return new KeyResult(RotationInProgress);

        var now = _clock.GetUtcNow();
        Supersede(tenant, now);
        tenant.DeviceApiKey = DeviceApiKey.Generate();
        tenant.DeviceApiKeyId++;
        tenant.DeviceApiKeyRegeneratedAt = now;
        tenant.DeviceKeyRotationStartedAt = now;

        // Never the key itself: an audit trail an admin can read is not a place for a live credential.
        Audit(actorUserId, "device.api_key_rotated", new { key_id = DeviceProvision.KeyId(tenant.DeviceApiKeyId) });
        await _changes.StageAsync(new AdminChange(AdminChangeActions.DeviceApiKeyRotated, actorUserId), ct);
        await _db.SaveChangesAsync(ct);
        return KeyResult.Ok;
    }

    /// <summary>
    /// <c>POST …/api-key/retire</c>: every previous key stops authenticating. Refused while it would
    /// strand an acknowledged board, unless <paramref name="confirm"/> is the typed phrase.
    /// </summary>
    public async Task<KeyResult> RetireAsync(Guid actorUserId, string? confirm, CancellationToken ct)
    {
        var tenant = await TenantAsync(ct);
        var previous = await _db.DevicePreviousKeys.Where(k => k.RetiredAt == null).ToListAsync(ct);
        if (previous.Count == 0) return new KeyResult(NoRotation);

        var stranding = Stranding(await AcknowledgedBoardsAsync(ct), tenant.DeviceApiKeyId);
        if (stranding.All.Count > 0 && !string.Equals(confirm?.Trim(), RetirePhrase, StringComparison.OrdinalIgnoreCase))
        {
            return new KeyResult(BoardsWouldBeStranded, new
            {
                error = BoardsWouldBeStranded,
                confirm_phrase = RetirePhrase,
                boards = stranding.All,
            });
        }

        Retire(tenant, previous, actorUserId, _clock.GetUtcNow());
        Audit(actorUserId, "device.api_key_retired", new
        {
            key_ids = previous.Select(k => DeviceProvision.KeyId(k.KeyId)),
            stranded = stranding.All.Select(b => b.Id),
        });
        await _changes.StageAsync(new AdminChange(AdminChangeActions.DeviceApiKeyRetired, actorUserId), ct);
        await _db.SaveChangesAsync(ct);
        return KeyResult.Ok;
    }

    /// <summary>
    /// <c>POST …/api-key/restore</c>: puts back a key the boards already hold, as the current one
    /// (an owner, after a database loss — §6, IO-01). The key that was current stays valid as a
    /// previous one, so nothing that holds it is stranded either; the admin retires it when ready.
    /// </summary>
    public async Task<KeyResult> RestoreAsync(Guid actorUserId, string? key, string? confirm, CancellationToken ct)
    {
        if (!DeviceProvision.IsKey(key)) return new KeyResult(KeyInvalid);
        if (!string.Equals(confirm?.Trim(), RestorePhrase, StringComparison.OrdinalIgnoreCase))
        {
            return new KeyResult(ConfirmationRequired, new { error = ConfirmationRequired, confirm_phrase = RestorePhrase });
        }

        var tenant = await TenantAsync(ct);
        if (DeviceApiKey.Matches(tenant.DeviceApiKey, key)) return KeyResult.Ok;

        var now = _clock.GetUtcNow();
        if (!string.IsNullOrEmpty(tenant.DeviceApiKey)) Supersede(tenant, now);

        // A key that was a previous one becomes the current one again: one row, never two.
        var same = await _db.DevicePreviousKeys.Where(k => k.Key == key).ToListAsync(ct);
        _db.DevicePreviousKeys.RemoveRange(same);

        tenant.DeviceApiKey = key;
        tenant.DeviceApiKeyId++;
        tenant.DeviceApiKeyRegeneratedAt = now;
        tenant.DeviceKeyRotationStartedAt = await _db.DevicePreviousKeys.AnyAsync(k => k.RetiredAt == null, ct)
            || _db.ChangeTracker.Entries<DevicePreviousKey>().Any(e => e.State == EntityState.Added)
                ? now
                : null;

        Audit(actorUserId, "device.api_key_restored", new { key_id = DeviceProvision.KeyId(tenant.DeviceApiKeyId) });
        await _changes.StageAsync(new AdminChange(AdminChangeActions.DeviceApiKeyRestored, actorUserId), ct);
        await _db.SaveChangesAsync(ct);
        return KeyResult.Ok;
    }

    /// <summary>
    /// The heartbeat's <c>key_next</c> for a board that authenticated with <paramref name="keyId"/>:
    /// the current key, while the board is a <c>key:1</c> board not yet on it; else null.
    /// </summary>
    public static System.Text.Json.Nodes.JsonObject? KeyNextFor(Device device, Tenant tenant, int? keyId)
    {
        if (!DeviceCaps.Has(device, DeviceCaps.Key1)) return null;
        if (keyId is not { } used || used == tenant.DeviceApiKeyId || string.IsNullOrEmpty(tenant.DeviceApiKey)) return null;
        return Endpoints.DeviceLifeline.KeyNextObject(DeviceProvision.KeyId(tenant.DeviceApiKeyId), tenant.DeviceApiKey);
    }

    /// <summary>
    /// Records which key the board used, and retires the previous keys once every acknowledged board
    /// is on the current one and the grace window has passed (§6, step 4) — never while an
    /// acknowledged board that cannot rotate exists, because retiring would strand it.
    /// </summary>
    public async Task NoteAsync(Device device, Tenant tenant, int? keyId, TenantSettingsView settings, CancellationToken ct)
    {
        var now = _clock.GetUtcNow();
        if (keyId is { } used)
        {
            device.LastKeyId = used;
            device.LastKeyAt = now;
        }

        if (tenant.DeviceKeyRotationStartedAt is not { } started) return;
        if (now < started.AddHours(DeviceSettings.Value(settings, DeviceSettings.KeyGraceHours))) return;

        var boards = await AcknowledgedBoardsAsync(ct);
        if (Stranding(boards, tenant.DeviceApiKeyId).All.Count > 0) return;

        var previous = await _db.DevicePreviousKeys.Where(k => k.RetiredAt == null).ToListAsync(ct);
        Retire(tenant, previous, Guid.Empty, now);
        Audit(Guid.Empty, "device.api_key_retired", new
        {
            key_ids = previous.Select(k => DeviceProvision.KeyId(k.KeyId)),
            automatic = true,
            device_id = device.Id,
        });
    }

    /// <summary>Who the retirement would strand: acknowledged enabled boards not yet on the current key.</summary>
    public static KeyStranding Stranding(IReadOnlyList<Device> acknowledged, int currentId)
    {
        var notOnNew = acknowledged.Where(d => d.LastKeyId != currentId).ToList();
        return new KeyStranding(
            [.. notOnNew.Where(d => DeviceCaps.Has(d, DeviceCaps.Key1)).Select(Board)],
            [.. notOnNew.Where(d => !DeviceCaps.Has(d, DeviceCaps.Key1)).Select(Board)]);
    }

    private static KeyBoard Board(Device d)
    {
        return new KeyBoard(
            d.Id, d.DeviceCode, Endpoints.DeviceView.Named(d.Name), d.Kind.ToString(),
            d.LastKeyId.HasValue ? DeviceProvision.KeyId(d.LastKeyId.Value) : null);
    }

    private async Task<List<Device>> AcknowledgedBoardsAsync(CancellationToken ct)
    {
        var enabled = await _db.Devices.Where(d => d.Enabled).OrderBy(d => d.DeviceCode).ToListAsync(ct);
        return [.. enabled.Where(Endpoints.MemberCodeHeartbeat.Acknowledged)];
    }

    private void Supersede(Tenant tenant, DateTimeOffset now)
    {
        _db.DevicePreviousKeys.Add(new DevicePreviousKey
        {
            TenantId = tenant.Id,
            KeyId = tenant.DeviceApiKeyId,
            Key = tenant.DeviceApiKey!,
            SupersededAt = now,
        });
    }

    private static void Retire(Tenant tenant, List<DevicePreviousKey> previous, Guid actorUserId, DateTimeOffset now)
    {
        foreach (var k in previous)
        {
            k.RetiredAt = now;
            k.RetiredByUserId = actorUserId;
        }
        tenant.DeviceKeyRotationStartedAt = null;
    }

    private async Task<Tenant> TenantAsync(CancellationToken ct)
        => await _db.Tenants.FirstOrDefaultAsync(t => t.Id == _tenant.TenantId, ct)
           ?? throw new InvalidOperationException("The resolved tenant no longer exists.");

    private void Audit(Guid actorUserId, string action, object details)
    {
        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorUserId,
            Action = action,
            DetailsJson = JsonSerializer.Serialize(details),
        });
    }
}

/// <summary>The v3 capabilities a board names in <c>caps</c> (device-api.md §1).</summary>
public static class DeviceCaps
{
    public const string Hb3 = "hb:3";
    public const string Lcd2 = "lcd:2";
    public const string Ota1 = "ota:1";
    public const string Key1 = "key:1";
    public const string Net1 = "net:1";

    public static bool Has(Device device, string cap) => device.Capabilities.Contains(cap);

    /// <summary>A gate is answered the v3 <c>gate</c> settings when it names any of the three ESP capabilities (door-gate.md §14).</summary>
    public static bool GateV3(Device device) => Has(device, Ota1) || Has(device, Key1) || Has(device, Net1);
}
