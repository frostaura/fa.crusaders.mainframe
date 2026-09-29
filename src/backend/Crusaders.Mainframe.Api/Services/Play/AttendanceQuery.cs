using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// One attended booking from one member's point of view — a <b>session</b> (§1).
/// </summary>
/// <param name="EvidenceAt">The member's own seat check-in when set, else the booking's — what orders sessions (§5.6).</param>
/// <param name="PlayedMinutes"><c>max(0, min(EndsAt, CancelledAt ?? EndsAt) − StartsAt)</c> in whole minutes.</param>
/// <param name="OtherPlayers">The OTHER members who were players of the booking (§5.1 <c>partners</c>).</param>
public sealed record AttendedSession(
    Guid BookingId, DateTimeOffset StartsAt, DateTimeOffset EvidenceAt, int PlayedMinutes, IReadOnlyList<Guid> OtherPlayers);

/// <summary>
/// Who attended what, for play (<c>docs/specs/play.md</c> §1). Attendance is <c>CheckedInAt</c> —
/// set only by the court box's identification or a no-show reversal on box evidence — never the
/// clock, never <c>ChargedAt</c>, and never a door scan. A member attended a booking when their own
/// seat carries a check-in (whatever the seat's status now), or when the booking carries one and
/// they are a player of it. Booking status is not consulted.
///
/// <para>
/// <b>A player</b> is exactly P11's rule: the booker, or a member holding an ACCEPTED seat. A
/// declined, withdrawn, removed or lapsed seat is not a player; an admin block has none.
/// </para>
/// </summary>
public static class AttendanceQuery
{
    /// <summary>Whether <paramref name="userId"/> is a player of <paramref name="bookingId"/> right now.</summary>
    public static Task<bool> IsPlayerAsync(MainframeDbContext db, Guid bookingId, Guid userId, CancellationToken ct) =>
        db.Bookings.AsNoTracking().AnyAsync(
            b => b.Id == bookingId && b.UserId != null
                 && (b.UserId == userId
                     || db.BookingParticipants.Any(p => p.BookingId == b.Id && p.UserId == userId && p.Status == ParticipantStatus.Accepted)),
            ct);

    /// <summary>The members who are players of <paramref name="bookingId"/>: the booker first, then the accepted seats in seat order.</summary>
    public static async Task<List<Guid>> PlayersOfAsync(MainframeDbContext db, Booking booking, CancellationToken ct)
    {
        if (booking.UserId is not { } booker) return [];
        var seats = await db.BookingParticipants.AsNoTracking()
            .Where(p => p.BookingId == booking.Id && p.UserId != null && p.Status == ParticipantStatus.Accepted)
            .OrderBy(p => p.Seat).Select(p => p.UserId!.Value).ToListAsync(ct);
        return new[] { booker }.Concat(seats).Distinct().ToList();
    }

    /// <summary>The bookings <paramref name="userId"/> attended, as sessions, oldest evidence first.</summary>
    public static async Task<List<AttendedSession>> SessionsAsync(MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        var rows = await db.Bookings.AsNoTracking()
            .Where(b => b.UserId != null
                        && (b.UserId == userId || db.BookingParticipants.Any(p => p.BookingId == b.Id && p.UserId == userId)))
            .Select(b => new
            {
                b.Id,
                b.UserId,
                b.StartsAt,
                b.EndsAt,
                b.CancelledAt,
                b.CheckedInAt,
                Own = db.BookingParticipants
                    .Where(p => p.BookingId == b.Id && p.UserId == userId && p.CheckedInAt != null)
                    .Min(p => p.CheckedInAt),
                Accepted = db.BookingParticipants
                    .Any(p => p.BookingId == b.Id && p.UserId == userId && p.Status == ParticipantStatus.Accepted),
            })
            .Where(x => x.Own != null || (x.CheckedInAt != null && (x.UserId == userId || x.Accepted)))
            .ToListAsync(ct);
        if (rows.Count == 0) return [];

        var ids = rows.Select(r => r.Id).ToList();
        var seats = await db.BookingParticipants.AsNoTracking()
            .Where(p => ids.Contains(p.BookingId) && p.UserId != null && p.Status == ParticipantStatus.Accepted)
            .Select(p => new { p.BookingId, UserId = p.UserId!.Value })
            .ToListAsync(ct);
        var seated = seats.ToLookup(s => s.BookingId, s => s.UserId);

        return rows
            .Select(r => new AttendedSession(
                r.Id, r.StartsAt, (r.Own ?? r.CheckedInAt)!.Value, PlayedMinutes(r.StartsAt, r.EndsAt, r.CancelledAt),
                seated[r.Id].Prepend(r.UserId!.Value).Where(u => u != userId).Distinct().ToList()))
            .OrderBy(s => s.EvidenceAt).ThenBy(s => s.BookingId)
            .ToList();
    }

    /// <summary>
    /// Played minutes of an attended booking (§1), from the row as it stands — a released tail has
    /// already truncated <c>EndsAt</c>, and a cancellation after check-in stops the clock.
    /// </summary>
    public static int PlayedMinutes(DateTimeOffset startsAt, DateTimeOffset endsAt, DateTimeOffset? cancelledAt)
    {
        var end = cancelledAt is { } c && c < endsAt ? c : endsAt;
        return Math.Max(0, (int)Math.Floor((end - startsAt).TotalMinutes));
    }

    /// <summary>
    /// The members whose play record a change on <paramref name="bookingId"/> may move (§7.3): the
    /// booker, anybody with a seat on it in any status, and anybody in any result's lineup on it.
    /// </summary>
    public static async Task<List<Guid>> AffectedMembersAsync(MainframeDbContext db, Guid bookingId, CancellationToken ct)
    {
        var booker = await db.Bookings.AsNoTracking().Where(b => b.Id == bookingId).Select(b => b.UserId).FirstOrDefaultAsync(ct);
        var seats = await db.BookingParticipants.AsNoTracking()
            .Where(p => p.BookingId == bookingId && p.UserId != null).Select(p => p.UserId!.Value).ToListAsync(ct);
        var lineups = await db.MatchResultPlayers.AsNoTracking()
            .Where(p => p.UserId != null && db.MatchResults.Any(r => r.Id == p.ResultId && r.BookingId == bookingId))
            .Select(p => p.UserId!.Value).ToListAsync(ct);
        var all = seats.Concat(lineups);
        if (booker is { } b) all = all.Prepend(b);
        return all.Distinct().ToList();
    }
}
