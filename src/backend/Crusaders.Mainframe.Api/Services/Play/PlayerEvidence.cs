using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Review round 19, E19-3: what proves a PLAYER came to a booking (<c>docs/specs/play.md</c> §1), for
/// <see cref="AttendanceQuery"/>, the booking page and the "played with" lists. <c>bookings.CheckedInAt</c>
/// is whoever lit the court — the money rule — and a pay-for payer with no accepted seat is not a player
/// (R18 E18-6). After only a payer's scan, the organiser of a seatless game had a session at the payer's
/// instant, the booking page's organiser row printed the payer's time beside "0 of 1 checked in", and an
/// accepted partner who never came was credited too. Where somebody other than the booker paid, the
/// game's evidence is now its players' own scans only.
/// </summary>
public static class PlayerEvidence
{
    /// <summary>One candidate booking of <see cref="AttendanceQuery.SessionsAsync"/>, as read.</summary>
    internal sealed record Candidate(
        Guid Id, Guid UserId, Guid? PaidByUserId, DateTimeOffset StartsAt, DateTimeOffset EndsAt, DateTimeOffset? CancelledAt,
        DateTimeOffset? CheckedInAt)
    {
    }

    /// <summary>
    /// The member's evidence for one candidate — null when they did not attend it. Their own seat's
    /// check-in (rule 1); else, as a player of it, the game's own evidence (rule 2): the booking's
    /// check-in when that was a player's scan, else the earliest scan of a player — the booker's own
    /// for the booker (R19 E19-3).
    /// </summary>
    internal static (Candidate Booking, DateTimeOffset? At) Of(
        Candidate c, Guid userId, DateTimeOffset? own, bool accepted, Dictionary<Guid, PlayerArrivals> arrivals)
    {
        if (own is not null) return (c, own);
        var isBooker = c.UserId == userId;
        if (!isBooker && !accepted) return (c, null);
        if (CheckInIsAPlayersScan(c.UserId, c.PaidByUserId)) return (c, c.CheckedInAt);
        if (!arrivals.TryGetValue(c.Id, out var seen)) return (c, null);
        return (c, (isBooker ? seen.Booker : null) ?? seen.Earliest);
    }

    /// <summary>
    /// R19 E19-3: whether a booking's own <c>CheckedInAt</c> is a PLAYER's scan. It is whoever lit the
    /// court (the money rule), and the only member who can light somebody else's court without being a
    /// player of it is a pay-for payer (D10) — who becomes the booking's payer. So while nobody but the
    /// booker paid, whoever lit it was a player; once somebody else paid, the booking's check-in may be
    /// theirs and proves nobody arrived — only a player's own scan does (<see cref="ArrivalsAsync"/>).
    /// </summary>
    public static bool CheckInIsAPlayersScan(Guid? booker, Guid? paidBy) => paidBy is null || paidBy == booker;

    /// <summary>
    /// R19 E19-3: the bookings of <paramref name="q"/> a PLAYER checked in — the booking's check-in when
    /// it is a player's scan (<see cref="CheckInIsAPlayersScan"/>), or any seat's own check-in. The SQL
    /// twin of the rule for "played with" lists. A booker's seatless scan after a payer lit the court is
    /// not seen here (it is an audit row); those lists only read games with seats, where it stamps seat 1.
    /// </summary>
    public static IQueryable<Booking> CheckedInByAPlayer(MainframeDbContext db, IQueryable<Booking> q)
    {
        return q.Where(b => (b.CheckedInAt != null && (b.PaidByUserId == null || b.PaidByUserId == b.UserId))
                            || db.BookingParticipants.Any(p => p.BookingId == b.Id && p.UserId != null && p.CheckedInAt != null));
    }

    /// <summary>The players' own arrivals on one booking: the earliest of any, and the booker's.</summary>
    internal sealed record PlayerArrivals(DateTimeOffset? Earliest, DateTimeOffset? Booker)
    {
    }

