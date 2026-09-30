using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The change-record row for the desk cancelling one member's booking (review round 4, A4-4).
///
/// <para>
/// <c>booking.cancelled_by_admin</c> was in the vocabulary and nothing wrote it, so the club's
/// record had every on-behalf booking and none of the cancellations. The row is about the
/// MEMBER (<c>subject_kind = user</c>), like the on-behalf booking it mirrors, so it shows on
/// their record. It is staged before the cancellation and flushes in its save, so it exists
/// exactly when the cancellation does. The refund and penalty are the ledger's rows beside it:
/// the record is append-only (a trigger refuses UPDATE), so figures known only after the save
/// cannot be added to it.
/// </para>
/// </summary>
internal static class AdminCancelRecord
{
    public static async Task<AdminChangeLog?> StageAsync(
        HttpContext ctx, Guid bookingId, Guid actorId, string reason, CancellationToken ct)
    {
        var db = ctx.RequestServices.GetRequiredService<MainframeDbContext>();
        var booking = await db.Bookings.AsNoTracking()
            .Where(b => b.Id == bookingId && b.Status == BookingStatus.Booked && b.UserId != null)
            .Select(b => new { b.Id, b.UserId, b.CourtId, b.StartsAt, b.SliceMinutes, b.SliceCount, b.AmountChargedCredits })
            .FirstOrDefaultAsync(ct);
        if (booking is null) return null;

        var court = await db.Courts.AsNoTracking().Where(c => c.Id == booking.CourtId).Select(c => c.Name).FirstOrDefaultAsync(ct);
        var label = PersonNames.Of(booking.UserId, await PersonNames.ForAsync(db, [booking.UserId], ct));
        var recorder = ctx.RequestServices.GetRequiredService<AdminChangeRecorder>();

        return await recorder.StageAsync(new AdminChange(
            Action: AdminChangeActions.BookingCancelledByAdmin,
            ActorUserId: actorId,
            SubjectKind: AdminChangeSubjects.User,
            SubjectId: booking.UserId,
            SubjectLabel: label,
            Reason: reason,
            Before: Facts(booking.Id, court, booking.StartsAt, booking.SliceMinutes * booking.SliceCount, booking.AmountChargedCredits),
            After: new { status = "cancelled" }), ct);
    }

    /// <summary>Nothing was cancelled, so nothing is recorded.</summary>
    public static void Withdraw(HttpContext ctx, AdminChangeLog? row)
    {
        if (row is null) return;
        ctx.RequestServices.GetRequiredService<MainframeDbContext>().Entry(row).State = EntityState.Detached;
    }

    private static object Facts(Guid bookingId, string? court, DateTimeOffset startsAt, int minutes, decimal charged)
    {
        return new
        {
            booking_id = bookingId,
            court,
            starts_at = startsAt,
            minutes,
            amount_credits = charged,
            status = "booked",
        };
    }
}
