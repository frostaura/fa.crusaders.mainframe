using System.Globalization;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Review round 7 (E7-1, E7-3, E7-4): one fact, one row, one name. Each rule here exists because a
/// member's night told one thing twice, or something the server had refused, or one door four ways.
/// </summary>
public static partial class AdminMemberTraceAssembly
{
    /// <summary>
    /// Receipt verdicts that are NOT evidence of the booking's court being lit or measured: a relay
    /// wired to another court, a booking whose court is gone, a release the server could not pair.
    /// Every other verdict — the box really did drive that court's relay — is kept, including the
    /// ones the settlement declined to stamp (too early, after a cancel), because the lights did
    /// come on and the night is the record of what happened, not of what was charged.
    /// </summary>
    private static readonly string[] RefusedReceiptOutcomes = DeviceEventReceipt.RefusedOutcomes;

    /// <summary>A receipt and its server-written lights row are the same event when their instants agree to this.</summary>
    private static readonly TimeSpan TwinTolerance = TimeSpan.FromSeconds(1);

    /// <summary>
    /// Whether a <c>court.lights_on</c> / <c>court.lights_off</c> row is the server's own echo of a
    /// relay receipt already on this night (E7-1).
    ///
    /// <para>
    /// An uploaded activation writes a receipt at the SCAN's instant and, through the settlement,
    /// a <c>court.lights_on</c> row at the UPLOAD's — one lighting, two rows, minutes apart. The
    /// receipt is the measurement and keeps its place; the echo goes. Matched on booking, board
    /// and the event itself (the scan instant the settlement repeats, or the sequence number the
    /// late-evidence reversal repeats), so an ONLINE lighting — no receipt — keeps its row, and so
    /// does a second lighting of the same booking. A release is matched on booking, board and relay.
    /// </para>
    /// </summary>
    private static bool IsReceiptTwin(string action, JsonElement? details, Strands s)
    {
        var receiptKind = action switch
        {
            TraceKinds.LightsOnAction => DeviceEventEndpoints.ActivationKind,
            TraceKinds.LightsOffAction => DeviceEventEndpoints.ReleaseKind,
            _ => null,
        };
        if (receiptKind is null || s.Receipts.Count == 0) return false;

        var inner = Inner(details);
        if (GuidOf(inner, "booking_id") is not { } booking || DoorTrail.DeviceIdOf(details) is not { } device) return false;

        foreach (var r in s.Receipts)
        {
            if (r.Kind != receiptKind || r.BookingId != booking || r.DeviceId != device) continue;
            if (SameEvent(receiptKind, r, inner)) return true;
        }
        return false;
    }

    /// <summary>
    /// Review round 11, E11-3: whose code the board read for an ACTIVATION receipt, taken from its
    /// server-written <c>court.lights_on</c> twin — the row <see cref="IsReceiptTwin"/> drops. The
    /// receipt keeps its place as the measurement, but it knows no person, so a late check-in that
    /// reversed a refund read "reported by the court's board" while the twin named the scanner.
    /// </summary>
    private static Guid? TwinCodeHolderOf(ReceiptRow r, Strands s)
    {
        if (r.Kind != DeviceEventEndpoints.ActivationKind) return null;
        foreach (var row in s.Audit)
        {
            if (row.Action != TraceKinds.LightsOnAction) continue;
            var details = DoorActivityView.Details(row.DetailsJson);
            var inner = Inner(details);
            if (GuidOf(inner, "booking_id") != r.BookingId || DoorTrail.DeviceIdOf(details) != r.DeviceId) continue;
            if (SameEvent(r.Kind, r, inner) && GuidOf(inner, "identified_user_id") is { } holder) return holder;
        }
        return null;
    }

