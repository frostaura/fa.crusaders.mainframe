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
        var events = other
            .Select(r => new
            {
                at = r.CreatedAt,
                action = r.Action,

                // `kind` stays for compatibility and is the coarse word; `change` is what
                // actually happened. Nine rows of "details or state were changed" were the
                // whole of a door's story and none of them said which one was the shut (A5).
                kind = DoorAuditActions.EventKindOf(r.Action),
                change = DoorAuditActions.ChangeOf(r.Action, Changes(r.DetailsJson)),

                // Null for the board's own rows, whose actor is Guid.Empty: nobody registered
                // it and nobody corrected its clock. See PersonNames.
                actor_name = PersonNames.Of(r.ActorUserId, actors),
            })
            .ToList();

        return Results.Ok(new { items, events });
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
