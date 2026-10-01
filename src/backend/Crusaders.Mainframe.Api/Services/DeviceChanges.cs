using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// What a board's change-record row stores (review round 4 wave B): the fields an admin can
/// edit, as values a volunteer can read — never the button map's JSON, never a MAC as a
/// subject. Only the fields that changed are stored, each side.
/// </summary>
public static class DeviceChanges
{
    /// <summary>"Court box (box-0a1b2c)": every box is called "Court box" until somebody names it.</summary>
    public static string Label(Device device)
    {
        var name = string.IsNullOrWhiteSpace(device.Name) ? device.DeviceCode : device.Name.Trim();
        return name == device.DeviceCode ? name : $"{name} ({device.DeviceCode})";
    }

    /// <summary>The editable fields, as the record names them. Block body for the lizard reason in memory/gotchas.md.</summary>
    public static Dictionary<string, object?> Snapshot(Device device)
    {
        return new Dictionary<string, object?>
        {
            ["name"] = device.Name,
            ["in_service"] = device.Enabled,
            ["court_numbers"] = string.Join(", ", device.CourtNumbers),
            ["own_button_map"] = device.ButtonMapJson is not null,
            ["gate_key"] = device.GateKey,
            ["location_note"] = device.LocationNote,
            ["power_loss_behaviour"] = DoorPowerLoss.Wire(device.PowerLossBehaviour),
            ["acknowledged"] = !device.AutoRegistered,
        };
    }

    /// <summary>What a removed board was: its code, its kind and what it served.</summary>
    public static Dictionary<string, object?> Removed(Device device)
    {
        var removed = new Dictionary<string, object?>
        {
            ["name"] = device.Name,
            ["device_code"] = device.DeviceCode,
            ["kind"] = device.Kind == DeviceKind.Gate ? "door" : "court_box",
        };
        if (device.Kind == DeviceKind.Gate) removed["gate_key"] = device.GateKey;
        else removed["court_numbers"] = string.Join(", ", device.CourtNumbers);
        return removed;
    }
}
