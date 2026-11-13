using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The wire shape of a heartbeat answered to a <see cref="DeviceKind.Gate"/>.
///
/// <para>
/// A named projection rather than an anonymous object written inline in the handler, so the
/// shared corpus can serialise the REAL body and compare it to its vectors byte for byte
/// (<c>DeviceGateProtocolCorpusTests</c>). A body assembled inside a handler can only be
/// pinned through an HTTP round trip, which is how a key order drifts quietly: the gate
/// parses this with a hand-written scan out of a fixed buffer, so the ORDER of these fields
/// and the absence of whitespace are part of the contract rather than incidental.
/// </para>
///
/// <para>
/// <b>What is absent is as much of the contract as what is present.</b> No
/// <c>court_numbers</c>, no <c>config</c>, no <c>button_map</c>: a door has no relay bank, no
/// slice price and no keypad, and a gate that found those keys would be reading a court box's
/// configuration. <c>gate_key</c>, by contrast, is present even when null — a firmware that
/// read an absent key as an empty string and a null one as an error would diverge on exactly
/// the gate nobody has named yet, which is every gate on its first heartbeat.
/// </para>
/// </summary>
public static class GateHeartbeatView
{
    /// <param name="heartbeatSeconds">The tenant's configured interval, the same number a court box is given.</param>
    /// <param name="unlockSeconds">
    /// <c>GateAccess.UnlockSecondsFor</c>, so the number the gate holds the lock open for
    /// offline is the number the online decision would have sent it. The two coming from one
    /// place is what stops a club's setting change reaching one path and not the other.
    /// </param>
    /// <param name="roster">
    /// The bookings this club's doors may admit on their own, always present and possibly
    /// empty: the firmware replaces its cache wholesale on every push, so a cancelled booking
    /// is expressed by its absence from the NEXT one and an omitted key would leave a stale
    /// roster live.
    /// </param>
    // Block body, not an expression body: lizard's C# parser mis-scopes an expression-bodied
    // member containing braces into a *global* pseudo-function the length of the file — see
    // memory/gotchas.md.
    public static object Of(
        Device device, string tenantSlug, int heartbeatSeconds, int unlockSeconds,
        IReadOnlyList<string> roster, DateTimeOffset now, GateV3Parts? v3 = null)
    {
        if (v3 is null || (v3.Settings is null && !v3.Lifeline.Any))
        {
            return Legacy(device, tenantSlug, heartbeatSeconds, unlockSeconds, roster, now);
        }

        // A v3 door (door-gate.md §14, device-api.md §11.1): the same keys in the same order, the
        // gate object grown at its end, and the lifeline objects after the roster.
        var body = new Dictionary<string, object?>
        {
            ["server_time"] = now,
            ["tenant_slug"] = tenantSlug,
            ["device_code"] = device.DeviceCode,
            ["kind"] = DeviceKinds.Gate,
            ["gate_key"] = device.GateKey,
            ["heartbeat_seconds"] = heartbeatSeconds,
            ["gate"] = GateObject(unlockSeconds, v3.Settings),
            ["roster"] = roster,
        };
        v3.Lifeline.WriteTo(body);
        return body;
    }

    /// <summary>
    /// The <c>gate</c> object: <c>unlock_seconds</c>, then — for a v3 door only — its three v3
    /// settings and the two fault settings every gate firmware reads and no server sent before
    /// (FC-8). Scalars only, forever (FC-12): a nested object here is never a setting.
    /// </summary>
    private static Dictionary<string, object> GateObject(int unlockSeconds, GateV3Settings? v3)
    {
        var gate = new Dictionary<string, object> { ["unlock_seconds"] = unlockSeconds };
        if (v3 is null) return gate;
        gate["power_restore_trust_minutes"] = v3.PowerRestoreTrustMinutes;
        gate["net_fallback_minutes"] = v3.NetFallbackMinutes;
        gate["ota_probation_minutes"] = v3.OtaProbationMinutes;
        gate["device_fault_reporting"] = v3.DeviceFaultReporting;
        gate["device_fault_max_per_hour"] = v3.DeviceFaultMaxPerHour;
        return gate;
    }

