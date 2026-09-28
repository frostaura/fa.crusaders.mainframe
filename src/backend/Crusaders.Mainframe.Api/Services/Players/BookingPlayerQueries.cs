using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Every question the REST of the product asks about a booking's players (D11), in one place:
/// which bookings a member is on, who may activate a court, whether a booking is split.
///
/// <para>
/// <b>Why one small seam.</b> The gate, the court box, the daily cap and the pay-for-at-the-box
/// path (P7) all need "is this person on that booking", and each writing its own subquery over
/// <c>booking_participants</c> is five readings of one rule that drift. They are composable
/// <see cref="IQueryable{T}"/>s so EF still inlines them into each caller's single statement, and
/// so the device-roster seam P7 is building (<c>IBookingPlayers</c>) can be wired to these with a
/// one-line change.
/// </para>
/// </summary>
public static class BookingPlayerQueries
{
    /// <summary>Bookings this member holds an ACCEPTED partner seat on (not the organiser's own).</summary>
    public static IQueryable<Guid> PartnerBookingIds(MainframeDbContext db, Guid userId) =>
        db.BookingParticipants
            .Where(p => p.UserId == userId && p.Seat > 1 && p.Status == ParticipantStatus.Accepted)
            .Select(p => p.BookingId);

    /// <summary>
    /// Bookings with at least one accepted partner whose membership is active — the court-box
    /// candidates a partner may activate even when the organiser's own membership is not active.
    /// </summary>
    public static IQueryable<Guid> BookingsWithActivePartners(MainframeDbContext db) =>
        db.BookingParticipants
            .Where(p => p.Seat > 1 && p.Status == ParticipantStatus.Accepted
                        && db.Memberships.Any(m => m.UserId == p.UserId && m.Status == MembershipStatus.Active))
            .Select(p => p.BookingId);

    /// <summary>The accepted partners (active membership) of <paramref name="bookingIds"/>, as (booking, member) pairs.</summary>
    public static IQueryable<BookingPlayer> ActivePartnersOf(MainframeDbContext db, IReadOnlyCollection<Guid> bookingIds) =>
        db.BookingParticipants.AsNoTracking()
            .Where(p => bookingIds.Contains(p.BookingId) && p.Seat > 1 && p.UserId != null
                        && p.Status == ParticipantStatus.Accepted
                        && db.Memberships.Any(m => m.UserId == p.UserId && m.Status == MembershipStatus.Active))
            .Select(p => new BookingPlayer(p.BookingId, p.UserId!.Value));

    /// <summary>
    /// A split booking — any partner seat still asked for a share, or any share already moved. The
    /// pay-for-at-the-box path refuses these (<see cref="ShareLedger.SplitPayInApp"/>), and a payer
    /// override at the box is ignored on them.
    /// </summary>
    public static async Task<bool> IsSplitAsync(MainframeDbContext db, Guid bookingId, CancellationToken ct)
    {
        if (await HasLivePartnerSeatAsync(db, bookingId, ct, requireShare: true)) return true;
        return await db.LedgerEntries.AsNoTracking()
            .AnyAsync(l => l.RelatedBookingId == bookingId && l.Type == LedgerEntryType.ShareTransfer, ct);
    }

    /// <summary>Any live (invited or accepted) partner seat — with a share, when <paramref name="requireShare"/>.</summary>
    public static Task<bool> HasLivePartnerSeatAsync(MainframeDbContext db, Guid bookingId, CancellationToken ct, bool requireShare = false) =>
        db.BookingParticipants.AsNoTracking().AnyAsync(
            p => p.BookingId == bookingId && p.Seat > 1 && (!requireShare || p.ShareCredits > 0)
                 && (p.Status == ParticipantStatus.Invited || p.Status == ParticipantStatus.Accepted), ct);
}

/// <summary>One accepted player on one booking.</summary>
public sealed record BookingPlayer(Guid BookingId, Guid UserId);
