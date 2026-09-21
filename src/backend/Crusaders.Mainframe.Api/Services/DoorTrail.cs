using System.Linq.Expressions;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// What counts as a door row in <c>audit_log</c>, and what each one means.
///
/// <para>
/// <b>There is no door table and there is not going to be one.</b> A door's whole record is
/// audit rows written by two different paths in two different vocabularies —
/// <c>DeviceGateEndpoint</c> writes <c>gate.opened</c> / <c>gate.denied_&lt;reason&gt;</c> for
/// a decision the server made, and <c>DeviceEventEndpoints</c> writes
/// <c>device.gate_open</c> / <c>device.unknown_scan</c> for something a board had already done
/// while the link was down. Four surfaces now read them: the club log, the CSV, the per-door
/// counts and the member's own history. Without one statement of "these four actions, and
/// these two of them are releases", the four would each hold their own list and the first one
/// somebody forgot to update would quietly under-count a club's day.
/// </para>
///
/// <para>
/// <b>The two vocabularies are deliberately not unified</b>, for the reason
/// <c>AdminDeviceActivityEndpoint</c> already records: a refusal the API decided and what the
/// server made of something a board did are different kinds of fact, and renaming one to the
/// other would assert they are the same. What is unified is the OUTCOME — released or refused
/// — because that is the question every one of the four surfaces actually asks.
/// </para>
/// </summary>
public static class DoorTrail
{
    /// <summary>An open the server decided. <c>gate.opened</c>.</summary>
    public const string OpenedAction = DeviceGateEndpoint.OpenedAction;

    /// <summary>The prefix every server-decided refusal carries, with its reason appended.</summary>
    public const string DeniedPrefix = DeviceGateEndpoint.DeniedActionPrefix;

    /// <summary>An open a board decided from its cached roster and uploaded afterwards.</summary>
    public const string OfflineOpenAction = "device.gate_open";

    /// <summary>A scan a board could not answer from its cache. It names nobody, structurally — §6.</summary>
    public const string OfflineUnknownScanAction = "device.unknown_scan";

    /// <summary>The lock was released.</summary>
    public const string Released = "released";

    /// <summary>Somebody was turned away.</summary>
    public const string Refused = "refused";

    /// <summary>
    /// The board decided it for itself. Not a third outcome — a release or a refusal is
    /// either online or offline — but it is a filter the club log offers, because "what did
    /// this door do while it could not reach us" is a question with its own answer.
    /// </summary>
    public const string Offline = "offline";

    /// <summary>Every value <c>?outcome=</c> accepts. A closed set; anything else is refused.</summary>
    public static readonly string[] Outcomes = [Released, Refused, Offline];

    /// <summary>
    /// An uploaded event whose <c>kind</c> the board mangled past recognition. Written as the
    /// row's <c>outcome</c>, so it reaches the log's reason filter like any other. The writer's
    /// own constant rather than a copy — the two going out of step is how a filter starts
    /// refusing a word the server is still writing.
    /// </summary>
    public const string MalformedOutcome = DeviceEventEndpoints.Malformed;

    /// <summary>
    /// Every value <c>?reason=</c> accepts — <b>both vocabularies</b>, because a gate decision
    /// writes <c>reason</c> and an uploaded event writes <c>outcome</c>, and the filter reaches
    /// both (see <c>DoorLogQuery.ReasonMatch</c>).
    ///
    /// <para>
    /// <b>Closed rather than free text, because it was free text and said nothing.</b>
    /// <c>?reason=bogus</c> answered <c>200</c> with an empty list, which an admin reads as
    /// "nothing happened at this door" and not as "that is not a word this server knows"
    /// (E-M3). The two extra members are the outcomes only the OFFLINE path writes:
    /// <see cref="MalformedOutcome"/> for a kind it could not read and
    /// <c>not_a_court_box</c> for a door reporting a court event.
    /// </para>
    /// </summary>
    public static readonly string[] Reasons =
        [.. GateAccess.Reasons, MalformedOutcome, GateAccess.NotACourtBox];

