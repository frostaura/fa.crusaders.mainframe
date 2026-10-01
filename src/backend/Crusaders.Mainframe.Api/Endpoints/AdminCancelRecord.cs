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
    public static Task<AdminChangeLog?> StageAsync(
        HttpContext ctx, Guid bookingId, Guid actorId, string reason, CancellationToken ct)
    {
        return StageAsync(
            ctx.RequestServices.GetRequiredService<MainframeDbContext>(),
            ctx.RequestServices.GetRequiredService<AdminChangeRecorder>(),
            new AdminCancelFacts(bookingId, actorId, reason), ct);
    }

    /// <summary>
    /// The same row for one booking of a bulk cancel (review round 5, A5-2), marked
    /// <c>part_of_batch</c> so it reads beside the batch's <c>bookings.bulk_cancelled</c> summary.
    /// </summary>
    public static async Task<AdminChangeLog?> StageAsync(
        MainframeDbContext db, AdminChangeRecorder recorder, AdminCancelFacts what, CancellationToken ct)
    {
        var (bookingId, actorId, reason) = (what.BookingId, what.ActorId, what.Reason);
        var booking = await db.Bookings.AsNoTracking()
            .Where(b => b.Id == bookingId && b.Status == BookingStatus.Booked && b.UserId != null)
            .Select(b => new { b.Id, b.UserId, b.CourtId, b.StartsAt, b.SliceMinutes, b.SliceCount, b.AmountChargedMinutes })
            .FirstOrDefaultAsync(ct);
        if (booking is null) return null;

        var court = await db.Courts.AsNoTracking().Where(c => c.Id == booking.CourtId).Select(c => c.Name).FirstOrDefaultAsync(ct);
        var label = PersonNames.Of(booking.UserId, await PersonNames.ForAsync(db, [booking.UserId], ct));

        return await recorder.StageAsync(new AdminChange(
            Action: AdminChangeActions.BookingCancelledByAdmin,
            ActorUserId: actorId,
            SubjectKind: AdminChangeSubjects.User,
            SubjectId: booking.UserId,
            SubjectLabel: label,
            Reason: reason,
            Before: Facts(booking.Id, court, booking.StartsAt, booking.SliceMinutes * booking.SliceCount, booking.AmountChargedMinutes),
            After: what.PartOfBatch ? new { status = "cancelled", part_of_batch = true } : new { status = "cancelled" }), ct);
    }

    /// <summary>Nothing was cancelled, so nothing is recorded.</summary>
    public static void Withdraw(HttpContext ctx, AdminChangeLog? row)
        => Withdraw(ctx.RequestServices.GetRequiredService<MainframeDbContext>(), row);

    /// <summary>Nothing was cancelled, so nothing is recorded — and a bulk batch's next save cannot carry it in.</summary>
    public static void Withdraw(MainframeDbContext db, AdminChangeLog? row)
    {
        if (row is null) return;
        db.Entry(row).State = EntityState.Detached;
    }

    private static object Facts(Guid bookingId, string? court, DateTimeOffset startsAt, int minutes, int charged)
    {
        return new
        {
            booking_id = bookingId,
            court,
            starts_at = startsAt,
            minutes,
            amount_minutes = charged,
            status = "booked",
        };
    }
}

/// <summary>Which booking the desk cancelled, who did it, why, and whether it was one item of a batch.</summary>
internal readonly record struct AdminCancelFacts(Guid BookingId, Guid ActorId, string Reason, bool PartOfBatch = false);
