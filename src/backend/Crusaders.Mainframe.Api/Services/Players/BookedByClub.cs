using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Whether the club made this booking FOR the member reading it (review round 9, J9-5, asked by
/// FC9): an admin booked it on their behalf, so "You booked" / "You organised this game" is false.
/// <see cref="Booking.ActorUserId"/> is the admin on an on-behalf booking and the member on their
/// own; <c>Guid.Empty</c> (the system) made nobody's booking for them. Only the member it was made
/// for is told — a partner or a payer at the box did not have it made for them.
/// </summary>
public static class BookedByClub
{
    public static bool For(Booking booking, Guid viewer)
    {
        return booking.UserId == viewer
               && booking.ActorUserId != Guid.Empty
               && booking.ActorUserId != (booking.BookedByUserId ?? booking.UserId);
    }
}