    /// <summary>
    /// The same body for a <c>codes:m1</c> door: the envelope above in the same order, then the
    /// four member-code keys after <c>roster</c> (member-code §5.2). A door that names no
    /// capability gets <see cref="Of"/>'s body byte for byte.
    /// </summary>
    public static Dictionary<string, object?> WithCodes(
        Device device, string tenantSlug, GateTiming timing,
        IReadOnlyList<string> roster, DateTimeOffset now, MemberCodeSync? codes, GateV3Parts? v3 = null)
    {
        var (heartbeatSeconds, unlockSeconds) = timing;
        var body = new Dictionary<string, object?>
        {
            ["server_time"] = now,
            ["tenant_slug"] = tenantSlug,
            ["device_code"] = device.DeviceCode,
            ["kind"] = DeviceKinds.Gate,
            ["gate_key"] = device.GateKey,
            ["heartbeat_seconds"] = heartbeatSeconds,
            ["gate"] = GateObject(unlockSeconds, v3?.Settings),
            ["roster"] = roster,
        };
        codes?.WriteTo(body);
        v3?.Lifeline.WriteTo(body);
        return body;
    }

    private static object Legacy(
        Device device, string tenantSlug, int heartbeatSeconds, int unlockSeconds,
        IReadOnlyList<string> roster, DateTimeOffset now)
    {
        return new
        {
            server_time = now,
            tenant_slug = tenantSlug,
            device_code = device.DeviceCode,

            // Stated outright rather than inferred from which keys are present, so a board
            // that registered as a gate and came back a court box — somebody deleted the row
            // and it re-registered without the hint — has the FACT available rather than
            // having to guess it from which keys arrived.
            //
            // What the firmware does with that is the firmware's own contract, and this
            // comment used to claim more than the server can: "a fault the firmware can see
            // and refuse to act on". The server's obligation ends at making the fact
            // available. See docs/specs/door-gate.md §3, which says the same thing and is
            // where the split between the two halves is argued.
            kind = DeviceKinds.Gate,
            gate_key = device.GateKey,
            heartbeat_seconds = heartbeatSeconds,
            gate = new { unlock_seconds = unlockSeconds },
            roster,
        };
    }
}

/// <summary>A door's two timings — its heartbeat interval and how long it holds the lock open — as <see cref="GateHeartbeatView.WithCodes"/> takes them.</summary>
public sealed record GateTiming(int HeartbeatSeconds, int UnlockSeconds);

/// <summary>A v3 door's settings inside <c>gate</c> (door-gate.md §14), each clamped.</summary>
public sealed record GateV3Settings(
    int PowerRestoreTrustMinutes, int NetFallbackMinutes, int OtaProbationMinutes,
    bool DeviceFaultReporting, int DeviceFaultMaxPerHour)
{
    /// <summary>The settings for a door naming any v3 ESP capability; null for a 1.x door, answered byte for byte as before.</summary>
    public static GateV3Settings? For(Device device, Services.TenantSettingsView s) => !Services.DeviceCaps.GateV3(device)
        ? null
        : new GateV3Settings(
            Services.DeviceSettings.Value(s, Services.DeviceSettings.PowerRestoreTrustMinutes),
            Services.DeviceSettings.Value(s, Services.DeviceSettings.NetFallbackMinutes),
            Services.DeviceSettings.Value(s, Services.DeviceSettings.OtaProbationMinutes),
            Services.BoxSettings.DeviceFaultReporting(s),
            Services.BoxSettings.DeviceFaultMaxPerHour(s));
}

/// <summary>What a v3 door's answer adds: the v3 gate settings (null for a 1.x door) and the lifeline.</summary>
public sealed record GateV3Parts(GateV3Settings? Settings, DeviceLifeline Lifeline);
