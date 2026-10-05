using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>Who changed a seat, off its record — <c>players.removed</c> or <c>players.split_changed</c> (R14 E14-2).</summary>
public sealed record SeatAct(Guid? ActorUserId, bool ByClub);

/// <summary>
/// What a share movement's receipts need to know of its seat: whether the partner withdrew (R13
/// E13-4), the seat to link them to once they are off the game (J13-3), its status, whether the
/// club recorded it settled outside the app, and — off the record, never assumed — who removed the
/// seat or changed the split. A plain return's cause is decided from these (R14 X14-2, review M1/L1).
/// </summary>
public sealed record SeatFacts(bool Withdrew, Guid? OffGame, ParticipantStatus? Status, SeatAct? Removal)
{
    /// <summary>The audit action a seat's removal writes, by the organiser or the club (R14 E14-2).</summary>
    public const string RemovedAction = "players.removed";

    /// <summary>The audit action a split change writes per partner whose share moved (R14 E14-2).</summary>
    public const string SplitChangedAction = "players.split_changed";

    /// <summary>The club recorded this seat's share as paid outside the app (review M1).</summary>
    public bool SettledOutside { get; init; }

    /// <summary>
    /// The split change that explains this return: its record, newer than every share movement on
    /// the seat — so a later desk adjustment to the booking is not read as the organiser's (M1).
    /// </summary>
    public SeatAct? Split { get; init; }

    /// <summary>
    /// The facts for <paramref name="move"/>'s seat. On a plain return (neither the club's hand,
    /// <paramref name="club"/>, nor a club refund, <paramref name="refund"/>) the removal or split
    /// record is read, so a return that waited for cover still says whose act it was — and one with
    /// no record names nobody (a removal before R14).
    /// </summary>
    public static async Task<SeatFacts> ReadAsync(MainframeDbContext db, ShareMove move, ClubReceipt? club, string? refund, CancellationToken ct)
    {
        var seat = await db.BookingParticipants.AsNoTracking().FirstOrDefaultAsync(p => p.Id == move.ParticipantId, ct);
        if (seat is null) return new SeatFacts(false, null, null, null);
        var plainReturn = club is null && refund is null && move.Delta < 0;
        if (seat.IsLive)
        {
            var split = plainReturn && seat.SettledOutsideAt is null ? await SplitOfAsync(db, seat, ct) : null;
            return new SeatFacts(false, null, seat.Status, null) { SettledOutside = seat.SettledOutsideAt is not null, Split = split };
        }
        var removal = plainReturn && seat.Status == ParticipantStatus.Removed ? await RecordOfAsync(db, RemovedAction, seat, ct) : null;
        return new SeatFacts(plainReturn && seat.Status == ParticipantStatus.Withdrawn, seat.Id, seat.Status, removal?.Act);
    }

    /// <summary>The seat's newest split-change record, when no share has moved on the seat since it — else null.</summary>
    private static async Task<SeatAct?> SplitOfAsync(MainframeDbContext db, BookingParticipant seat, CancellationToken ct)
    {
        if (await RecordOfAsync(db, SplitChangedAction, seat, ct) is not { } split) return null;
        var prefix = ShareLedger.Prefix(seat.Id);
        var lastMove = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.UserId == seat.UserId && l.Type == LedgerEntryType.ShareTransfer
                        && l.ExternalReference != null && l.ExternalReference.StartsWith(prefix))
            .MaxAsync(l => (DateTimeOffset?)l.CreatedAt, ct);
        return lastMove is { } moved && moved > split.At ? null : split.Act;
    }

    /// <summary>
    /// R15 J15-1: who took this seat off the game, for its member — <c>"club"</c> or
    /// <c>"organiser"</c> off the removal's record; null for a seat that was not removed, and for a
    /// removal from before the record existed (the reader then says neither).
    /// </summary>
    public static async Task<string?> RemovedByAsync(MainframeDbContext db, BookingParticipant seat, CancellationToken ct)
    {
        if (seat.Status != ParticipantStatus.Removed || seat.UserId is null) return null;
        var record = await RecordOfAsync(db, RemovedAction, seat, ct);
        return record is not { } r ? null : r.Act.ByClub ? "club" : "organiser";
    }

    /// <summary>
    /// R15 J15-1: the CLUB put this seat on the game — an admin's add records the admin as the
    /// inviter, where the organiser's own add records the organiser. A guest seat is never asked.
    /// </summary>
    public static bool AddedByClub(Booking booking, BookingParticipant seat) =>
        seat.Seat > 1 && seat.GuestName is null && seat.InvitedByUserId is { } by && by != Guid.Empty && by != booking.UserId;

    /// <summary>The newest <paramref name="action"/> row naming this seat and when it was written, or null when there is none.</summary>
    private static async Task<(SeatAct Act, DateTimeOffset At)?> RecordOfAsync(MainframeDbContext db, string action, BookingParticipant seat, CancellationToken ct)
    {
        var rows = db.AuditLogs.AsNoTracking()
            .Where(a => a.Action == action && a.SubjectUserId == seat.UserId && a.DetailsJson != null);
        AuditLog? row;
        if (db.Database.IsNpgsql())
        {
            var containment = JsonSerializer.Serialize(new { participant_id = seat.Id });
            row = await rows.Where(a => EF.Functions.JsonContains(a.DetailsJson!, containment))
                .OrderByDescending(a => a.CreatedAt).FirstOrDefaultAsync(ct);
        }
        else
        {
            // The unit suites' in-memory provider has no jsonb containment: the same filter, client side.
            var id = seat.Id.ToString();
            row = (await rows.ToListAsync(ct)).Where(a => a.DetailsJson!.Contains(id, StringComparison.OrdinalIgnoreCase)).MaxBy(a => a.CreatedAt);
        }
        if (row is null) return null;
        using var doc = JsonDocument.Parse(row.DetailsJson!);
        var byClub = doc.RootElement.TryGetProperty("by_club", out var b) && b.ValueKind == JsonValueKind.True;
        return (new SeatAct(row.ActorUserId == Guid.Empty ? null : row.ActorUserId, byClub), row.CreatedAt);
    }
}