    /// <summary>The event half of <see cref="IsReceiptTwin"/>. Block body for the lizard reason.</summary>
    private static bool SameEvent(string receiptKind, ReceiptRow r, JsonElement? inner)
    {
        if (receiptKind == DeviceEventEndpoints.ReleaseKind)
        {
            return Text(inner, "relay") is not { } relay || relay == r.Relay?.ToString(CultureInfo.InvariantCulture);
        }
        if (Text(inner, "seq") is { } seq && seq == r.Seq.ToString(CultureInfo.InvariantCulture)) return true;
        return Text(inner, "occurred_at") is { } at
               && DateTimeOffset.TryParse(at, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var instant)
               && (instant - r.OccurredAt).Duration() <= TwinTolerance;
    }

    /// <summary>The nested <c>details</c> object a lights row's writer put its own facts in, or null.</summary>
    private static JsonElement? Inner(JsonElement? details)
    {
        if (details is not { } root || root.ValueKind != JsonValueKind.Object) return null;
        return root.TryGetProperty("details", out var inner) && inner.ValueKind == JsonValueKind.Object ? inner : null;
    }

    private static Guid? GuidOf(JsonElement? details, string key)
    {
        return Text(details, key) is { } text && Guid.TryParse(text, out var id) ? id : null;
    }

    /// <summary>A boolean field out of a details document; false when absent or not a boolean.</summary>
    private static bool Flag(JsonElement? details, string key)
    {
        if (details is not { } root || root.ValueKind != JsonValueKind.Object) return false;
        return root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.True;
    }

    /// <summary>
    /// What a door row calls its door (E7-4): the board's name NOW when the club still has it, else
    /// the name the row stored — and either way through <see cref="TraceKinds.DoorLabel"/>, the
    /// console's own rule, so an unnamed gate reads "Unnamed scanner (gate-…)" here as it does on
    /// the Doors page and never as the placeholder "Door gate".
    /// </summary>
    private static string? DoorLabelOf(JsonElement? details, Guid? deviceId, string? deviceCode, Strands s)
    {
        var name = deviceId is { } id && s.DeviceNames.TryGetValue(id, out var now) ? now : Text(details, "door_name");
        return TraceKinds.DoorLabel(name, deviceCode);
    }

    /// <summary>Where an audit row happened and, on a refused upload, the server's verdict (R12 E12-1 / D12-2).</summary>
    private sealed record RowPlace(TraceCourtRef? Court, string? CourtName, string? BoxName, string? Verdict, int? BoardCourt);

    /// <summary>
    /// R12 D12-2 / E12-1: a board row's court is the court its relay maps to — its stored
    /// <c>court</c> is the RELAY INDEX, never a court's name — and at no court the box is named; a
    /// verdict row carries the server's reason. Any other row as before.
    /// </summary>
    private static RowPlace PlaceOf(string action, JsonElement? details, Guid? deviceId, Strands s)
    {
        if (!IsBoardRow(action))
        {
            // R13 E13-8: a row that stored no court of its own names its booking's.
            var named = CourtOf(details, s.Courts) ?? CourtOfBooking(GuidOf(details, "booking_id"), s);
            return new RowPlace(named, named?.Name ?? Text(details, "court"), null, null, null);
        }
        var court = CourtOfBoard(details, deviceId, s);
        var verdict = action.StartsWith(VerdictPrefix, StringComparison.Ordinal) ? Text(details, "outcome") : null;
        return new RowPlace(court, court?.Name, court is null ? BoxLabelOf(deviceId, s) : null, verdict, court?.Number);
    }

    /// <summary>R12 E12-4: the <c>collision_booking_ids</c> a no-show reversal recorded, as strings; empty when none.</summary>
    private static List<string> CollisionIdsOf(JsonElement? details)
    {
        if (details is not { } root || root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("collision_booking_ids", out var ids) || ids.ValueKind != JsonValueKind.Array)
        {
            return [];
        }
        return [.. ids.EnumerateArray().Where(i => i.ValueKind == JsonValueKind.String).Select(i => i.GetString()!)];
    }

    /// <summary>A row an uploaded board event wrote (<c>device.*</c>): its <c>court</c> is a relay index and its instant is the scan's.</summary>
    private static bool IsBoardRow(string action) => action.StartsWith("device.", StringComparison.Ordinal);

