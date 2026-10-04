using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 12, D12-3. Both door-log exports (<c>/admin/doors/activity.csv</c> and a member's
/// <c>doors.csv</c>) take their two door columns from <see cref="DoorRowDoor.Columns"/>, which wrote
/// the auto-registration placeholder "Door gate" — and an empty key column — for every scan at an
/// unnamed gate, where the console, the Night and the Doors page say "Unnamed scanner (gate-…)".
/// </summary>
public class R12DoorCsvColumnsTests
{
    private static JsonElement Details(object o) => JsonDocument.Parse(JsonSerializer.Serialize(o)).RootElement;

    [Fact]
    public void A_live_unnamed_gate_is_named_by_its_code_as_the_console_names_it()
    {
        var id = Guid.NewGuid();
        var live = new Dictionary<Guid, DoorRef> { [id] = new DoorRef(id, DeviceRegistryService.GatePlaceholderName, null, "gate-8f41fa") };

        var (key, name) = DoorRowDoor.Columns(Details(new { device_id = id }), live);

        Assert.Equal("", key);
        Assert.Equal("Unnamed scanner (gate-8f41fa)", name);
    }

    [Fact]
    public void A_removed_unnamed_gate_is_named_by_the_code_its_row_kept()
    {
        var details = Details(new { device_id = Guid.NewGuid(), door_name = DeviceRegistryService.GatePlaceholderName, device_code = "gate-44c103" });

        Assert.Equal("Unnamed scanner (gate-44c103)", DoorRowDoor.Columns(details, new Dictionary<Guid, DoorRef>()).Name);
    }

    [Fact]
    public void A_named_door_keeps_its_key_and_name()
    {
        var id = Guid.NewGuid();
        var live = new Dictionary<Guid, DoorRef> { [id] = new DoorRef(id, "Front door", "front-door", "gate-1") };

        Assert.Equal(("front-door", "Front door"), DoorRowDoor.Columns(Details(new { device_id = id }), live));
    }
}
