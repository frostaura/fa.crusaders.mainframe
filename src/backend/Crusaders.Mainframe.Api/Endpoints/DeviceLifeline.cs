using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The lifeline objects of a v3 heartbeat answer (device-api.md §11.1): the <c>ota</c> offer, the
/// next key and the network — the three things that repair a board with no cable. Each is null
/// when the board is owed nothing, and each is keyed on THIS beat's capabilities.
/// </summary>
public sealed record DeviceLifeline(JsonObject? Ota, JsonObject? KeyNext, JsonObject? Net)
{
    public static readonly DeviceLifeline None = new(null, null, null);

    public bool Any => Ota is not null || KeyNext is not null || Net is not null;

    /// <summary>Appends the objects present, in the wire's order: <c>ota</c>, <c>key_next</c>, <c>net</c> (§3).</summary>
    public void WriteTo(IDictionary<string, object?> body)
    {
        if (Ota is not null) body["ota"] = Ota;
        if (KeyNext is not null) body["key_next"] = KeyNext;
        if (Net is not null) body["net"] = Net;
    }

    /// <summary>The <c>key_next</c> object in the wire's key order.</summary>
    public static JsonObject KeyNextObject(string id, string key) => new() { ["id"] = id, ["key"] = key };
}

/// <summary>
/// The body budgets every device answer is held to (device-api.md §1, §11.4; <c>compat/</c>
/// <c>budgets</c>), the key-ring caps, and the one fitting rule: shed member-code keys last-first,
/// never the snapshot, the roster, the config or a lifeline object — and if the rest could ever not
/// fit with every key shed, alternate a lifeline-only body with the full one.
/// </summary>
public static class DeviceHeartbeatBudget
{
    /// <summary>A 2.x court box (bridge 2.3.0 reads into 2560). Unchanged — FC-3 is recorded, not reopened.</summary>
    public const int CourtBox2x = MemberCodeWire.CourtBoxMaxBytes;

    /// <summary>A <c>hb:3</c> court box (bridge 3.0.0 reads into 5120; 80%).</summary>
    public const int CourtBoxV3 = 4096;

    /// <summary>A 1.x door (gate 1.1.2 reads into 4608).</summary>
    public const int Gate1x = MemberCodeWire.GateMaxBytes;

    /// <summary>A v3 door (gate 2.0.0 reads into 8192; 80%).</summary>
    public const int GateV3 = 6144;

    /// <summary>Activate, walk-up and extend replies, every court-box generation (512 and 384 buffers).</summary>
    public const int ScanReplyMax = 300;

    /// <summary>The door's scan decision (256 and 128 buffers).</summary>
    public const int GateReplyMax = 110;

    /// <summary>The events reply, frozen at its two keys (192 buffer, FC-5).</summary>
    public const int EventsReplyMax = 96;

    /// <summary>A v3 court box's key ring (MCV1-07; 2.x: 24).</summary>
    public const int CourtBoxV3KeyCap = 64;

    /// <summary>The body budget for this board on this beat.</summary>
    public static int For(Device device) => device.Kind == DeviceKind.Gate
        ? DeviceCaps.GateV3(device) ? GateV3 : Gate1x
        : DeviceCaps.Has(device, DeviceCaps.Hb3) ? CourtBoxV3 : CourtBox2x;

    /// <summary>The court box's key-ring cap for this beat.</summary>
    public static int CourtBoxKeyCap(Device device) =>
        DeviceCaps.Has(device, DeviceCaps.Hb3) ? CourtBoxV3KeyCap : MemberCodeWire.CourtBoxKeyCap;

    /// <summary>
    /// The body this board is sent: <paramref name="compose"/> with as many keys as fit, else — only
    /// when even a keyless body is over the budget and there is a lifeline to deliver — the
    /// lifeline-only body on alternate beats (§11.1). With today's fields the second never fires.
    /// </summary>
    public static Dictionary<string, object?> Fit(
        Func<MemberCodeSync?, Dictionary<string, object?>> compose, MemberCodeSync? sync, int maxBytes,
        DeviceLifeline lifeline, Func<Dictionary<string, object?>> lifelineOnly, bool lifelineTurn)
    {
        var body = MemberCodeHeartbeat.Fit(compose, sync, maxBytes);
        if (!lifeline.Any || SizeOf(body) <= maxBytes || !lifelineTurn) return body;
        return lifelineOnly();
    }

    /// <summary>Whether this beat is the lifeline's turn: alternate cadence periods, from one clock read.</summary>
    public static bool LifelineTurn(DateTimeOffset now, int heartbeatSeconds) =>
        (now.ToUnixTimeSeconds() / Math.Max(1, heartbeatSeconds)) % 2 == 1;

    /// <summary>The lifeline-only body (§11.1): who and when, the cadence, and the lifeline objects; absent is "no opinion" for the rest.</summary>
    public static Dictionary<string, object?> LifelineOnly(
        object serverTime, string tenantSlug, Device device, int heartbeatSeconds, DeviceLifeline lifeline)
    {
        var body = new Dictionary<string, object?>
        {
            ["server_time"] = serverTime,
            ["tenant_slug"] = tenantSlug,
            ["device_code"] = device.DeviceCode,
        };
        if (device.Kind == DeviceKind.Gate) body["kind"] = DeviceKinds.Gate;
        body["heartbeat_seconds"] = heartbeatSeconds;
        lifeline.WriteTo(body);
        return body;
    }

    /// <summary>The serialised size of a device body, as the endpoint writes it.</summary>
    public static int SizeOf(object body) => JsonSerializer.SerializeToUtf8Bytes(body).Length;
}
