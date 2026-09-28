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
/// <b>This is the one seam P11 (players and splits) extends.</b> Until <c>booking_participants</c>
/// exists every booking has exactly one player — its organiser — and nobody holds a share, which
/// is what <see cref="OrganiserOnlyBookingPlayers"/> answers. When partners land, replacing the
/// registration is the whole of the change: the roster builders, the evidence lookup and the
/// pay-for endpoint ask only this, so an accepted partner opens the door, lights the court and
/// blocks a pay-for without any of them being edited.
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
    /// Whether any accepted partner holds a share of the booking (D11) — the box then refuses a
    /// pay-for with <c>split_booking</c>, because shares are paid in the app.
    /// </summary>
    Task<bool> IsSplitAsync(Booking booking, CancellationToken ct);
}

/// <summary>
/// Every booking has one player, its organiser, and nothing is split — the truth until P11's
/// participants model exists.
/// </summary>
public sealed class OrganiserOnlyBookingPlayers : IBookingPlayers
{
    private readonly MainframeDbContext _db;

    public OrganiserOnlyBookingPlayers(MainframeDbContext db) => _db = db;

    public async Task<IReadOnlyDictionary<Guid, IReadOnlyList<Guid>>> PlayersOfAsync(
        IReadOnlyList<Booking> bookings, CancellationToken ct)
    {
        var organisers = bookings.Where(b => b.UserId is not null).Select(b => b.UserId!.Value).Distinct().ToList();
        var active = (await _db.Memberships.AsNoTracking()
                .Where(m => organisers.Contains(m.UserId) && m.Status == MembershipStatus.Active)
                .Select(m => m.UserId)
                .ToListAsync(ct))
            .ToHashSet();

        var players = new Dictionary<Guid, IReadOnlyList<Guid>>(bookings.Count);
        foreach (var b in bookings)
        {
            players[b.Id] = b.UserId is { } organiser && active.Contains(organiser) ? [organiser] : [];
        }
        return players;
    }

    public Task<bool> IsPlayerAsync(Booking booking, Guid userId, CancellationToken ct) =>
        Task.FromResult(booking.UserId == userId);

    public Task<bool> IsSplitAsync(Booking booking, CancellationToken ct) => Task.FromResult(false);
}
