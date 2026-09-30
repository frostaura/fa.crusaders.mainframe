using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Two narrow invite reads the PWA needed (review round 1, asked by lane F2):
/// <list type="bullet">
/// <item><c>GET /api/v1/invites/{token}/preview</c> — ANONYMOUS. What a signed-out person who was
/// sent a link may see before signing in or joining: the organiser's first name, the court, when,
/// the share and the club's zone. Nothing else — no ids, no other players, no balances.</item>
/// <item><c>GET /api/v1/me/invites/{participantId}</c> — the caller's OWN seat in any status, with
/// the booking's status, so a mail deep link can say "you're in", "cancelled" or "no longer on
/// this game" instead of "sign out to open it".</item>
/// </list>
/// </summary>
public static class InviteLookups
{
    /// <summary>
    /// The link token is the credential: 256 random bits, stored hashed, handed only to the people
    /// the organiser sent it to — so holding it proves you were sent it, and what it shows is what
    /// the invite mail itself would. 404 (<c>invite_not_found</c>) for an unknown token, another
    /// club's (the seat lookup is tenant-filtered), an answered seat, a game that is off, or a
    /// share window that has closed — one answer for all, so the route says nothing about which.
    /// Rate-limited by the global per-address limiter, like every anonymous read.
    /// </summary>
    public static async Task<IResult> PreviewAsync(
        string token, PlayersService players, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct)
    {
        var notFound = Results.NotFound(new { error = "invite_not_found" });
        var seat = await players.SeatForTokenAsync(token, ct);
        if (seat is null || seat.Status != ParticipantStatus.Invited || seat.Seat < 2) return notFound;

        var booking = await db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == seat.BookingId, ct);
        var settings = await settingsAccessor.GetAsync(ct);
        if (booking?.UserId is null || booking.Status != BookingStatus.Booked
            || DateTimeOffset.UtcNow >= PlayerSettings.ShareDeadline(booking, settings))
        {
            return notFound;
        }

        var organiser = await db.Memberships.AsNoTracking().Where(m => m.UserId == booking.UserId)
            .Select(m => m.FullName).FirstOrDefaultAsync(ct);
        var court = await db.Courts.AsNoTracking().Where(c => c.Id == booking.CourtId).Select(c => c.Name).FirstOrDefaultAsync(ct);
        return Results.Ok(new
        {
            organiser_first_name = FirstName(organiser),
            court_name = court,
            starts_at = booking.StartsAt,
            ends_at = BookingService.OriginalEndsAt(booking),
            share_credits = seat.ShareCredits,
            timezone = DoorClock.ZoneOf(settings).Name,
        });
    }

    /// <summary>
    /// The caller's own seat, whatever became of it. 404 for a seat that is not theirs — including
    /// an unclaimed link seat and anybody else's — so a participant id proves nothing.
    /// </summary>
    public static async Task<IResult> MineAsync(
        Guid participantId, HttpContext ctx, MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct)
    {
        var me = ctx.User.Id() ?? Guid.Empty;
        var seat = await db.BookingParticipants.AsNoTracking().FirstOrDefaultAsync(p => p.Id == participantId && p.UserId == me, ct);
        if (seat is null) return Results.NotFound(new { error = "invite_not_found" });

        var booking = await db.Bookings.AsNoTracking().FirstAsync(b => b.Id == seat.BookingId, ct);
        var organiser = await db.Memberships.AsNoTracking().Where(m => m.UserId == booking.UserId)
            .Select(m => m.FullName).FirstOrDefaultAsync(ct);
        var court = await db.Courts.AsNoTracking().Where(c => c.Id == booking.CourtId).Select(c => c.Name).FirstOrDefaultAsync(ct);
        var settings = await settingsAccessor.GetAsync(ct);
        return Results.Ok(new
        {
            participant_id = seat.Id,
            booking_id = booking.Id,
            status = PlayerViews.StatusName(seat.Status),
            lapsed = seat.LapsedAt is not null || seat.Status == ParticipantStatus.Lapsed,
            settled_outside = seat.SettledOutsideAt is not null,
            booking_status = PlayerViews.BookingStatusName(booking.Status),
            court_name = court,
            starts_at = booking.StartsAt,
            ends_at = BookingService.OriginalEndsAt(booking),
            organiser_name = organiser,
            share_credits = seat.ShareCredits,
            timezone = DoorClock.ZoneOf(settings).Name,
        });
    }

    private static string? FirstName(string? fullName)
    {
        if (string.IsNullOrWhiteSpace(fullName)) return null;
        var trimmed = fullName.Trim();
        var space = trimmed.IndexOf(' ');
        return space < 0 ? trimmed : trimmed[..space];
    }
}
