using System.Text.Json;
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
/// <b>It is the BOARD's trail and not a door-opens feed.</b> An open, a refusal and its
/// reason, an open the board decided for itself while the link was down, the row that says
/// the board registered itself, the row that says an admin named it: they answer one question
/// between them, and splitting them across two screens would mean an admin diagnosing a door
/// has to know which half to look in before they know what is wrong.
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

        var rows = await db.AuditLogs.AsNoTracking()
            .Where(a => a.DetailsJson != null && EF.Functions.JsonContains(a.DetailsJson, containment))
            .OrderByDescending(a => a.CreatedAt)
            .ThenByDescending(a => a.Id)
            .Take(take)
            .Select(a => new { a.Action, a.CreatedAt, a.SubjectUserId, a.DetailsJson })
            .ToListAsync(ct);

        // One read for the whole page rather than one per row, and the name comes from the
        // membership because that is the only name this product shows another person.
        var subjects = rows.Where(r => r.SubjectUserId is not null).Select(r => r.SubjectUserId!.Value).Distinct().ToList();
        var names = await db.Memberships.AsNoTracking()
            .Where(m => subjects.Contains(m.UserId))
            .Select(m => new { m.UserId, m.FullName })
            .ToDictionaryAsync(m => m.UserId, m => m.FullName, ct);

        var items = rows
            .Select(r => Item(r.Action, r.CreatedAt, r.SubjectUserId, r.DetailsJson, names))
            .ToList();

        return Results.Ok(new { items });
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
