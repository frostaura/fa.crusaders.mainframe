using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>One WiFi profile on the network PUT. <c>psk</c> null keeps the saved password; <c>""</c> is an open network.</summary>
public sealed record DeviceWifiProfile(
    [property: JsonPropertyName("ssid")] string? Ssid,
    [property: JsonPropertyName("psk")] string? Psk);

/// <summary>The network PUT: the server base URL every board dials (null = leave it) and up to two WiFi profiles.</summary>
public sealed record DeviceNetworkRequest(
    [property: JsonPropertyName("base")] string? Base,
    [property: JsonPropertyName("wifi")] IReadOnlyList<DeviceWifiProfile>? Wifi);

/// <summary>
/// The club's device network (device-api.md §8): saved and validated here with the boards' own
/// rules, delivered by the heartbeat's <c>net</c> object to every <c>net:1</c> board whose applied
/// version is older and whose configuration did not come from its setup portal.
///
/// <para>
/// <b>What this is for.</b> A WiFi password, an SSID or the server's address changing used to be a
/// reflash of every board (IO-02). With a second profile staged ahead of a router change — add the
/// new network, wait for every board's <c>net_ver</c>, then switch the router — none of it needs a
/// visit, and a board that cannot reach a new base URL within <c>device_net_fallback_minutes</c>
/// goes back to the old one by itself.
/// </para>
/// </summary>
public sealed class DeviceNetworkService
{
    public const int MaxProfiles = 2;
    public const string TooManyProfiles = "too_many_profiles";

    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly DeviceNetworkCipher _cipher;
    private readonly AdminChangeRecorder _changes;
    private readonly TimeProvider _clock;

    public DeviceNetworkService(
        MainframeDbContext db, ITenantContext tenant, DeviceNetworkCipher cipher, AdminChangeRecorder changes, TimeProvider clock)
    {
        _db = db;
        _tenant = tenant;
        _cipher = cipher;
        _changes = changes;
        _clock = clock;
    }

    /// <summary><c>GET /api/v1/admin/devices/network</c>: never a password, only whether one is set.</summary>
    public async Task<object> ViewAsync(CancellationToken ct)
    {
        var row = await _db.DeviceNetworks.AsNoTracking().FirstOrDefaultAsync(ct);
        var names = await PersonNames.ForAsync(_db, [row?.UpdatedByUserId], ct);
        return new
        {
            ver = row?.Version ?? 0,
            @base = row?.BaseUrl,
            wifi = Profiles(row).Select(p => new { ssid = p.Ssid, psk_set = p.PskCipher is not null }).ToList(),
            updated_at = row?.UpdatedAt,
            updated_by = row is null ? null : PersonNames.Of(row.UpdatedByUserId, names),
        };
    }