    /// <summary>The verdict row of an uploaded activation the server did not accept: <c>device.activation_{outcome}</c>.</summary>
    private const string VerdictPrefix = TraceKinds.ActivationAction + "_";

    /// <summary>
    /// Review round 12, E12-1: when a row PRINTS. A board's uploaded row at the scan the box
    /// reported (<c>occurred_at</c>, as the door log does), never at the upload that delivered it
    /// minutes or hours later; every other row at its stored <see cref="AuditLog.ScanAt"/>.
    /// </summary>
    private static DateTimeOffset AtOf(AuditLog row, JsonElement? details)
    {
        return IsBoardRow(row.Action) ? DoorActivityView.ScannedAt(details, row.CreatedAt) : row.ScanAt;
    }

    /// <summary>
    /// Review round 12, D12-2 / E12-1: the court a board row happened at — the <c>court_number</c>
    /// the server stamped, else the row's relay index through the box's relay map — and never the
    /// relay index read as a court's name ("Checked in at 0", "Was refused at -1").
    /// </summary>
    private static TraceCourtRef? CourtOfBoard(JsonElement? details, Guid? deviceId, Strands s)
    {
        if (Text(details, "court_number") is { } stamped) return CourtOf(details, s.Courts) ?? CourtByNumber(stamped, s);
        if (deviceId is not { } id || !s.DeviceCourts.TryGetValue(id, out var map)) return null;
        if (Text(details, "court") is not { } text
            || !int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var relay)
            || relay < 0 || relay >= map.Count)
        {
            return null;
        }
        return CourtByNumber(map[relay].ToString(CultureInfo.InvariantCulture), s);
    }

    private static TraceCourtRef? CourtByNumber(string number, Strands s)
    {
        return int.TryParse(number, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n)
            ? s.Courts.Values.FirstOrDefault(c => c.Number == n)
            : null;
    }

    /// <summary>D12-2: a court box's name for a row at no court, or null when it carries only the auto-registration placeholder.</summary>
    private static string? BoxLabelOf(Guid? deviceId, Strands s)
    {
        if (deviceId is not { } id || !s.DeviceNames.TryGetValue(id, out var name)) return null;
        var trimmed = name?.Trim();
        return string.IsNullOrEmpty(trimmed) || trimmed == DeviceRegistryService.CourtBoxPlaceholderName ? null : trimmed;
    }

    /// <summary>A withdrawn seat a share row names: the partner, and when they withdrew (R13 E13-4).</summary>
    private sealed record Withdrawal(Guid UserId, DateTimeOffset At);

    /// <summary>The booking ids an audit row names — its own, and a displacement's cause (R13 E13-8).</summary>
    private static IEnumerable<Guid> AuditBookingIds(AuditLog row)
    {
        var details = DoorActivityView.Details(row.DetailsJson);
        if (GuidOf(details, "booking_id") is { } own) yield return own;
        if (GuidOf(details, "displaced_by_booking_id") is { } cause) yield return cause;
    }

    /// <summary>The organiser a partner's withdrawal names (C13-4's <c>organiser_user_id</c>), or null on any other row.</summary>
    private static Guid? OrganiserOf(AuditLog row)
    {
        // R14 E14-2: a removal, a split change and a cancelled game name the organiser the same way.
        if (row.Action is not (TraceKinds.PartnerWithdrewAction or TraceKinds.PlayerRemovedAction
            or TraceKinds.SplitChangedAction or TraceKinds.GameCancelledAction or TraceKinds.SettledOutsideAction
            or TraceKinds.ShareCollectedAction or TraceKinds.AddedByClubAction)) return null;
        return GuidOf(DoorActivityView.Details(row.DetailsJson), "organiser_user_id");
    }

    /// <summary>R13 E13-8: whose earlier booking displaced this one — its owner's name — on a displacement row; null otherwise.</summary>
    private static string? CauseOf(string action, JsonElement? details, Strands s)
    {
        if (action != "booking.displaced" || GuidOf(details, "displaced_by_booking_id") is not { } cause) return null;
        return s.BookingOwners.TryGetValue(cause, out var owner) ? PersonNames.Of(owner, s.Names) : null;
    }

    /// <summary>
    /// R13 E13-4: the withdrawn seats the member's share rows name — read off the rows' references
    /// (<c>share:{participant}:{seq}:out|in</c>), never guessed from the booking.
    /// </summary>
    private static async Task<Dictionary<Guid, Withdrawal>> WithdrawalsAsync(
        MainframeDbContext db, List<LedgerEntry> ledger, CancellationToken ct)
    {
        var seats = ledger.Select(l => SeatOf(l.ExternalReference)).Where(id => id is not null).Select(id => id!.Value).Distinct().ToList();
        if (seats.Count == 0) return [];
        var rows = await db.BookingParticipants.AsNoTracking()
            .Where(p => seats.Contains(p.Id) && p.Status == ParticipantStatus.Withdrawn && p.UserId != null && p.RespondedAt != null)
            .Select(p => new { p.Id, p.UserId, p.RespondedAt })
            .ToListAsync(ct);
        return rows.ToDictionary(p => p.Id, p => new Withdrawal(p.UserId!.Value, p.RespondedAt!.Value));
    }

    /// <summary>The seat a share reference names (<c>share:{participant:N}:…</c>), or null for any other reference.</summary>
    private static Guid? SeatOf(string? reference)
    {
        const string prefix = "share:";
        if (reference is null || !reference.StartsWith(prefix, StringComparison.Ordinal) || reference.Length < prefix.Length + 32) return null;
        return Guid.TryParseExact(reference.AsSpan(prefix.Length, 32), "N", out var id) ? id : null;
    }

    /// <summary>
    /// R13 E13-4: the partner whose withdrawal sent this share row back, or null. A return — out of the
    /// organiser's wallet, into the partner's — on a seat that is withdrawn, written at or after the
    /// withdrawal. Only the partner can withdraw their own seat, so the seat is the evidence of who did it;
    /// a payment before the withdrawal is not the withdrawal's.
    /// </summary>
    private static Guid? WithdrewOf(LedgerEntry row, Strands s)
    {
        if (row.Type != LedgerEntryType.ShareTransfer || SeatOf(row.ExternalReference) is not { } seat
            || !s.Withdrawals.TryGetValue(seat, out var w) || row.CreatedAt < w.At)
        {
            return null;
        }
        var returning = row.UserId == w.UserId ? row.AmountMinutes > 0 : row.AmountMinutes < 0;
        return returning ? w.UserId : null;
    }

    /// <summary>
    /// The member's ledger rows plus the OTHER half of each share transfer among them (E7-3).
    ///
    /// <para>
    /// A share is two rows — out of one wallet, into another. The night read the second half only
    /// when this member was its actor, so a share they PAID showed both halves and the automatic
    /// RETURN of it (the system's act) showed one. Every share now shows its counterpart, named in
    /// words and carrying no amount in this member's column.
    /// </para>
    /// </summary>
    private static async Task<List<LedgerEntry>> WithShareTwinsAsync(
        MainframeDbContext db, Guid userId, List<LedgerEntry> rows, CancellationToken ct)
    {
        var twinRefs = rows
            .Where(r => r.UserId == userId && r.Type == LedgerEntryType.ShareTransfer && r.ExternalReference is not null)
            .Select(r => LedgerRowMapper.TwinOf(r.ExternalReference!))
            .Where(t => t is not null)
            .Select(t => t!)
            .Distinct()
            .ToList();
        if (twinRefs.Count == 0) return rows;

        var have = rows.Select(r => r.Id).ToHashSet();
        var twins = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.ExternalReference != null && twinRefs.Contains(l.ExternalReference))
            .ToListAsync(ct);
        var added = twins.Where(t => have.Add(t.Id)).ToList();
        if (added.Count == 0) return rows;

        return [.. rows.Concat(added).OrderBy(r => r.CreatedAt).ThenBy(r => r.Id)];
    }
}
