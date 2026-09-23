using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// How a bulk book — the admin's and the member's alike — recognises an item an earlier attempt
/// under the same key already booked, and decides whether that earlier booking is really THIS
/// item's answer.
///
/// <para>
/// <b>One copy for both routes.</b> The member bulk was built checking what the admin bulk
/// trusted, and the two drifted within a day: the admin replay answered <c>duplicate</c> for a
/// key reused on another payer, reporting member A's 09:00 booking as member B's result while B
/// had no court and no charge. One lookup and one verdict cannot drift from themselves.
/// </para>
/// </summary>
internal static class BulkReplay
{
    /// <summary>
    /// The booking an earlier attempt produced for this item, or null.
    ///
    /// <para>
    /// <b>The ledger reference first</b> — the debit is posted under it, and the filtered unique
    /// index on <c>ExternalReference</c> is what makes the lookup authoritative for a charged
    /// item. <b>Then, for a court priced at zero, the booking itself.</b> Settlement-model I10
    /// forbids a 0.00 ledger row, so a free court leaves no reference to find; the honest
    /// substitute is the row this item would have produced — the payer's live, uncharged booking
    /// on the same court at the same start — which is what the guest-block replay already does
    /// for the same reason.
    /// </para>
    /// </summary>
    public static async Task<Booking?> FindAsync(
        MainframeDbContext db, string reference, Guid payerUserId, BulkBookItem item, CancellationToken ct)
    {
        var bookingId = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.ExternalReference == reference)
            .Select(l => l.RelatedBookingId)
            .FirstOrDefaultAsync(ct);

        if (bookingId is not null)
        {
            return await db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        }

        var startsAt = AtDatabasePrecision(item.StartsAt);
        return await db.Bookings.AsNoTracking().FirstOrDefaultAsync(
            b => b.UserId == payerUserId
                 && b.CourtId == item.CourtId
                 && b.StartsAt == startsAt
                 && b.Status == BookingStatus.Booked
                 && b.AmountChargedCredits == 0m, ct);
    }

    /// <summary>
    /// Null when <paramref name="earlier"/> is this item's own live booking; otherwise the word
    /// the item is refused with.
    ///
    /// <list type="bullet">
    /// <item><see cref="BookingRefusals.IdempotencyKeyReused"/> — the reference is keyed on the
    /// item's index, so a key reused for a DIFFERENT list, or for another payer, would otherwise
    /// answer this item with whatever sat at its position last time.</item>
    /// <item><see cref="BookingRefusals.AlreadyCancelled"/> — the earlier booking has since been
    /// cancelled and refunded. Answering <c>booked</c> would tell the payer they hold a court
    /// they do not; booking again cannot happen under the same reference, whose debit row the
    /// cancellation left in place.</item>
    /// </list>
    /// </summary>
    public static string? RefusalFor(Booking earlier, Guid payerUserId, BulkBookItem item)
    {
        var sameItem = earlier.UserId == payerUserId
                       && earlier.CourtId == item.CourtId
                       && Microseconds(earlier.StartsAt) == Microseconds(item.StartsAt);
        if (!sameItem) return BookingRefusals.IdempotencyKeyReused;
        return earlier.Status == BookingStatus.Cancelled ? BookingRefusals.AlreadyCancelled : null;
    }

    /// <summary>
    /// An instant at the database's precision, so a client that sent ticks the column dropped
    /// still matches its own booking (<c>memory/gotchas-postgres-offsets.md</c>).
    /// </summary>
    private static long Microseconds(DateTimeOffset at)
    {
        return at.UtcTicks / 10;
    }

    private static DateTimeOffset AtDatabasePrecision(DateTimeOffset at)
    {
        return new DateTimeOffset(Microseconds(at) * 10, TimeSpan.Zero);
    }
}