    /// <summary>
    /// <c>PUT /api/v1/admin/devices/network</c>: refused with the board's own reason code
    /// (<c>provision/</c> <c>nets</c>) when any board would refuse it, else saved as the next version.
    /// </summary>
    public async Task<string?> SaveAsync(DeviceNetworkRequest req, Guid actorUserId, CancellationToken ct)
    {
        var wifi = req.Wifi ?? [];
        if (wifi.Count > MaxProfiles) return TooManyProfiles;

        var row = await _db.DeviceNetworks.FirstOrDefaultAsync(ct);
        var saved = Profiles(row).ToList();

        // The net object exactly as a board would be sent it, run through the board's own rule.
        var resolved = new List<(string Ssid, string Psk)>();
        for (var slot = 0; slot < wifi.Count; slot++)
        {
            var psk = wifi[slot].Psk ?? (slot < saved.Count ? _cipher.Unprotect(saved[slot].PskCipher, _tenant.TenantId) : null);
            if (psk is null) return $"wifi{slot}_psk";
            resolved.Add((wifi[slot].Ssid ?? "", psk));
        }

        var nextVersion = (row?.Version ?? 0) + 1;
        var candidate = NetObject(nextVersion, req.Base, resolved);
        var (adopt, reason, _) = DeviceProvision.AdoptNet(JsonSerializer.SerializeToElement(candidate), nextVersion - 1);
        if (!adopt) return reason;

        if (row is null)
        {
            row = new DeviceNetwork { TenantId = _tenant.TenantId };
            _db.DeviceNetworks.Add(row);
        }
        row.Version = nextVersion;
        row.BaseUrl = req.Base;
        row.Wifi0Ssid = resolved.Count > 0 ? resolved[0].Ssid : null;
        row.Wifi0PskCipher = resolved.Count > 0 ? _cipher.Protect(resolved[0].Psk, _tenant.TenantId) : null;
        row.Wifi1Ssid = resolved.Count > 1 ? resolved[1].Ssid : null;
        row.Wifi1PskCipher = resolved.Count > 1 ? _cipher.Protect(resolved[1].Psk, _tenant.TenantId) : null;
        row.UpdatedAt = _clock.GetUtcNow();
        row.UpdatedByUserId = actorUserId;

        // The change record names the SSIDs and the address, never a password.
        await _changes.StageAsync(new AdminChange(
            Action: AdminChangeActions.DeviceNetworkUpdated,
            ActorUserId: actorUserId,
            SubjectKind: AdminChangeSubjects.Setting,
            SubjectLabel: "Club device network",
            After: new { ver = nextVersion, @base = req.Base, ssids = resolved.Select(p => p.Ssid) }), ct);
        await _db.SaveChangesAsync(ct);
        return null;
    }

    /// <summary>
    /// The heartbeat's <c>net</c> object for this board, or null: a <c>net:1</c>, acknowledged board
    /// whose applied version is older and whose configuration is not its own setup portal's — or one
    /// an admin explicitly pushed the club's network to (§8).
    /// </summary>
    public async Task<JsonObject?> NetForAsync(Device device, CancellationToken ct)
    {
        if (!DeviceCaps.Has(device, DeviceCaps.Net1) || !Endpoints.MemberCodeHeartbeat.Acknowledged(device)) return null;
        var row = await _db.DeviceNetworks.AsNoTracking().FirstOrDefaultAsync(ct);
        if (row is null || row.Version < 1) return null;

        var applied = device.NetVer ?? 0;
        if (device.NetPushRequested && device.NetSrc == "server" && applied >= row.Version) device.NetPushRequested = false;

        var wanted = device.NetPushRequested || (device.NetSrc != "local" && applied < row.Version);
        if (!wanted) return null;

        var profiles = new List<(string, string)>();
        foreach (var p in Profiles(row))
        {
            var psk = _cipher.Unprotect(p.PskCipher, _tenant.TenantId);
            if (psk is null) return null;
            profiles.Add((p.Ssid, psk));
        }
        return NetObject(row.Version, row.BaseUrl, profiles);
    }

    /// <summary>The <c>net</c> object in the wire's key order: <c>ver</c>, <c>base</c>, then each profile's ssid and psk.</summary>
    public static JsonObject NetObject(long ver, string? baseUrl, IReadOnlyList<(string Ssid, string Psk)> wifi)
    {
        var net = new JsonObject { ["ver"] = ver };
        if (baseUrl is not null) net["base"] = baseUrl;
        for (var slot = 0; slot < wifi.Count; slot++)
        {
            net[$"wifi{slot}_ssid"] = wifi[slot].Ssid;
            net[$"wifi{slot}_psk"] = wifi[slot].Psk;
        }
        return net;
    }

    private static IEnumerable<(string Ssid, string? PskCipher)> Profiles(DeviceNetwork? row)
    {
        if (row?.Wifi0Ssid is { } s0) yield return (s0, row.Wifi0PskCipher);
        if (row?.Wifi1Ssid is { } s1) yield return (s1, row.Wifi1PskCipher);
    }
}
