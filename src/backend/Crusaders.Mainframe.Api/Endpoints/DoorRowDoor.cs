using System.Text.Json;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The door a scan row happened at — <b>never null</b>, whether or not that door still exists.
///
/// <para>
/// <b>This type is the fix for the one critical of round two, found independently by three
/// reviewers.</b> A row whose board had been deleted answered <c>door: null</c>, the log page
/// read <c>.id</c> off it, and <c>/admin/doors/log</c> became a blank white page for every
/// admin in the club — reachable by a direct link, by the outcome filter, and by simply pressing
/// "Load older scans" until the cursor reached the removed door's rows. The rows themselves were
/// never the problem: they are still there, still correct, and still the only record that anybody
/// came through that door. What was missing was a way to say "this door is gone" that a renderer
/// could not mistake for "this row has no door".
/// </para>
///
/// <para>
/// <b>Resolution is by <c>device_id</c> at READ time and the stored strings are only a
/// fallback.</b> That ordering is the same one every door surface already runs and it is the
/// right way round: a club that renames a door wants its history to say what the door is called
/// now, not what the sign used to say. The stored <c>door_name</c> / <c>gate_key</c> /
/// <c>device_code</c> answer the single case resolution cannot — a board that is no longer in the
/// devices table at all.
/// </para>
///
/// <para>
/// <b>Deleting a door deletes no scan rows, and the wire now says so out loud.</b>
/// <c>audit_log</c> has no foreign key to <c>devices</c> — it is one append-only table for the
/// whole product — so a delete has never touched a single row. What it did was make them
/// unreadable: unnamed on the log, absent from the door filter, empty in the two door columns of
/// the export. They survive until the club's own <c>door_log_retention_days</c> sweep, and that
/// is what the delete confirmation is now entitled to promise.
/// </para>
/// </summary>
public static class DoorRowDoor
{
    /// <summary>
    /// The door block for one row: the live board if it is still there, else what the row
    /// itself recorded, with <c>removed</c> saying which of the two happened.
    ///
    /// <para>
    /// A row naming no board at all cannot arise on any of the four scan paths — every writer
    /// puts <c>device_id</c> in its details — but a row whose details will not parse can, and it
    /// is still listed, because the row is the evidence. It reaches the console as a removed door
    /// with nothing known about it, which is the honest reading: this server cannot say which
    /// door this was.
    /// </para>
    /// </summary>
    public static object Of(JsonElement? details, IReadOnlyDictionary<Guid, DoorRef> live)
    {
        if (DoorTrail.DeviceIdOf(details) is { } id && live.TryGetValue(id, out var door))
        {
            return new
            {
                id = (Guid?)door.Id,
                name = (string?)door.Name,
                gate_key = door.GateKey,
                removed = false,
            };
        }

        return new
        {
            id = (Guid?)null,
            name = StoredName(details),
            gate_key = StoredKey(details),
            removed = true,
        };
    }

    /// <summary>
    /// What the board was called when the row was written, falling back to its device code.
    ///
    /// <para>
    /// <c>door_name</c> has been written on every scan row since round two; rows older than that
    /// carry only <c>gate_key</c> and <c>device_code</c>. The code is what an admin reads off the
    /// board's own label (<c>gate-44c103</c>), so it is a real answer to "which door was this"
    /// where an empty string is not — and it is the same string A11 asks the console to show as
    /// "Unnamed scanner (gate-44c103)".
    /// </para>
    /// </summary>
    public static string? StoredName(JsonElement? details)
    {
        if (details is not { } root) return null;
        return DoorActivityView.Text(root, "door_name") ?? DoorActivityView.Text(root, "device_code");
    }

    /// <summary>The club's key for the door as the row recorded it, or null.</summary>
    public static string? StoredKey(JsonElement? details)
    {
        return details is { } root ? DoorActivityView.Text(root, "gate_key") : null;
    }

    /// <summary>
    /// The two door columns of the export, for one row: the key first because that is what the
    /// <c>door</c> column has always held, then the display name.
    ///
    /// <para>
    /// <b>They were empty for a removed door and that is E-M1.</b> A club exporting its log after
    /// deleting a scanner got a file with two blank columns on every one of that door's rows —
    /// the same rows the console could no longer name — so the export said nothing at all about
    /// where a third of a night's scans happened.
    /// </para>
    /// </summary>
    public static (string Key, string Name) Columns(JsonElement? details, IReadOnlyDictionary<Guid, DoorRef> live)
    {
        if (DoorTrail.DeviceIdOf(details) is { } id && live.TryGetValue(id, out var door))
        {
            return (door.GateKey ?? "", door.Name);
        }

        return (StoredKey(details) ?? "", StoredName(details) ?? "");
    }
}
