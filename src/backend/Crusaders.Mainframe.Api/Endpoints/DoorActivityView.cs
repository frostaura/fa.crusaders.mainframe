using System.Text.Json;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// One <c>audit_log</c> row as a console reads it — the projection shared by the per-board
/// feed and the club's door log.
///
/// <para>
/// <b>It was written once and is now read twice, which is why it moved here.</b>
/// <c>AdminDeviceActivityEndpoint</c> owned every rule below; the club log (W1.3) asks the
/// same six questions of the same rows and W1.3 says in words to reuse that projection rather
/// than write a second one. Two copies of "is this string a fingerprint or a live access code"
/// is one copy more than a privacy check should ever have.
/// </para>
///
/// <para>
/// <b>Nothing about the trail's own shape is exposed.</b> <c>DetailsJson</c> is never
/// returned — it carries the club's internal device id, the gate key and a court box's relay
/// and booking ids — and the fingerprint is <i>validated to be one</i> rather than forwarded.
/// That second guard is not theoretical: rows written before the fingerprint existed hold a
/// live access code in <c>subject</c> in full, <c>RetentionWorker</c> anonymises a row's
/// subject and never touches its details, and a reader that trusted the field would have
/// published every one of those to the console on the day it shipped.
/// </para>
/// </summary>
public static class DoorActivityView
{
    /// <summary>
    /// The per-board feed's entry — six keys, exactly as
    /// <c>GET /api/v1/admin/devices/{id}/activity</c> has always answered.
    /// </summary>
    public static object Of(
        string action, DateTimeOffset at, Guid? subjectUserId, string? detailsJson,
        IReadOnlyDictionary<Guid, string> names)
    {
        var details = Details(detailsJson);
        return new
        {
            at = ScannedAt(details, at),
            delivered_at = DeliveredAt(details, at),
            action,
            reason = Reason(details),
            offline = Offline(details),
            member = Member(subjectUserId, names),
            fingerprint = Fingerprint(details),
        };
    }

    /// <summary>
    /// The club log's entry — the same six keys and the door the row belongs to, because the
    /// log spans every door and a row with no door on it is unreadable there.
    ///
    /// <para>
    /// Written out beside <see cref="Of"/> rather than composed with it because an anonymous
    /// type cannot be extended; the two are adjacent so a change to one is a change somebody
    /// is looking at, and
    /// <c>AdminDoorLogHttpTests.A_club_log_row_and_a_board_feed_row_agree_on_every_shared_key</c>
    /// is what actually holds them together.
    /// </para>
    /// </summary>
    public static object WithDoor(
        string action, DateTimeOffset at, Guid? subjectUserId, string? detailsJson,
        IReadOnlyDictionary<Guid, string> names, object? door)
    {
        var details = Details(detailsJson);
        return new
        {
            at = ScannedAt(details, at),
            delivered_at = DeliveredAt(details, at),
            action,
            reason = Reason(details),
            offline = Offline(details),
            member = Member(subjectUserId, names),
            fingerprint = Fingerprint(details),
            door,
        };
    }

    /// <summary>
    /// When somebody stood at the door — which for an offline row is NOT when the row was
    /// written.
    ///
    /// <para>
    /// <b>The two instants were one field, and the field held the wrong one.</b> A board that
    /// loses the network decides scans from its cache and uploads them when it comes back, so
    /// the audit row is created at the upload; the scan's own instant is on the row as
    /// <c>occurred_at</c>, which the upload path has written since it shipped and no reader
    /// looked at. W1.2 says offline opens are scan-time stamped, and a club reading a 06:40
    /// entry as 09:00 has the wrong answer to the only question it asked.
    /// </para>
    ///
    /// <para>
    /// Falls back to the row's own instant, which is right for every online row — the server
    /// decided it as it wrote it — and is the only honest answer for an offline row whose
    /// details will not parse.
    /// </para>
    /// </summary>
    public static DateTimeOffset ScannedAt(JsonElement? details, DateTimeOffset createdAt)
    {
        if (!Offline(details)) return createdAt;
        return Instant(details, "occurred_at") ?? createdAt;
    }

    /// <summary>
    /// When the club heard about it — the row's own instant, on offline rows only.
    ///
    /// <para>
    /// Null on an online row rather than a copy of <see cref="ScannedAt"/>, because a page
    /// showing a delivery time for a decision the server made as it happened would be
    /// inventing a delay. An upload IS contact — it moves <c>LastSeenAt</c> like a heartbeat
    /// does — so this is also the instant that reconciles "last heard from" with a row the
    /// board reported hours after the fact.
    /// </para>
    /// </summary>
    public static DateTimeOffset? DeliveredAt(JsonElement? details, DateTimeOffset createdAt)
    {
        if (!Offline(details)) return null;
        return createdAt;
    }

    /// <summary>An instant property of the details, or null when it is absent or is not one.</summary>
    public static DateTimeOffset? Instant(JsonElement? details, string name)
    {
        if (details is not { } root || root.ValueKind != JsonValueKind.Object) return null;
        if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String) return null;
        return DateTimeOffset.TryParse(
            value.GetString(), System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.RoundtripKind, out var parsed)
            ? parsed
            : null;
    }

    /// <summary>
    /// The row's details as a readable element, or null when there are none or they will not
    /// parse. A row whose details are malformed is still listed — the row is the evidence, and
    /// refusing to show it because a field cannot be read is the wrong way round.
    /// </summary>
    public static JsonElement? Details(string? detailsJson)
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
    public static string? Reason(JsonElement? details)
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
    ///
    /// <para>
    /// Block body, not an expression one: lizard's C# parser mis-scopes an expression-bodied
    /// member containing braces — <c>details is { } root</c> is enough — into a <c>*global*</c>
    /// pseudo-function the length of the file, which then fails the length gate. See
    /// <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    public static bool Offline(JsonElement? details)
    {
        return details is { } root
            && root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("seq", out _);
    }

    /// <summary>Who the row named, with the name the club knows them by — or null.</summary>
    public static object? Member(Guid? subjectUserId, IReadOnlyDictionary<Guid, string> names)
    {
        if (subjectUserId is not { } id || id == Guid.Empty) return null;
        return new { id, name = names.TryGetValue(id, out var name) ? name : "" };
    }

    /// <summary>Eight lowercase hex characters, or null. See the type summary for why this is checked and not trusted.</summary>
    public static string? Fingerprint(JsonElement? details)
    {
        if (details is not { } root || Text(root, "subject") is not { } subject) return null;
        if (subject.Length != 8) return null;

        foreach (var ch in subject)
        {
            if (!char.IsAsciiDigit(ch) && ch is not (>= 'a' and <= 'f')) return null;
        }
        return subject;
    }

    /// <summary>A string property of the details, or null when it is absent or is not a string.</summary>
    public static string? Text(JsonElement root, string name)
    {
        if (root.ValueKind != JsonValueKind.Object) return null;
        return root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }
}
