using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The wire shape of a <see cref="Device"/>.
///
/// <para>
/// A projection rather than the entity, so that adding a field to the entity is never
/// accidentally an API change — and, more to the point, so a credential can never leak
/// by being added to the domain type. There is no key here because a device does not
/// have one: the credential is the club's, read from
/// <c>GET /api/v1/admin/devices/api-key</c>.
/// </para>
/// </summary>
public static class DeviceView
{
    /// <param name="heartbeatSeconds">
    /// The tenant's configured <c>heartbeat_seconds</c>. Carried through so the two derived
    /// fields below can be computed once, on the server, from the same numbers the box is
    /// given on its heartbeat.
    /// </param>
    /// <param name="shutByName">
    /// The display name of the admin who took this board out of service, or null. Passed in
    /// rather than read here because the caller resolves every name on a page in ONE read —
    /// a projection that queried would be a query per row.
    /// </param>
    /// <param name="unchanged">
    /// True on the one answer that is not a change: a PATCH whose fields all already held the
    /// values sent. Present on every device view rather than only on that one, because a key
    /// that appears and disappears is a second response shape wearing one name — the argument
    /// this file already makes about the door-card fields on a court box. A stale tab shutting
    /// an already-shut door was told it had succeeded (B10); with this and
    /// <c>shut_by_name</c> the console can say "it was already shut — by Priya Naidoo at 21:48".
    /// </param>
    public static object Of(
        Device d, int heartbeatSeconds, string? shutByName = null, bool unchanged = false) => new
    {
        unchanged,
        shut_by_name = shutByName,
        id = d.Id,
        device_code = d.DeviceCode,
        name = Named(d.Name),
        kind = d.Kind.ToString(),
        hardware = d.Hardware.ToString(),
        // In relay order: index 0 is relay A. See Device.CourtNumbers.
        court_numbers = d.CourtNumbers,
        // This box's own button map, or null when it runs the club's. See Device.ButtonMapJson.
        button_map = ButtonMap.FromJson(d.ButtonMapJson)?.ToWire(),
        gate_key = d.GateKey,

        // The two door-card fields (W1.4) and the instant behind the out-of-service state.
        //
        // ALWAYS PRESENT, MEANINGFUL ONLY ON A GATE. A court box carries them empty rather
        // than omitted, because the console types one device shape and an optional key is a
        // second shape wearing the same name — the same argument DeviceView already makes
        // about `doors` on the member's QR response. Neither is inferred from anything the
        // board reports: see Device.LocationNote and DoorPowerLossBehaviour.
        location_note = d.LocationNote,
        power_loss_behaviour = DoorPowerLoss.Wire(d.PowerLossBehaviour),

        // When an admin shut this board, or null while it is in service. Already recorded on
        // the row for the settlement's sake (Device.OutOfServiceSince) and never readable, so
        // the console could say "out of service" and not "you shut this on Tuesday at 19:40".
        // It is evidence about the past, not a control.
        out_of_service_since = d.OutOfServiceSince,

        mac_address = d.MacAddress,
        enabled = d.Enabled,
        last_seen_at = d.LastSeenAt,
        last_ip_address = d.LastIpAddress,
        running_version = d.RunningVersion,
        mega_version = d.MegaVersion,
        // True while nothing but the box itself has touched this row. The page shows it as
        // "registered itself — check the courts", because the courts were a guess: the
        // club's, ascending, up to the four the relay bank drives. The first admin edit
        // clears it.
        auto_registered = d.AutoRegistered,
        created_at = d.CreatedAt,

        // What this box will ACTUALLY heartbeat at, and how long silence has to last
        // before it is offline. Both are derived here rather than on the page because the
        // page cannot know the firmware's clamp: it had a hardcoded 180 000 ms threshold
        // and a stale "every 30 s" comment while the interval was editable up to 3600, so
        // an admin who raised it to reduce chatter saw every box read WifiOff for 40% of
        // every interval and went power-cycling healthy hardware (round-3 finding 22).
        // effective_heartbeat_seconds is the tenant's setting after the firmware's own
        // [15, 300] clamp — equal to the setting now that the API refuses anything
        // outside it, and still computed rather than assumed, because a value stored
        // before that rule existed is still in some club's settings row.
        effective_heartbeat_seconds = HeartbeatCadence.Effective(heartbeatSeconds),
        offline_after_seconds = HeartbeatCadence.OfflineAfterSeconds(heartbeatSeconds),

        // WHETHER THE BOARD HAS HEARD THAT IT IS SHUT, and the instant it did (WIRE-R3 §1).
        //
        // Null while it is open, and null while it is shut and has not called since. The
        // difference between that null and an instant is the difference between the two
        // sentences the console may say, and until this field existed it could say neither:
        // see Device.ShutHeardAt for the whole of R3-1, which is the console reasoning from
        // silence about a board it was itself refusing to listen to.
        shut_heard_at = d.ShutHeardAt,

        // The board's own count of records it had to throw away, since it last booted, as of
        // its last heartbeat (WIRE-R3 §1). Zero when it has never reported one — which is not
        // the same as never having been asked, hence the instant beside it. It was logged and
        // stored nowhere (R3-33), so the one number that says a door's history has holes in it
        // lived in a log file nobody at the club can read.
        events_lost = d.EventsLost,
        events_lost_reported_at = d.EventsLostReportedAt,

        // What the board said it speaks on its latest heartbeat, and whether that includes the
        // member code (member-code §5.1, §8) — the per-board half of the rollout the console
        // shows. The club's phase is GET /api/v1/admin/devices/member-codes.
        capabilities = d.Capabilities,
        capabilities_reported_at = d.CapabilitiesReportedAt,
        member_codes = d.SpeaksMemberCodes,
    };

    /// <summary>
    /// The club's name for a board, or null when nobody has given it one.
    ///
    /// <para>
    /// <b>One unnamed case on the wire rather than two.</b> An admin may CLEAR a board's name
    /// (WIRE-R3 §3), which stores an empty string, and a console rendering that gets a row with
    /// a blank where a label should be — indistinguishable from a rendering bug and the third
    /// of the three different "unnamed" states R3-21 is about. Null is a state a page has one
    /// sentence for. Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    public static string? Named(string? name)
    {
        return string.IsNullOrWhiteSpace(name) ? null : name;
    }
}
