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
    public static object Of(Device d, int heartbeatSeconds) => new
    {
        id = d.Id,
        device_code = d.DeviceCode,
        name = d.Name,
        kind = d.Kind.ToString(),
        hardware = d.Hardware.ToString(),
        // In relay order: index 0 is relay A. See Device.CourtNumbers.
        court_numbers = d.CourtNumbers,
        // This box's own button map, or null when it runs the club's. See Device.ButtonMapJson.
        button_map = ButtonMap.FromJson(d.ButtonMapJson)?.ToWire(),
        gate_key = d.GateKey,
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
    };
}
