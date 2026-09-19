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
