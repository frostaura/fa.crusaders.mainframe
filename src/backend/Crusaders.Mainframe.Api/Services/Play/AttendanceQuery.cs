using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// One attended booking from one member's point of view — a <b>session</b> (§1).
/// </summary>
/// <param name="EvidenceAt">The member's own seat check-in when set, else the game's player evidence (R19 E19-3) — what orders sessions (§5.6).</param>
/// <param name="PlayedMinutes"><c>max(0, min(EndsAt, CancelledAt ?? EndsAt) − StartsAt)</c> in whole minutes.</param>
/// <param name="OtherPlayers">The OTHER members who were players of the booking (§5.1 <c>partners</c>).</param>
public sealed record AttendedSession(
    Guid BookingId, DateTimeOffset StartsAt, DateTimeOffset EvidenceAt, int PlayedMinutes, IReadOnlyList<Guid> OtherPlayers)
{
    /// <summary>
    /// R16 E16-9: when the court time ended — its end, or the cancellation that stopped it. Null on a
    /// session built without it (the unit suites), which is read as over.
    /// </summary>
    public DateTimeOffset? EndedAt { get; init; }

    /// <summary>
    /// R16 E16-9: the booking was cancelled after its check-in — only the club can, once a session has
    /// started. R17 J17-5: <see cref="AttendanceQuery.SessionsAsync"/> no longer returns such a session at
    /// all; the flag stays for sessions built by hand.
    /// </summary>
    public bool Cancelled { get; init; }

    /// <summary>
    /// R16 E16-9: a session that may earn a badge — over, and not cancelled by the club. Badges are
    /// never taken back (play.md §3.3), so one is awarded when the session ENDS, not when it starts:
    /// a session the club cancelled half way earned "First court" and "Night owl" it then kept.
    /// </summary>
    public bool EarnsBadgesAt(DateTimeOffset now) => !Cancelled && (EndedAt is not { } end || end <= now);
}

