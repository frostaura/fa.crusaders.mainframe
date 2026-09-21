using Crusaders.Mainframe.Api.Endpoints;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Every audit action a door surface can put in front of an admin, stated once and in full.
///
/// <para>
/// <b>This list exists because a console cannot be trusted to guess.</b> The doors area renders
/// an action as a chip with a colour and a sentence, from a dictionary the frontend holds. An
/// action the dictionary has never heard of used to fall through to the success branch, so
/// <c>device.updated</c> — an admin renaming a door — was painted as a green "Refused" scan, and
/// <c>device.event_time_clamped</c>, which the offline upload writes BESIDE every clamped event
/// with the same details, appeared as a twin of the scan it describes. A door with thirteen
/// admin edits and no scans at all read "13 refused scans, newest 1 min ago". The list below is
/// what the frontend's dictionary is pinned against, and <c>DoorAuditActionsTests</c> is what
/// keeps the list itself honest against the code that writes the rows.
/// </para>
///
/// <para>
/// <b>Two vocabularies, deliberately.</b> <see cref="Scans"/> is somebody standing at a door —
/// the set <see cref="DoorTrail.IsScanRow"/> selects, which the club log, the CSV, the day
/// counts and both member routes all read. <see cref="Events"/> is the BOARD's own story:
/// nothing about it is a scan, none of it is counted, and it reaches only the per-door feed,
/// in its own array. Mixing them is the defect this type is named after.
/// </para>
/// </summary>
public static class DoorAuditActions
{
    /// <summary>A scan the server decided and released the lock for.</summary>
    public const string Opened = DeviceGateEndpoint.OpenedAction;

    /// <summary>A scan a board decided from its cached roster while the link was down.</summary>
    public const string OfflineOpen = DoorTrail.OfflineOpenAction;

    /// <summary>A scan a board could not answer from its cache. Names nobody, structurally.</summary>
    public const string OfflineUnknownScan = DoorTrail.OfflineUnknownScanAction;

    /// <summary>The board registered itself. <c>kind</c> <see cref="RegisteredKind"/>.</summary>
    public const string AutoRegistered = "device.auto_registered";

    /// <summary>An admin changed something on the board's row. <c>kind</c> <see cref="EditedKind"/>.</summary>
    public const string Updated = "device.updated";

    /// <summary>An admin removed the board. <c>kind</c> <see cref="RemovedKind"/>.</summary>
    public const string Deleted = "device.deleted";

    /// <summary>
    /// The board's uptime arithmetic put an uploaded event outside the believable range and the
    /// server overruled it. <c>kind</c> <see cref="ClockCorrectedKind"/>.
    ///
    /// <para>
    /// <b>This is the row behind the double count.</b> It is written by
    /// <c>DeviceEventEndpoints.RecordAsync</c> alongside the scan row, with the SAME details —
    /// same <c>device_id</c>, same <c>seq</c>, same fingerprint — a microsecond apart, so a feed
    /// that returned every row carrying the device id showed each offline scan twice while the
    /// club log, which filters to scans, showed it once. It is a fact about the BOARD'S CLOCK
    /// and never a scan.
    /// </para>
    /// </summary>
    public const string EventTimeClamped = "device.event_time_clamped";

    /// <summary>An admin shut every open door at once.</summary>
    public const string ShutAll = AdminDoorFleetEndpoint.ShutAllAction;

    /// <summary>An admin reopened the doors a shut-all had shut.</summary>
    public const string ReopenedAll = AdminDoorFleetEndpoint.ReopenedAllAction;

    /// <summary>An admin exported the club's door log.</summary>
    public const string LogExported = AdminDoorLogEndpoint.ExportedAction;

    /// <summary>
    /// Every action that is a scan at a door — the four shapes of
    /// <see cref="DoorTrail.IsScanRow"/> with the refusal prefix expanded against
    /// <see cref="GateAccess.Reasons"/>, because a console needs the literal strings and a
    /// prefix is not one.
    /// </summary>
    public static readonly string[] Scans =
    [
        Opened,
        .. GateAccess.Reasons.Where(r => r != GateAccess.Ok).Select(r => $"{DoorTrail.DeniedPrefix}{r}"),
        OfflineOpen,
        OfflineUnknownScan,
    ];

    /// <summary>
    /// Every NON-scan action a door's own feed can carry — the rows that name this board in
    /// their details and record something other than a person at the door.
    /// </summary>
    public static readonly string[] Events = [AutoRegistered, Updated, Deleted, EventTimeClamped];

    /// <summary>
    /// The actions the doors AREA writes about a club's doors collectively. They carry no
    /// <c>device_id</c>, so they never reach one door's feed — they are here because a console
    /// showing a club's audit trail still has to have a word for them.
    /// </summary>
    public static readonly string[] Fleet = [ShutAll, ReopenedAll, LogExported];

    /// <summary>Every action above, which is every action a doors screen can meet.</summary>
    public static readonly string[] All = [.. Scans, .. Events, .. Fleet];

    /// <summary>The board told the server it exists. </summary>
    public const string RegisteredKind = "registered";

    /// <summary>An admin changed the board's row.</summary>
    public const string EditedKind = "edited";

    /// <summary>An admin removed the board.</summary>
    public const string RemovedKind = "removed";

    /// <summary>The server overruled the board's own clock on an uploaded event.</summary>
    public const string ClockCorrectedKind = "clock_corrected";

