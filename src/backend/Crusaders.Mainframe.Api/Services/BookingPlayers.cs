using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Who plays on a booking, for the three member-code questions that need it: which REFs a roster
/// entry names (<c>docs/specs/member-code.md</c> §5.3), whose uploaded evidence a booking accepts
/// (§7), and whether a booking is split so the box must refuse to pay for it (§9.2).
///
/// <para>
/// <b>This is the one seam P11 (players and splits) plugs into</b>, and
/// <see cref="ParticipantBookingPlayers"/> is its registration: the roster builders, the evidence
/// lookup and the pay-for endpoint ask only this, so an accepted partner opens the door, lights
/// the court and blocks a pay-for without any of them knowing about seats.
/// </para>
/// </summary>
public interface IBookingPlayers
{
    /// <summary>
    /// The players of each booking, organiser first then accepted partners in seat order, at most
    /// four — only those whose membership is ACTIVE, because a roster must not carry a member the
    /// club has barred. A booking with no eligible player maps to an empty list.
    /// </summary>
    Task<IReadOnlyDictionary<Guid, IReadOnlyList<Guid>>> PlayersOfAsync(IReadOnlyList<Booking> bookings, CancellationToken ct);

    /// <summary>Whether <paramref name="userId"/> plays on <paramref name="booking"/> — organiser or accepted partner, active or not.</summary>
    Task<bool> IsPlayerAsync(Booking booking, Guid userId, CancellationToken ct);

    /// <summary>
    /// Whether the booking is split (D11): a live partner seat asked for a share, or any share
    /// already moved — the box then refuses a pay-for with <c>split_booking</c>, because shares
    /// are paid in the app.
    /// </summary>
    Task<bool> IsSplitAsync(Booking booking, CancellationToken ct);
}

/// <summary>
/// The seam wired to P11's <c>booking_participants</c> (D11): the organiser, then every ACCEPTED
/// partner seat in seat order. Invited, declined, withdrawn, removed and lapsed seats — and guest
/// seats, which name nobody — are not players. "Split" is <see cref="BookingPlayerQueries.IsSplitAsync"/>,
/// the one predicate the box's payer override already reads, so the pay-for refusal and the
/// ignored override cannot disagree about which bookings are split.
///
/// <para>
/// Every read goes through <see cref="BookingPlayerQueries"/> or the same clause it uses (seat
/// &gt; 1, status Accepted), so there is still one reading of "who is on this booking".
/// </para>
/// </summary>
public sealed class ParticipantBookingPlayers : IBookingPlayers
{
    private readonly MainframeDbContext _db;

    public ParticipantBookingPlayers(MainframeDbContext db) => _db = db;

    public async Task<IReadOnlyDictionary<Guid, IReadOnlyList<Guid>>> PlayersOfAsync(
        IReadOnlyList<Booking> bookings, CancellationToken ct)
    {
        var organisers = bookings.Where(b => b.UserId is not null).Select(b => b.UserId!.Value).Distinct().ToList();
        var active = (await _db.Memberships.AsNoTracking()
                .Where(m => organisers.Contains(m.UserId) && m.Status == MembershipStatus.Active)
                .Select(m => m.UserId)
                .ToListAsync(ct))
            .ToHashSet();
        var partners = (await BookingPlayerQueries.ActivePartnersOf(_db, [.. bookings.Select(b => b.Id)]).ToListAsync(ct))
            .ToLookup(p => p.BookingId, p => p.UserId);

        var players = new Dictionary<Guid, IReadOnlyList<Guid>>(bookings.Count);
        foreach (var b in bookings)
        {
            var seated = new List<Guid>(BookingParticipant.MaxSeats);
            if (b.UserId is { } organiser && active.Contains(organiser)) seated.Add(organiser);
            seated.AddRange(partners[b.Id].Where(p => !seated.Contains(p)));
            players[b.Id] = seated.Take(BookingParticipant.MaxSeats).ToList();
        }
        return players;
    }

    public async Task<bool> IsPlayerAsync(Booking booking, Guid userId, CancellationToken ct) =>
        booking.UserId == userId
        || await BookingPlayerQueries.PartnerBookingIds(_db, userId).AnyAsync(id => id == booking.Id, ct);

    public Task<bool> IsSplitAsync(Booking booking, CancellationToken ct) =>
        BookingPlayerQueries.IsSplitAsync(_db, booking.Id, ct);
}
