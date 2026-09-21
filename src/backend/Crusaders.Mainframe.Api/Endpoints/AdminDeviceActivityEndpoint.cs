using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// What one board has been doing — the reader the door's audit trail did not have.
///
/// <para>
/// <b>A door leaves no other record.</b> <c>door-gate.md</c> §5 argues that the audit row
/// matters more than a court box's equivalent precisely because there is no ledger entry, no
/// booking and no receipt to reconstruct an open from afterwards, and that "nobody could get
/// in through the side door all Tuesday" is a question the desk will eventually ask. It then
/// shipped with no API route reading <c>audit_log</c> at all, so the only way to ask it was a
/// database client. Four sentences in that spec assumed this route existed.
/// </para>
///
/// <para>
/// <b>It is the BOARD's trail and not a door-opens feed</b> — but the two halves are now two
/// ARRAYS rather than one list a console has to sort out for itself. An open, a refusal and
/// its reason, and an open the board decided for itself are <c>items</c>: they are scans, and
/// they are the same set the club log, the CSV, the day counts and both member routes read
/// (<see cref="DoorTrail.IsScanRow"/>). The row that says the board registered itself, the row
/// that says an admin renamed it, the row that says the server overruled its clock, are
/// <c>events</c>: the board's own story, each under a neutral word, none of them counted.
/// </para>
///
/// <para>
/// <b>One list was a screen that lied, and quietly.</b> This route returned every audit row
/// carrying the board's <c>device_id</c>, and a console renders a row it has no chip for
/// through whatever branch is last — so <c>device.updated</c> read as a green "Refused" scan,
/// a door with thirteen admin edits and no scans reported "13 refused scans, newest 1 min ago"
/// while the club log had nothing for it, and <c>device.event_time_clamped</c> — written beside
/// every clamped upload with identical details — doubled every offline scan on this screen and
/// nowhere else. Four readers of one set disagreeing is exactly what <see cref="DoorTrail"/>
/// exists to prevent, and this was the reader that was not asking it.
/// </para>
///
/// <para>
/// <b>Nothing about the trail's own shape is exposed.</b> <c>DetailsJson</c> is never returned
/// — it carries the club's internal device id, the gate key and a court box's relay and
/// booking ids — and the fingerprint is <i>validated to be one</i> rather than forwarded. That
/// second guard is not theoretical: rows written before the fingerprint existed hold a live
/// access code in <c>subject</c> in full, <c>RetentionWorker</c> anonymises a row's subject
/// and never touches its details, and a reader that trusted the field would have published
/// every one of those to the console on the day it shipped.
/// </para>
/// </summary>
public static class AdminDeviceActivityEndpoint
{
    /// <summary>Rows returned when the caller does not ask for a number. A console page.</summary>
    public const int DefaultLimit = 50;

    /// <summary>
    /// Most rows one request will return. Bounded because this is an append-only table with no
    /// retention of its own (see the residual in <c>door-gate.md</c> §6): a busy club's door
    /// accumulates rows indefinitely, and an unbounded read of it is a request that times out
    /// and gets retried.
    /// </summary>
    public const int MaxLimit = 200;

    /// <summary>
    /// <c>GET /api/v1/admin/devices/{id}/activity?limit=</c>.
    ///
    /// <para>
    /// 404 rather than 403 for a board belonging to another club: whether a device id exists
    /// at all is itself a fact about that tenant, and the lookup is tenant-filtered by the
    /// context's global query filter rather than by a claim compared here.
    /// </para>
    ///
    /// <para>
    /// <b>The limit is clamped rather than refused.</b> A console asking for a million rows is
    /// a mistake to bound; answering 400 would give an admin an error screen where they wanted
    /// a list, and the request is unambiguous.
    /// </para>
    /// </summary>
    public static async Task<IResult> HandleAsync(
        Guid id, int? limit, MainframeDbContext db, DeviceRegistryService devices, CancellationToken ct)
    {
        var device = await devices.FindAsync(id, ct);
        if (device is null) return Results.NotFound();

        var take = Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit);

        // Rows are attributed to a board by the `device_id` every writer on these paths puts
        // in its details — DeviceGateEndpoint, DeviceEventEndpoints and DeviceRegistryService
        // all write it, and there is no foreign key to read instead because `audit_log` is one
        // append-only table for the whole product. `@>` on the jsonb column rather than a LIKE
        // over its text, so a guid that happened to appear in some other field cannot match.
        var containment = JsonSerializer.Serialize(new { device_id = device.Id });

