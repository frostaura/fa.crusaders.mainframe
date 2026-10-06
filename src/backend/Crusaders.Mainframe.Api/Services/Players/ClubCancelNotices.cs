using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// What a game the club cancelled tells the people on it, beyond the partners' own "the game is off"
/// (<see cref="ShareSweep"/>).
/// </summary>
internal static class ClubCancelNotices
{
    /// <summary>
    /// R18 J18-9: the organiser's inbox line when the CLUB cancelled their booking before it started —
    /// the partners were told in their inbox and the organiser only by mail, so the one person whose
    /// court it was had nothing on the bell. Not mailed (the cancellation mail is theirs), and keyed
    /// like every <c>players.game_cancelled</c> line (<c>game-cancelled:{booking}:{member}</c>), so it
    /// is said once however often the settlement runs. Null when it is not owed: the organiser's own
    /// cancel, a displacement (the system's, told by its own notice), and a started session — the
    /// cancellation's own save already wrote that line, with "it had started" (BookingService).
    /// </summary>
    public static MemberNotice? ForOrganiser(Booking booking, BookingCancellation? by, string organiserName, GameText game)
    {
        if (by is not { ByClub: true, Cause: null } || booking.CheckedInAt is not null || booking.UserId is not { } organiser) return null;
        var notice = new MemberNotice(
            organiser, MemberEventCatalogue.GameCancelled, $"game-cancelled:{booking.Id:N}:{organiser:N}",
            new GameCancelledPayload(booking.Id, organiserName, game.CourtName, game.StartsLocal, ByClub: true, ClubReason: by.Reason),
            $"The club cancelled your booking on {game.CourtName}, {game.StartsLocal}", $"/bookings/{booking.Id}", booking.Id)
        {
            Email = false,
        };
        return notice;
    }

    /// <summary>
    /// R18 E18-2: whose scan checked <paramref name="booking"/> in — the seat stamped at the booking's own
    /// check-in (activation and the reversal stamp the scanner's seat), else the scanner on its
    /// <c>court.activated</c> row (a pay-for payer holds no seat), else the booker. Null when nobody
    /// checked in. The same rule the organiser's <c>cancelled_no_refund</c> frame names
    /// (<c>BookingService.CheckedInByAsync</c>), so both frames of one cancel name one person.
    /// </summary>
    public static async Task<Guid?> CheckedInByAsync(MainframeDbContext db, Booking booking, CancellationToken ct)
    {
        if (booking.CheckedInAt is not { } at) return null;
        var seat = await db.BookingParticipants.AsNoTracking()
            .Where(p => p.BookingId == booking.Id && p.CheckedInAt == at && p.UserId != null)
            .OrderBy(p => p.Seat).Select(p => p.UserId).FirstOrDefaultAsync(ct);
        return seat ?? await ActivatedByAsync(db, booking, ct) ?? booking.UserId;
    }

    /// <summary>The first identified scanner on this booking's <c>court.activated</c> rows.</summary>
    private static async Task<Guid?> ActivatedByAsync(MainframeDbContext db, Booking booking, CancellationToken ct)
    {
        var rows = db.AuditLogs.AsNoTracking()
            .Where(a => a.Action == ActivatedAction && a.SubjectUserId == booking.UserId
                        && a.ActorUserId != Guid.Empty && a.DetailsJson != null);
        if (db.Database.IsNpgsql())
        {
            var containment = System.Text.Json.JsonSerializer.Serialize(new { booking_id = booking.Id });
            return await rows.Where(a => EF.Functions.JsonContains(a.DetailsJson!, containment))
                .OrderBy(a => a.CreatedAt).Select(a => (Guid?)a.ActorUserId).FirstOrDefaultAsync(ct);
        }
        // The unit suites' in-memory provider has no jsonb containment: the same filter, client side.
        var id = booking.Id.ToString();
        return (await rows.ToListAsync(ct))
            .Where(a => a.DetailsJson!.Contains(id, StringComparison.OrdinalIgnoreCase))
            .OrderBy(a => a.CreatedAt).Select(a => (Guid?)a.ActorUserId).FirstOrDefault();
    }

    private const string ActivatedAction = "court.activated";
}