/// <summary>
/// Who attended what, for play (<c>docs/specs/play.md</c> §1). Attendance is <c>CheckedInAt</c> —
/// set only by the court box's identification or a no-show reversal on box evidence — never the
/// clock, never <c>ChargedAt</c>, and never a door scan. A member attended a booking when their own
/// seat carries a check-in (whatever the seat's status now), or when a PLAYER's scan checked the
/// booking in and they are a player of it — and (R17 J17-5) the booking was not cancelled: only the club can cancel
/// a session once somebody has checked in, and a session the club called off is not one the member
/// attended. That is the ONE definition of attended — stats, the streak, partners, badges and their
/// progress, the monthly ring and the member's time-on-court reports all read it here, so no two of
/// them can disagree about a club-cancelled session again.
///
/// <para>
/// <b>R19 E19-3: a pay-for payer's scan is nobody's attendance.</b> <c>bookings.CheckedInAt</c> is
/// whoever lit the court, and a payer with no accepted seat is not a player (R18 E18-6) — so after
/// only the payer's scan the organiser of a seatless game had a session at the payer's instant and an
/// accepted partner who never came had one too. Where somebody other than the booker paid, the game's
/// evidence is now its players' own scans only (<see cref="PlayerEvidence"/>).
/// </para>
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

    /// <summary>
    /// The bookings <paramref name="userId"/> attended, as sessions, oldest evidence first.
    ///
    /// <para>
    /// <b>Two plain reads, joined here — keep it that way.</b> This was one statement: bookings
    /// filtered by "booker OR has a seat", with the member's own check-in and accepted seat as
    /// correlated subqueries. An OR across a join cannot use an index, so Postgres seq-scanned
    /// every booking in the club and guessed ~11k rows for a heavy member's ~1.9k; the cost that
    /// guess implied (~615k) is past <c>jit_above_cost</c> and <c>jit_optimize_above_cost</c>, and
    /// every <c>/me/play</c> paid ~240 ms (~1 s on a loaded host) compiling a plan that runs in
    /// ~20 ms (P12 perf pass). The member's seats come by <c>(TenantId, UserId, Status)</c>; their
    /// bookings as a UNION ALL of "booked by them" (by <c>(TenantId, UserId, StartsAt)</c>) and
    /// "someone else's, with a seat of theirs" (a semi-join). Every estimate is then within a few
    /// percent and the total cost is a few thousand, far below the JIT threshold.
    /// </para>
    /// </summary>
    public static async Task<List<AttendedSession>> SessionsAsync(MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        var mySeats = await db.BookingParticipants.AsNoTracking()
            .Where(p => p.UserId == userId)
            .Select(p => new { p.BookingId, p.CheckedInAt, p.Status })
            .ToListAsync(ct);
        var ownCheckIn = mySeats.Where(s => s.CheckedInAt != null).GroupBy(s => s.BookingId)
            .ToDictionary(g => g.Key, g => g.Min(s => s.CheckedInAt!.Value));
        var acceptedOn = mySeats.Where(s => s.Status == ParticipantStatus.Accepted).Select(s => s.BookingId).ToHashSet();

        var booked = db.Bookings.AsNoTracking().Where(b => b.UserId == userId);
        var seatedOn = db.Bookings.AsNoTracking()
            .Where(b => b.UserId != null && b.UserId != userId
                        && db.BookingParticipants.Any(p => p.BookingId == b.Id && p.UserId == userId));
        var candidates = await booked.Concat(seatedOn)
            .Where(b => b.CancelledAt == null)
            .Select(b => new PlayerEvidence.Candidate(b.Id, b.UserId!.Value, b.PaidByUserId, b.StartsAt, b.EndsAt, b.CancelledAt, b.CheckedInAt))
            .ToListAsync(ct);
        // R19 E19-3: where somebody other than the booker paid, the booking's check-in may be the payer's.
        var arrivals = await PlayerEvidence.ArrivalsAsync(
            db, candidates.Where(c => c.CheckedInAt != null && !PlayerEvidence.CheckInIsAPlayersScan(c.UserId, c.PaidByUserId)).ToList(), ct);
        var rows = candidates
            .Select(c => PlayerEvidence.Of(c, userId, ownCheckIn.TryGetValue(c.Id, out var own) ? own : null, acceptedOn.Contains(c.Id), arrivals))
            .Where(x => x.At != null)
            .ToList();
        if (rows.Count == 0) return [];

        var ids = rows.Select(r => r.Booking.Id).ToList();
        var seats = await db.BookingParticipants.AsNoTracking()
            .Where(p => ids.Contains(p.BookingId) && p.UserId != null && p.Status == ParticipantStatus.Accepted)
            .Select(p => new { p.BookingId, UserId = p.UserId!.Value })
            .ToListAsync(ct);
        var seated = seats.ToLookup(s => s.BookingId, s => s.UserId);

        return rows
            .Select(x => (x.Booking, x.At!.Value))
            .Select(x => new AttendedSession(
                x.Booking.Id, x.Booking.StartsAt, AttendedAt(x.Booking.StartsAt, x.Value),
                PlayedMinutes(x.Booking.StartsAt, x.Booking.EndsAt, x.Booking.CancelledAt),
                seated[x.Booking.Id].Prepend(x.Booking.UserId).Where(u => u != userId).Distinct().ToList())
            {
                EndedAt = x.Booking.CancelledAt is { } c && c < x.Booking.EndsAt ? c : x.Booking.EndsAt,
                Cancelled = x.Booking.CancelledAt is not null,
            })
            .OrderBy(s => s.EvidenceAt).ThenBy(s => s.BookingId)
            .ToList();
    }

    /// <summary>
    /// When a session counts as attended (review round 2, B-11): the court time's start or the
    /// check-in, whichever is later — the rule a result already keeps (B15). A scan during early
    /// entry is evidence the member came, not the instant they played.
    /// </summary>
    public static DateTimeOffset AttendedAt(DateTimeOffset startsAt, DateTimeOffset checkedIn) =>
        checkedIn > startsAt ? checkedIn : startsAt;

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
