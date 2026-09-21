using System.Text.RegularExpressions;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The list the console's chip dictionary is pinned against, held honest against the code that
/// writes the rows.
///
/// <para>
/// <b>A dictionary nobody checks is a dictionary that silently stops covering things.</b> The
/// doors area renders an action it has no entry for through whatever branch happens to be last,
/// which is how an admin edit was painted as a green refusal (C4) and how an unrecognised
/// action would be again the next time one is added. <see cref="DoorAuditActions"/> is the
/// closed set; this class is what fails when the code writes something that is not in it, and
/// what tells the frontend lane's own enumeration test which strings to expect.
/// </para>
///
/// <para>
/// The source scan is the part that earns its keep. Asserting the list against itself proves
/// nothing; asserting it against every <c>gate.*</c>, <c>device.*</c> and <c>doors.*</c> literal
/// in the API assembly's source is what catches an action added in a month's time by somebody
/// who has never read this file.
/// </para>
/// </summary>
public sealed class DoorAuditActionsTests
{
    /// <summary>
    /// The court box's own vocabulary. In the same namespace, on the same table, and NOT a door
    /// surface — listed so the source scan below can tell "not a door" from "a door action
    /// nobody added to the list".
    /// </summary>
    private static readonly string[] NotDoorSurfaces =
    [
        "device.activation", "device.release", "device.api_key_regenerated", "device.heartbeat",
        "device.registered", "device.unknown", "device.boot",
    ];

    private static string ApiSourceRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "Crusaders.Mainframe.Api");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException("The API project was not found above the test binary.");
    }

    /// <summary>Every refusal the gate can decide has a literal action string on the list.</summary>
    [Fact]
    public void Every_gate_refusal_reason_is_on_the_list()
    {
        foreach (var reason in GateAccess.Reasons.Where(r => r != GateAccess.Ok))
        {
            Assert.Contains($"{DoorTrail.DeniedPrefix}{reason}", DoorAuditActions.Scans);
        }
        Assert.Contains(DeviceGateEndpoint.OpenedAction, DoorAuditActions.Scans);
    }

    /// <summary>
    /// The list and the predicate the four surfaces actually run agree in both directions. This
    /// is the assertion that would have caught the feed rendering <c>device.updated</c> as a
    /// scan, because the predicate always said it was not one.
    /// </summary>
    [Fact]
    public void The_list_and_the_scan_predicate_agree_in_both_directions()
    {
        Assert.All(DoorAuditActions.Scans, a => Assert.True(DoorTrail.IsScan(a), a));
        Assert.All(DoorAuditActions.Events, a => Assert.False(DoorTrail.IsScan(a), a));
        Assert.All(DoorAuditActions.Fleet, a => Assert.False(DoorTrail.IsScan(a), a));
    }

    /// <summary>Every door event has a word, and every word is one of the closed set.</summary>
    [Fact]
    public void Every_door_event_has_a_word_and_it_is_never_unrecognised()
    {
        foreach (var action in DoorAuditActions.Events)
        {
            var kind = DoorAuditActions.EventKindOf(action, []);
            Assert.Contains(kind, DoorAuditActions.EventKinds);
            Assert.NotEqual(DoorAuditActions.UnrecognisedKind, kind);
        }
        Assert.Equal(
            DoorAuditActions.UnrecognisedKind, DoorAuditActions.EventKindOf("device.invented_later", []));
    }

    /// <summary>No action is on two of the three lists, so a console can switch on one.</summary>
    [Fact]
    public void The_three_lists_are_disjoint_and_All_is_their_union()
    {
        Assert.Equal(DoorAuditActions.All.Length, DoorAuditActions.All.Distinct().Count());
        Assert.Equal(
            DoorAuditActions.Scans.Length + DoorAuditActions.Events.Length + DoorAuditActions.Fleet.Length,
            DoorAuditActions.All.Length);
    }

    /// <summary>
    /// Every <c>gate.*</c>, <c>device.*</c> or <c>doors.*</c> action literal in the API's own
    /// source is either on the list or explicitly not a door surface.
    /// </summary>
    [Fact]
    public void Every_action_literal_in_the_api_source_is_accounted_for()
    {
        var root = ApiSourceRoot();
        var found = new SortedSet<string>(StringComparer.Ordinal);

        foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}Migrations{Path.DirectorySeparatorChar}")) continue;

            foreach (Match match in Regex.Matches(
                         File.ReadAllText(file), @"""(?<action>(gate|doors)\.[a-z_]+|device\.[a-z_]+)"""))
            {
                found.Add(match.Groups["action"].Value);
            }
        }

        // The refusal prefix is a literal in its own right and is expanded on the list rather
        // than carried raw; the same goes for the interpolated `device.{kind}` forms, whose
        // concrete values are the two offline actions already on it.
        var accounted = DoorAuditActions.All
            .Concat(NotDoorSurfaces)
            .Concat([DoorTrail.DeniedPrefix, DoorTrail.ServerPrefix])
            .ToHashSet(StringComparer.Ordinal);

        var unaccounted = found.Where(a => !accounted.Contains(a)).ToList();

        Assert.True(
            unaccounted.Count == 0,
            "These audit actions are written by the API and are on neither DoorAuditActions nor the " +
            "explicit not-a-door-surface list, so the console has no word for them: " +
            string.Join(", ", unaccounted));

        // And the other direction: nothing on the list is a string the code no longer writes.
        foreach (var action in DoorAuditActions.All.Where(a => !a.StartsWith(DoorTrail.DeniedPrefix, StringComparison.Ordinal)))
        {
            Assert.Contains(action, found);
        }
    }
}
