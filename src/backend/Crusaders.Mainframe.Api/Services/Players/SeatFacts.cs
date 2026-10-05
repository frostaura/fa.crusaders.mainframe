using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>Who took a seat off its game, off the <c>players.removed</c> record (R14 E14-2).</summary>
public sealed record SeatRemoval(Guid? ActorUserId, bool ByClub);

/// <summary>
/// What a share movement's receipts need to know of its seat: whether the partner withdrew (R13
/// E13-4), the seat to link them to once they are off the game (J13-3), its status — which tells a
/// plain return's cause apart (R14 X14-2) — and, for a seat taken off, who took it off.
/// </summary>
public sealed record SeatFacts(bool Withdrew, Guid? OffGame, ParticipantStatus? Status, SeatRemoval? Removal)
{
    /// <summary>The audit action a seat's removal writes, by the organiser or the club (R14 E14-2).</summary>
    public const string RemovedAction = "players.removed";

    /// <summary>
    /// The facts for <paramref name="move"/>'s seat. A plain return (neither the club's hand,
    /// <paramref name="club"/>, nor a club refund, <paramref name="refund"/>) on a removed seat reads
    /// the removal's record, so a return that waited for cover still says whose removal it was.
    /// </summary>
    public static async Task<SeatFacts> ReadAsync(MainframeDbContext db, ShareMove move, ClubReceipt? club, string? refund, CancellationToken ct)
    {
        var seat = await db.BookingParticipants.AsNoTracking().FirstOrDefaultAsync(p => p.Id == move.ParticipantId, ct);
        if (seat is null) return new SeatFacts(false, null, null, null);
        if (seat.IsLive) return new SeatFacts(false, null, seat.Status, null);
        var plainReturn = club is null && refund is null && move.Delta < 0;
        var removal = plainReturn && seat.Status == ParticipantStatus.Removed ? await RemovalOfAsync(db, seat, ct) : null;
        return new SeatFacts(plainReturn && seat.Status == ParticipantStatus.Withdrawn, seat.Id, seat.Status, removal);
    }

    /// <summary>The newest <see cref="RemovedAction"/> row naming this seat, or null when there is none (a removal before R14).</summary>
    private static async Task<SeatRemoval?> RemovalOfAsync(MainframeDbContext db, BookingParticipant seat, CancellationToken ct)
    {
        var rows = db.AuditLogs.AsNoTracking()
            .Where(a => a.Action == RemovedAction && a.SubjectUserId == seat.UserId && a.DetailsJson != null);
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
        return new SeatRemoval(row.ActorUserId == Guid.Empty ? null : row.ActorUserId, byClub);
    }
}
