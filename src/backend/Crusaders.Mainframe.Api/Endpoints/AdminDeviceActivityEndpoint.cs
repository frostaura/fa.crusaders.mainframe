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
    /// One row as the console reads it. Block body rather than an expression one for the
    /// lizard reason recorded in <c>memory/gotchas.md</c>.
    /// </summary>
    private static object Item(
        string action, DateTimeOffset at, Guid? subjectUserId, string? detailsJson,
        IReadOnlyDictionary<Guid, string> names)
    {
        var details = Details(detailsJson);
        return new
        {
            at,
            action,
            reason = Reason(details),
            offline = Offline(details),
            member = Member(subjectUserId, names),
            fingerprint = Fingerprint(details),
        };
    }

    /// <summary>
    /// The row's details as a readable element, or null when there are none or they will not
    /// parse. A row whose details are malformed is still listed — the row is the evidence, and
    /// refusing to show it because a field cannot be read is the wrong way round.
    /// </summary>
    private static JsonElement? Details(string? detailsJson)
    {
        if (string.IsNullOrWhiteSpace(detailsJson)) return null;
        try
        {
            return JsonDocument.Parse(detailsJson).RootElement.Clone();
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Why, in the vocabulary the row was written in: a gate decision's <c>reason</c>, an
    /// uploaded event's <c>outcome</c>, or null for a row that decided nothing — a
    /// registration, an admin edit.
    ///
    /// <para>
    /// The two field names are not unified here and deliberately not. They are written by two
    /// different paths about two different things — a refusal the API decided, and what the
    /// server made of something a board had already done — and a reader that renamed one to
    /// the other would be asserting they are the same kind of fact. The console's dictionary
    /// covers both sets; see <c>door-gate.md</c> §5's Reasons table and §6's outcomes.
    /// </para>
    /// </summary>
    private static string? Reason(JsonElement? details)
    {
        if (details is not { } root) return null;
        if (Text(root, "reason") is { } reason) return reason;
        return Text(root, "outcome");
    }

    /// <summary>
    /// Whether this row records something the BOARD decided on its own.
    ///
    /// <para>
    /// Keyed on the presence of <c>seq</c>, which is the event's own sequence number and is
    /// written by exactly one path — <c>POST /device/events</c>, the queue a board drains
    /// after the fact. Keying it on the action's prefix instead would have called an admin's
    /// <c>device.updated</c> an offline open, and keying it on the kind would need a list that
    /// goes stale the first time a board learns a new one.
    /// </para>
    /// </summary>
    private static bool Offline(JsonElement? details) =>
        details is { } root && root.ValueKind == JsonValueKind.Object && root.TryGetProperty("seq", out _);

    /// <summary>Who the row named, with the name the club knows them by — or null.</summary>
    private static object? Member(Guid? subjectUserId, IReadOnlyDictionary<Guid, string> names)
    {
        if (subjectUserId is not { } id || id == Guid.Empty) return null;
        return new { id, name = names.TryGetValue(id, out var name) ? name : "" };
    }

    /// <summary>Eight lowercase hex characters, or null. See the type summary for why this is checked and not trusted.</summary>
    private static string? Fingerprint(JsonElement? details)
    {
        if (details is not { } root || Text(root, "subject") is not { } subject) return null;
        if (subject.Length != 8) return null;

        foreach (var ch in subject)
        {
            if (!char.IsAsciiDigit(ch) && ch is not (>= 'a' and <= 'f')) return null;
        }
        return subject;
    }

    private static string? Text(JsonElement root, string name)
    {
        if (root.ValueKind != JsonValueKind.Object) return null;
        return root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }
}