        var mine = db.AuditLogs.AsNoTracking()
            .Where(a => a.DetailsJson != null && EF.Functions.JsonContains(a.DetailsJson, containment));

        // The split is a DOOR's. A court box's trail is activations, releases and the outcomes
        // they settled — none of those is a door scan, and filtering its feed by the door
        // predicate would empty the only screen that reads it. `events` is still on the wire
        // for a box, empty, because one response shape is worth more to a console than a key
        // that appears and disappears; see DeviceView's own note on the same argument.
        var isDoor = device.Kind == DeviceKind.Gate;

        // TWO pages, not one page split afterwards. A door that has been renamed fifty times
        // would otherwise push every scan off a `limit=50` request and leave the page reporting
        // no activity at a busy door — the limit is what a console asks for of EACH list.
        var scans = await Page(isDoor ? mine.Where(DoorTrail.IsScanRow) : mine, take, ct);
        var other = isDoor ? await Page(mine.Where(DoorTrail.IsNotScanRow), take, ct) : [];

        // One read for the whole page rather than one per row, and the name comes from the
        // membership because that is the only name this product shows another person. Only the
        // scans can name anybody: a door event is about the BOARD.
        var names = await PersonNames.ForAsync(db, scans.Select(r => r.SubjectUserId), ct);

        var items = scans
            .Select(r => Item(r.Action, r.CreatedAt, r.SubjectUserId, r.DetailsJson, names))
            .ToList();

        // Who made each of the board's own changes, in one read for the page.
        //
        // THE SUBJECT AND THE ACTOR ARE DIFFERENT PEOPLE AND DIFFERENT RULES. A scan's subject
        // is the member at the door and reaches only that member's own history and the club log;
        // an event's actor is the ADMIN who changed the row, and naming them here is the club's
        // own admin audit — the trail the product has always promised as {actor, subject} —
        // not member tracking. P4 is untouched: an event still carries no member, no
        // fingerprint and no code.
        var actors = await PersonNames.ForAsync(db, other.Select(r => (Guid?)r.ActorUserId), ct);

        // The other half, in its own array and its own vocabulary. See DoorAuditActions for the
        // closed sets of words and why the lists exist.
        var events = Grouped(other, actors);

