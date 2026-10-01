using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

public sealed partial class PlayersQuery
{
    /// <summary>The most bookings one wallet page will summarise — the frontend's own lookup cap.</summary>
    public const int ShareSummaryLimit = 20;

    /// <summary>
    /// What a wallet's share line needs about each of its bookings (perf round, 2026-09-30): the
    /// court, the start, the organiser, and the other members with what each has paid — the fields
    /// the Wallet page used to read from one <c>GET /bookings/{id}</c> per booking.
    ///
    /// <para>
    /// <b>The same answer the detail gives, by the same rules.</b> A booking the viewer is nobody to
    /// (a declined or removed seat, a stranger's) is <c>null</c>, as the detail's 404 was; the seats
    /// listed are the ones the detail's table shows that viewer (<see cref="IsShown"/>); a partner's
    /// paid figure is <see cref="ShareLedger.PaidAsync"/>'s, net of returns, as the table's is.
    /// Bookings, seats, people, courts and paid figures are one read each, whatever the count (P5-5).
    /// </para>
    /// </summary>
    public async Task<Dictionary<Guid, object?>> ShareSummariesAsync(
        IReadOnlyCollection<Guid> bookingIds, Guid viewer, bool viewerIsAdmin, CancellationToken ct)
    {
        var ids = bookingIds.Distinct().Take(ShareSummaryLimit).ToList();
        var result = ids.ToDictionary(id => id, _ => (object?)null);
        if (ids.Count == 0) return result;

        var bookings = await _db.Bookings.AsNoTracking().Where(b => ids.Contains(b.Id)).ToListAsync(ct);
        var seats = (await _db.BookingParticipants.AsNoTracking().Where(p => ids.Contains(p.BookingId)).ToListAsync(ct))
            .GroupBy(p => p.BookingId).ToDictionary(g => g.Key, g => g.OrderBy(p => p.Seat).ToList());
        var courtIds = bookings.Select(b => b.CourtId).Distinct().ToList();
        var courts = await _db.Courts.AsNoTracking().Where(c => courtIds.Contains(c.Id))
            .ToDictionaryAsync(c => c.Id, c => c.Name, ct);
        var people = await MembersAsync(
            seats.Values.SelectMany(list => list.Select(p => p.UserId)).Concat(bookings.Select(b => b.UserId)), ct);
        // P5-5: every seat's paid figure in one read, not one per seat.
        var paid = await ShareLedger.PaidOfManyAsync(_db, [.. seats.Values.SelectMany(list => list)], ct);

        foreach (var booking in bookings)
        {
            if (booking.UserId is null || booking.Status == BookingStatus.AdminBlock) continue;
            var mine = seats.GetValueOrDefault(booking.Id) ?? [];
            var mySeat = mine.FirstOrDefault(s => s.UserId == viewer && s.IsLive);
            if (RoleOf(booking, viewer, mySeat, viewerIsAdmin) is not { } role) continue;

            result[booking.Id] = new
            {
                booking_id = booking.Id,
                court_name = courts.GetValueOrDefault(booking.CourtId),
                starts_at = booking.StartsAt,
                organiser = Member(booking.UserId, people),
                partners = Partners(booking, mine, (role, mySeat?.Id), people, paid),
            };
        }
        return result;
    }

    private static List<object> Partners(
        Booking booking, List<BookingParticipant> seats, (string Role, Guid? MySeatId) viewer,
        Dictionary<Guid, PublicMember> people, Dictionary<Guid, decimal> paid)
    {
        var partners = new List<object>();
        foreach (var s in seats)
        {
            if (!IsShown(s, viewer.Role, viewer.MySeatId) || PlayerViews.KindOf(s) != "member" || s.UserId == booking.UserId) continue;
            partners.Add(new
            {
                user_id = s.UserId,
                name = s.UserId is { } id && people.TryGetValue(id, out var m) ? m.Name : null,
                paid_credits = paid.GetValueOrDefault(s.Id),
            });
        }
        return partners;
    }
}