    /// <summary>
    /// R19 E19-3: for bookings somebody other than the booker paid for, when the players THEMSELVES
    /// scanned — every seat's own check-in (a seat is only ever stamped by its member's scan), and the
    /// booker's own scan, which on a game with no seat of theirs is an audit row: the
    /// <c>court.activated</c> of a court they lit, or the seatless <c>court.checked_in</c> of their scan
    /// after a payer lit it (<see cref="SeatCheckIn.StageBookerArrivalAsync"/>). A booking with neither
    /// is absent: nobody but the payer came.
    /// </summary>
    internal static async Task<Dictionary<Guid, PlayerArrivals>> ArrivalsAsync(
        MainframeDbContext db, IReadOnlyList<Candidate> bookings, CancellationToken ct)
    {
        if (bookings.Count == 0) return [];
        var ids = bookings.Select(b => b.Id).ToList();
        var stamps = await db.BookingParticipants.AsNoTracking()
            .Where(p => ids.Contains(p.BookingId) && p.UserId != null && p.CheckedInAt != null)
            .GroupBy(p => p.BookingId)
            .Select(g => new { BookingId = g.Key, At = g.Min(p => p.CheckedInAt!.Value) })
            .ToDictionaryAsync(x => x.BookingId, x => x.At, ct);
        var bookers = await BookerScansAsync(db, bookings.Select(b => (b.Id, b.UserId, b.StartsAt)).ToList(), ct);

        var arrivals = new Dictionary<Guid, PlayerArrivals>();
        foreach (var id in ids)
        {
            DateTimeOffset? seat = stamps.TryGetValue(id, out var s) ? s : null;
            DateTimeOffset? booker = bookers.TryGetValue(id, out var b) ? b : null;
            if (seat is null && booker is null) continue;
            arrivals[id] = new PlayerArrivals(Earlier(seat, booker), booker);
        }
        return arrivals;
    }

    private static DateTimeOffset? Earlier(DateTimeOffset? a, DateTimeOffset? b) =>
        a is null ? b : b is null ? a : (a < b ? a : b);

    /// <summary>
    /// R19 E19-3: the organiser's OWN check-in on a game with no seats — what the booking page's
    /// organiser row prints and counts. The booking's check-in when a player lit it (on a seatless game
    /// the only player is the booker); else the booker's own scan, or null when only a payer scanned.
    /// </summary>
    public static async Task<DateTimeOffset?> SeatlessOrganiserCheckInAsync(MainframeDbContext db, Booking booking, CancellationToken ct)
    {
        if (booking.CheckedInAt is null || booking.UserId is not { } booker) return null;
        if (CheckInIsAPlayersScan(booker, booking.PaidByUserId)) return booking.CheckedInAt;
        var scans = await BookerScansAsync(db, [(booking.Id, booker, booking.StartsAt)], ct);
        return scans.TryGetValue(booking.Id, out var at) ? at : null;
    }

    /// <summary>
    /// The booker's own scan on each booking, from their <c>court.activated</c> and <c>court.checked_in</c>
    /// rows (actor = the scanner, <c>details.booking_id</c>, <c>details.occurred_at</c>) — the earliest.
    /// Read by the actor index, from a day before the earliest start: a scan is never earlier than the
    /// cue window before its court time, and its row is written at or after the scan.
    /// </summary>
    private static async Task<Dictionary<Guid, DateTimeOffset>> BookerScansAsync(
        MainframeDbContext db, IReadOnlyList<(Guid BookingId, Guid Booker, DateTimeOffset StartsAt)> bookings, CancellationToken ct)
    {
        var bookerOf = bookings.ToDictionary(b => b.BookingId, b => b.Booker);
        var actors = bookings.Select(b => b.Booker).Distinct().ToList();
        var since = bookings.Min(b => b.StartsAt).AddDays(-1);
        var rows = await db.AuditLogs.AsNoTracking()
            .Where(a => actors.Contains(a.ActorUserId) && a.CreatedAt >= since && a.DetailsJson != null
                        && (a.Action == SeatCheckIn.Action || a.Action == SeatCheckIn.ActivatedAction))
            .Select(a => new { a.ActorUserId, a.Action, a.DetailsJson, a.ScanAt })
            .ToListAsync(ct);

        var scans = new Dictionary<Guid, DateTimeOffset>();
        foreach (var row in rows)
        {
            if (ScanOf(row.DetailsJson!, row.Action == SeatCheckIn.Action ? row.ScanAt : null) is not { } scan) continue;
            if (!bookerOf.TryGetValue(scan.BookingId, out var booker) || booker != row.ActorUserId) continue;
            if (!scans.TryGetValue(scan.BookingId, out var seen) || scan.At < seen) scans[scan.BookingId] = scan.At;
        }
        return scans;
    }

    /// <summary>
    /// The booking and instant a check-in row names: a <c>court.checked_in</c> row's own <c>ScanAt</c>
    /// (<paramref name="scanAt"/>, the instant it displays at), else the details' <c>occurred_at</c> —
    /// <c>court.activated</c> keeps the scan there and its <c>ScanAt</c> is its write.
    /// </summary>
    private static (Guid BookingId, DateTimeOffset At)? ScanOf(string detailsJson, DateTimeOffset? scanAt)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(detailsJson);
            var root = doc.RootElement;
            if (!root.TryGetProperty("booking_id", out var id) || !id.TryGetGuid(out var bookingId)) return null;
            if (scanAt is { } stamped) return (bookingId, stamped);
            if (!root.TryGetProperty("occurred_at", out var o) || !o.TryGetDateTimeOffset(out var at)) return null;
            return (bookingId, at);
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }
}