    /// <summary>
    /// What a door event is called on the wire — a word, not an action string.
    ///
    /// <para>
    /// A closed set, so a console can hold four sentences rather than parse a namespace. An
    /// action this server writes and this list has no word for is
    /// <see cref="UnrecognisedKind"/>, which the page renders neutrally: the one thing it must
    /// never do is fall through to a chip that asserts an outcome.
    /// </para>
    /// </summary>
    public static readonly string[] EventKinds =
        [RegisteredKind, EditedKind, RemovedKind, ClockCorrectedKind, UnrecognisedKind];

    /// <summary>
    /// A row this server wrote that this list has no word for. It is on the wire rather than
    /// omitted, because a feed that silently drops rows is a feed an admin cannot reason about.
    /// </summary>
    public const string UnrecognisedKind = "unrecognised";

    // ----------------------------------------------------------------- what changed

    /// <summary>The board told the server it exists.</summary>
    public const string RegisteredChange = "registered";

    /// <summary>An admin gave the door a different name or key.</summary>
    public const string RenamedChange = "renamed";

    /// <summary>An admin changed something else on the card — where it is, what its lock does with no power.</summary>
    public const string DetailsChange = "details";

    /// <summary>An admin took this door out of service on its own page.</summary>
    public const string ShutChange = "shut";

    /// <summary>An admin put it back into service on its own page.</summary>
    public const string ReopenedChange = "reopened";

    /// <summary>An admin shut every open door at once.</summary>
    public const string ShutAllChange = "shut_all";

    /// <summary>An admin reopened the doors a shut-all had shut.</summary>
    public const string ReopenedAllChange = "reopened_all";

    /// <summary>An admin removed the board.</summary>
    public const string RemovedChange = "removed";

    /// <summary>The server overruled the board's own clock on an uploaded event.</summary>
    public const string ClockCorrectedChange = "clock_corrected";

    /// <summary>
    /// A row this server cannot say anything sharper about — including every <c>device.updated</c>
    /// written before the <c>changes</c> list existed. Rendered neutrally, never guessed at.
    /// </summary>
    public const string OtherChange = "other";

    /// <summary>
    /// Every value <c>change</c> can take. A closed set, like <see cref="EventKinds"/> and for
    /// the same reason: a console holds sentences for these and must never fall through to one
    /// that asserts something else happened.
    /// </summary>
    public static readonly string[] Changes =
    [
        RegisteredChange, RenamedChange, DetailsChange, ShutChange, ReopenedChange,
        ShutAllChange, ReopenedAllChange, RemovedChange, ClockCorrectedChange, OtherChange,
    ];

    /// <summary>The token <c>device.updated</c> writes when the door went out of service.</summary>
    public const string ShutToken = "shut";

    /// <summary>The token it writes when the door came back into service.</summary>
    public const string ReopenedToken = "reopened";

    /// <summary>The token it writes when the board's display name changed.</summary>
    public const string NameToken = "name";

    /// <summary>The token it writes when the club's key for the door changed.</summary>
    public const string GateKeyToken = "gate_key";

    /// <summary>
    /// What one row of a door's own feed actually CHANGED, as a word.
    ///
    /// <para>
    /// <b>Nine identical rows saying "details or state were changed" are useless (A5).</b> The
    /// feed said <c>kind: "edited"</c> for a rename, a location note, a shut and a reopen alike,
    /// so a door's story read as a column of the same sentence and the one row an admin was
    /// looking for — who shut it, and when — was indistinguishable from eight that did not
    /// matter. The words are derived from the <c>changes</c> list
    /// <see cref="DeviceRegistryService.UpdateAsync"/> now writes; a row from before that
    /// existed has no list and is <see cref="OtherChange"/>, which is honest, rather than
    /// "details", which would be a guess.
    /// </para>
    ///
    /// <para>
    /// <b>State beats naming beats everything else</b> when one PATCH did several things. A
    /// single edit that renamed a door AND shut it is a shut first: "Shut by Priya Naidoo at
    /// 09:48" is the sentence somebody is looking for, and the rename is on the same row for
    /// anybody who reads further. Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    public static string ChangeOf(string action, IReadOnlyCollection<string> changes)
    {
        return action switch
        {
            AutoRegistered => RegisteredChange,
            Deleted => RemovedChange,
            EventTimeClamped => ClockCorrectedChange,
            ShutAll => ShutAllChange,
            ReopenedAll => ReopenedAllChange,
            Updated => UpdatedChangeOf(changes),
            _ => OtherChange,
        };
    }

    /// <summary>
    /// The word for one <c>device.updated</c>, from the tokens it recorded. Block body for the
    /// lizard reason in <c>memory/gotchas.md</c>.
    /// </summary>
    private static string UpdatedChangeOf(IReadOnlyCollection<string> changes)
    {
        if (changes.Count == 0) return OtherChange;
        if (changes.Contains(ShutToken)) return ShutChange;
        if (changes.Contains(ReopenedToken)) return ReopenedChange;
        if (changes.Contains(NameToken) || changes.Contains(GateKeyToken)) return RenamedChange;
        return DetailsChange;
    }

    /// <summary>
    /// The word for one non-scan action. Block body for the lizard reason in
    /// <c>memory/gotchas.md</c>.
    /// </summary>
    public static string EventKindOf(string action)
    {
        return action switch
        {
            AutoRegistered => RegisteredKind,
            Updated => EditedKind,
            Deleted => RemovedKind,
            EventTimeClamped => ClockCorrectedKind,
            _ => UnrecognisedKind,
        };
    }
}
