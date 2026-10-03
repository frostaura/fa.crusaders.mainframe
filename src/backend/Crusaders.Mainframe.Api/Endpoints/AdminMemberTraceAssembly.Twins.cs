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
    private static readonly string[] RefusedReceiptOutcomes = ["wrong_court", "unresolved", "unpaired"];

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