        return Results.Ok(new { items, events });
    }

    /// <summary>
    /// The board's own story, newest first, with runs of the identical event collapsed into one
    /// entry carrying a <c>count</c>.
    ///
    /// <para>
    /// <b>Nine rows saying "the clock was corrected", all at 19:22 (A-L4).</b> One upload of a
    /// batch from a board whose uptime counter has gone wrong writes one
    /// <c>device.event_time_clamped</c> PER EVENT — that is right, each clamp is a fact about a
    /// different scan — and the feed then rendered nine identical lines a second apart. A door's
    /// feed is read to find the one row that explains something, and nine copies of one row is
    /// the shape that buries it; it is the same complaint A5 made about "details or state were
    /// changed" arriving from the other direction.
    /// </para>
    ///
    /// <para>
    /// <b>Adjacent, same kind, same actor, same MINUTE.</b> Adjacency is what keeps this a
    /// display grouping rather than an aggregation: a run is only ever collapsed with itself, so
    /// nothing is hidden behind anything and the order is untouched. The minute is the
    /// resolution the feed prints, so two entries that would render the same timestamp are the
    /// two this may merge — grouping across a wider window would collapse a clock correction at
    /// 19:22 with an unrelated one at 19:41 and assert they were one event.
    /// </para>
    ///
    /// <para>
    /// <c>at</c> is the NEWEST of the run, which is the row's own position in the list.
    /// <c>count</c> is always present and is 1 on an ordinary entry, because a key that appears
    /// and disappears is a second response shape wearing one name — the argument
    /// <c>DeviceView</c> already makes about the door-card fields on a court box.
    /// </para>
    /// </summary>
    private static List<object> Grouped(
        List<ActivityRow> rows, IReadOnlyDictionary<Guid, string> actors)
    {
        var events = new List<object>();
        var index = 0;

        while (index < rows.Count)
        {
            var row = rows[index];
            var changes = Changes(row.DetailsJson);
            var kind = DoorAuditActions.EventKindOf(row.Action, changes);
            var actor = PersonNames.Of(row.ActorUserId, actors);

            var run = 1;
            while (index + run < rows.Count && SameEvent(row, kind, actor, rows[index + run], actors)) run++;

            events.Add(new
            {
                at = row.CreatedAt,
                action = row.Action,

                // The word a console renders, now the FINE one (WIRE-R3 §6). `change` keeps its
                // own older vocabulary beside it for callers written against it; see
                // DoorAuditActions.EventKinds.
                kind,
                change = DoorAuditActions.ChangeOf(row.Action, changes),

                // Null for the board's own rows, whose actor is Guid.Empty: nobody registered
                // it and nobody corrected its clock. See PersonNames.
                actor_name = actor,

                // How many identical rows this entry stands for. Always present; 1 is the
                // ordinary case. See the summary.
                count = run,

                // The OLDEST of the run, so a collapsed entry can say "×9, 19:22–19:23" rather
                // than pretending the nine happened at one instant. Equal to `at` when count is
                // 1, which is the same one-shape argument as `count` itself.
                from = rows[index + run - 1].CreatedAt,
            });

            index += run;
        }

        return events;
    }

    /// <summary>
    /// Whether <paramref name="candidate"/> is another instance of the same event as the run's
    /// head — same word, same actor, same printed minute. Block body for the lizard reason in
    /// <c>memory/gotchas.md</c>.
    /// </summary>
    private static bool SameEvent(
        ActivityRow head, string kind, string? actor, ActivityRow candidate,
        IReadOnlyDictionary<Guid, string> actors)
    {
        if (DoorAuditActions.EventKindOf(candidate.Action, Changes(candidate.DetailsJson)) != kind) return false;
        if (PersonNames.Of(candidate.ActorUserId, actors) != actor) return false;

        return head.CreatedAt.UtcDateTime.ToString("yyyyMMddHHmm", System.Globalization.CultureInfo.InvariantCulture)
               == candidate.CreatedAt.UtcDateTime.ToString("yyyyMMddHHmm", System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// The <c>changes</c> list a <c>device.updated</c> row recorded, or empty — which is what
    /// every row written before that list existed looks like, and is why
    /// <see cref="DoorAuditActions.OtherChange"/> exists rather than a guess.
    /// </summary>
    private static IReadOnlyCollection<string> Changes(string? detailsJson)
    {
        if (DoorActivityView.Details(detailsJson) is not { } root) return [];
        if (root.ValueKind != JsonValueKind.Object) return [];
        if (!root.TryGetProperty("changes", out var list) || list.ValueKind != JsonValueKind.Array) return [];

        return list.EnumerateArray()
            .Where(e => e.ValueKind == JsonValueKind.String)
            .Select(e => e.GetString()!)
            .ToList();
    }

    /// <summary>
    /// One page of a board's trail, newest first. Block body for the lizard reason in
    /// <c>memory/gotchas.md</c>.
    /// </summary>
    private static async Task<List<ActivityRow>> Page(IQueryable<AuditLog> rows, int take, CancellationToken ct)
    {
        return await rows
            .OrderByDescending(a => a.CreatedAt)
            .ThenByDescending(a => a.Id)
            .Take(take)
            .Select(a => new ActivityRow(a.Action, a.CreatedAt, a.SubjectUserId, a.DetailsJson, a.ActorUserId))
            .ToListAsync(ct);
    }

    /// <summary>
    /// One row as the console reads it.
    ///
    /// <para>
    /// The six field rules — the two reason vocabularies, the <c>seq</c>-keyed offline test,
    /// the name-only member and the validated fingerprint — moved to
    /// <see cref="DoorActivityView"/> when the club's door log (W1.3) became a second reader
    /// of the same rows. They are not restated here: two copies of "is this string a
    /// fingerprint or a live access code" is one copy more than a privacy check should have.
    /// </para>
    /// </summary>
    private static object Item(
        string action, DateTimeOffset at, Guid? subjectUserId, string? detailsJson,
        IReadOnlyDictionary<Guid, string> names)
    {
        return DoorActivityView.Of(action, at, subjectUserId, detailsJson, names);
    }
}

/// <summary>
/// One board-trail row as it comes off the database, before either projection reads it.
/// Top-level and bodyless for the lizard reason recorded in <c>memory/gotchas.md</c>.
/// </summary>
public sealed record ActivityRow(
    string Action, DateTimeOffset CreatedAt, Guid? SubjectUserId, string? DetailsJson, Guid ActorUserId);