    /// <summary>
    /// The same four actions as a predicate the database can run.
    ///
    /// <para>
    /// An expression rather than a call to <see cref="IsScan"/>, which no provider can
    /// translate — and stated HERE rather than at each of the three reading endpoints, because
    /// a fifth door action added later must appear in one place or the club log, the counts and
    /// the member's history will each be a different subset of the truth.
    /// </para>
    ///
    /// <para>
    /// The refusals are matched by an explicit range rather than <c>StartsWith</c>: the prefix
    /// ends in an underscore, which is a single-character wildcard in the <c>LIKE</c> that
    /// <c>StartsWith</c> compiles to, and a pattern that also matched <c>gate.deniedX…</c> would
    /// be a rule that is true today by accident.
    /// </para>
    /// </summary>
    public static readonly Expression<Func<AuditLog, bool>> IsScanRow =
        a => a.Action == OpenedAction
             || a.Action == OfflineOpenAction
             || a.Action == OfflineUnknownScanAction
             || (a.Action.Length > DeniedPrefix.Length && a.Action.Substring(0, DeniedPrefix.Length) == DeniedPrefix);

    /// <summary>
    /// Everything about a board that is NOT a scan — derived from <see cref="IsScanRow"/> by
    /// negation rather than restated, so the two can never drift apart.
    ///
    /// <para>
    /// The per-door feed needs both halves as separate pages (<c>items</c> and <c>events</c>),
    /// and a second hand-written predicate is precisely the shape that produced the defect the
    /// split exists to close: one reader's idea of "a scan" differing from another's.
    /// </para>
    /// </summary>
    public static readonly Expression<Func<AuditLog, bool>> IsNotScanRow =
        Expression.Lambda<Func<AuditLog, bool>>(
            Expression.Not(IsScanRow.Body), IsScanRow.Parameters);

    /// <summary>
    /// Every row <c>RetentionWorker</c> may DELETE at the door's own, shorter horizon.
    ///
    /// <para>
    /// <b>Wider than <see cref="IsScanRow"/> on purpose, and only on the server side.</b> It is
    /// every <c>gate.*</c> action rather than the two the log reads, so a door action added
    /// later — a remote open, a pass used — is purged from the day it exists rather than
    /// quietly accumulating until somebody remembers to extend a list. The two
    /// <c>device.*</c> actions are named exactly, because that namespace also holds a court
    /// box's activations and releases, which the settlement reads and which are governed by
    /// <c>retention_years</c>: a prefix match there would delete money evidence.
    /// </para>
    /// </summary>
    public static readonly Expression<Func<AuditLog, bool>> IsPurgeableRow =
        a => a.Action == OfflineOpenAction
             || a.Action == OfflineUnknownScanAction
             || (a.Action.Length > ServerPrefix.Length && a.Action.Substring(0, ServerPrefix.Length) == ServerPrefix);

    /// <summary>The namespace every decision the SERVER made about a door is written under.</summary>
    public const string ServerPrefix = "gate.";

    /// <summary>The release half of the four, as the database can run it.</summary>
    public static readonly Expression<Func<AuditLog, bool>> IsReleaseRow =
        a => a.Action == OpenedAction || a.Action == OfflineOpenAction;

    /// <summary>The refusal half, as the database can run it.</summary>
    public static readonly Expression<Func<AuditLog, bool>> IsRefusalRow =
        a => a.Action == OfflineUnknownScanAction
             || (a.Action.Length > DeniedPrefix.Length && a.Action.Substring(0, DeniedPrefix.Length) == DeniedPrefix);

    /// <summary>The two the board decided for itself, as the database can run it.</summary>
    public static readonly Expression<Func<AuditLog, bool>> IsOfflineRow =
        a => a.Action == OfflineOpenAction || a.Action == OfflineUnknownScanAction;

