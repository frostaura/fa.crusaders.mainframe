using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The wire shape of a <see cref="Device"/>.
///
/// <para>
/// A projection rather than the entity, so that adding a field to the entity is never
/// accidentally an API change — and, more to the point, so a credential can never leak
/// by being added to the domain type. There is no key here because there is no key
/// stored; it is derived and shown once at registration.
/// </para>
/// </summary>
public static class DeviceView
{
    public static object Of(Device d) => new
    {
        id = d.Id,
        device_code = d.DeviceCode,
        name = d.Name,
        kind = d.Kind.ToString(),
        hardware = d.Hardware.ToString(),
        court_number = d.CourtNumber,
        gate_key = d.GateKey,
        mac_address = d.MacAddress,
        key_version = d.KeyVersion,
        enabled = d.Enabled,
        revoked_at = d.RevokedAt,
        last_seen_at = d.LastSeenAt,
        last_ip_address = d.LastIpAddress,
        running_version = d.RunningVersion,
        mega_version = d.MegaVersion,
        ota_channel = d.OtaChannel.ToString(),
        pinned_version = d.PinnedVersion,
        created_at = d.CreatedAt,
    };
}
