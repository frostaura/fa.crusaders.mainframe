using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// A player's OWN arrival on their seat (D11) — one rule for every path that records a member
/// identifying at a court box: the activation, a repeat scan of a live session, and a no-show
/// reversed by the box's late upload (review round 8, E8-1: the reversal stamped the booking and
/// no seat, so the page read "Checked in" above "0 of 2 players checked in").
/// </summary>
public static class SeatArrival
{
    /// <summary>
    /// Stamps <paramref name="userId"/>'s accepted seat on the booking with <paramref name="at"/>
    /// when it has one and it is not yet stamped. Staged, not saved; returns the seat it stamped,
    /// or null when nothing changed.
    /// </summary>
    public static async Task<BookingParticipant?> StampAsync(
        MainframeDbContext db, Guid bookingId, Guid userId, DateTimeOffset at, CancellationToken ct)
    {
        var seat = await db.BookingParticipants.FirstOrDefaultAsync(
            p => p.BookingId == bookingId && p.UserId == userId && p.Status == ParticipantStatus.Accepted, ct);
        if (seat is null || seat.CheckedInAt is not null) return null;
        seat.CheckedInAt = at;
        seat.UpdatedAt = StorableTime.UtcNow;
        return seat;
    }
}