    /// <summary>
    /// Whether this action is a scan at a door — one of the four, and nothing else.
    ///
    /// <para>
    /// <b>A registration and an admin edit are not scans.</b> They are in the per-BOARD feed
    /// (<c>AdminDeviceActivityEndpoint</c>, deliberately: an admin diagnosing a door should
    /// not have to know which half of the story to look in) and they are not in the club's
    /// door log and not in its counts, because nobody stood at the door. That distinction is
    /// the difference between "what has this board been doing" and "who tried to get in".
    /// </para>
    /// </summary>
    public static bool IsScan(string action)
        => action == OpenedAction
           || action == OfflineOpenAction
           || action == OfflineUnknownScanAction
           || action.StartsWith(DeniedPrefix, StringComparison.Ordinal);

    /// <summary>
    /// Whether this scan released the lock. <b>Not</b> "whether the door opened" — P2: the
    /// board energised a relay, and there is no sensor on this product that could say more.
    /// </summary>
    public static bool IsRelease(string action)
        => action == OpenedAction || action == OfflineOpenAction;

    /// <summary>Whether the board decided this one on its own, from the cache.</summary>
    public static bool IsOfflineAction(string action)
        => action == OfflineOpenAction || action == OfflineUnknownScanAction;

    /// <summary>
    /// The outcome vocabulary for one row: <see cref="Released"/> or <see cref="Refused"/>,
    /// or null when the action is not a scan at all.
    /// </summary>
    public static string? OutcomeOf(string action)
    {
        if (!IsScan(action)) return null;
        return IsRelease(action) ? Released : Refused;
    }

    /// <summary>
    /// The instant one audit row should be DISPLAYED and ORDERED at — the one rule behind
    /// <see cref="AuditLog.ScanAt"/>, stated here beside the predicates that decide what a door
    /// row is.
    ///
    /// <para>
    /// It is the row's own instant for everything the server decided as it happened, and the
    /// scan's instant for an offline row, which is written at the upload and carries
    /// <c>occurred_at</c> in its details. That is the same rule
    /// <see cref="Endpoints.DoorActivityView.ScannedAt"/> has applied on the way OUT since W1.2;
    /// what was missing was applying it on the way IN, so that the column a list is ordered by
    /// is the column it prints. See <see cref="AuditLog.ScanAt"/> for what the divergence cost.
    /// </para>
    ///
    /// <para>
    /// Deliberately tolerant: a row with no details, unparseable details, or an
    /// <c>occurred_at</c> that is not an instant falls back to <paramref name="createdAt"/>. A
    /// row is evidence and is listed whatever state its details are in — refusing to place it
    /// because a field will not read is the wrong way round.
    /// </para>
    /// </summary>
    public static DateTimeOffset ScanAtOf(string action, string? detailsJson, DateTimeOffset createdAt)
    {
        if (!IsScan(action)) return createdAt;
        return Endpoints.DoorActivityView.ScannedAt(Endpoints.DoorActivityView.Details(detailsJson), createdAt);
    }

    /// <summary>
    /// The board a row is about, read out of the <c>device_id</c> every writer on these paths
    /// puts in its details. Null when the row carries none or its details will not parse.
    ///
    /// <para>
    /// There is no foreign key to read instead: <c>audit_log</c> is one append-only table for
    /// the whole product, and that is exactly why the tenant filter carries the whole weight
    /// of isolation here — a guid in a jsonb document proves nothing about whose board it is.
    /// </para>
    /// </summary>
    public static Guid? DeviceIdOf(JsonElement? details)
    {
        if (details is not { } root || root.ValueKind != JsonValueKind.Object) return null;
        if (!root.TryGetProperty("device_id", out var value) || value.ValueKind != JsonValueKind.String) return null;
        return Guid.TryParse(value.GetString(), out var id) ? id : null;
    }
}
