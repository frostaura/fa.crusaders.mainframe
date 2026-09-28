using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>What a member holds for their partners right now, and when the earliest of it is freed.</summary>
public sealed record HeldCredits(decimal Held, DateTimeOffset? ReleasesAt)
{
    public static readonly HeldCredits None = new(0m, null);
}

/// <summary>
/// Credits an organiser received as shares that are not theirs to spend yet (D11, decision of
/// 2026-09-28 in <c>memory/decisions-players.md</c>).
///
/// <para>
/// <b>Why.</b> A share can come BACK: the partner withdraws, the organiser lowers or re-splits,
/// removes them, the desk settles it outside the app, or the organiser cancels late (the penalty
/// is theirs alone, so the refund falls short of the returns). Each return debits the organiser.
/// Had they spent the share in between, the return took them below zero — a debt to a friend by
/// another name, which is the one thing D11 exists to prevent.
/// </para>
///
/// <para>
/// <b>What is held.</b> Per booking the member is the payer of, the net of the share rows on
/// their wallet (what came in less what went back), until that booking's share deadline — the
/// SOLD end plus <c>share_lapse_hours</c>, after which no seat can change and no return can be
/// asked of them except by a fall in what they owe, which credits them first. A CANCELLED
/// booking holds only the returns still to be posted, so a cancellation that has been settled
/// frees at once. <b>Derived, never stored</b>: no ledger row moves; every member spend check
/// asks <see cref="LedgerService.GetSpendableAsync"/>, which is the balance less this.
/// </para>
///
/// <para>
/// <b>Consistent under the payer lock.</b> A collection adds to the organiser's balance and to
/// their hold in one save, so their spendable figure does not move; a return locks the organiser,
/// which is the lock every spend check already holds.
/// </para>
/// </summary>
public static class ShareHolds
{
    public static async Task<HeldCredits> ForAsync(
        MainframeDbContext db, Guid userId, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        // Bookings whose deadline can still be ahead: a stamped one that has not passed (the stamp
        // is the deadline, whatever the setting says now), or an unstamped one that started
        // within the current lapse hours plus a day (a sold end is at most a day after its start).
        var horizon = now.AddHours(-PlayerSettings.ShareLapseHours(settings)).AddDays(-1);
        var nets = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.UserId == userId && l.Type == LedgerEntryType.ShareTransfer && l.RelatedBookingId != null)
            .Join(db.Bookings.AsNoTracking().Where(b => b.ShareDeadlineAt > now || (b.ShareDeadlineAt == null && b.StartsAt >= horizon)),
                l => l.RelatedBookingId, b => (Guid?)b.Id,
                (l, b) => new { b.Id, l.AmountCredits })
            .GroupBy(x => x.Id)
            .Select(g => new { BookingId = g.Key, Net = g.Sum(x => x.AmountCredits) })
            .Where(x => x.Net > 0m)
            .ToListAsync(ct);
        if (nets.Count == 0) return HeldCredits.None;

        var ids = nets.Select(n => n.BookingId).ToList();
        var bookings = await db.Bookings.AsNoTracking().Where(b => ids.Contains(b.Id)).ToDictionaryAsync(b => b.Id, ct);

        // Cancelled bookings hold only what they will still hand back — read for all of them at
        // once, not booking by booking (review (b)).
        var pending = await PendingReturnsAsync(
            db, bookings.Values.Where(b => b.Status == BookingStatus.Cancelled && ShareLedger.PayerOf(b) == userId).ToList(), settings, now, ct);

        decimal held = 0m;
        DateTimeOffset? releases = null;
        foreach (var n in nets)
        {
            var booking = bookings[n.BookingId];
            if (ShareLedger.PayerOf(booking) != userId) continue;
            var deadline = PlayerSettings.ShareDeadline(booking, settings);
            if (now >= deadline) continue;

            var amount = booking.Status == BookingStatus.Cancelled ? pending.GetValueOrDefault(booking.Id) : n.Net;
            if (amount <= 0m) continue;
            held += Math.Min(amount, n.Net);
            releases = releases is { } r && r <= deadline ? r : deadline;
        }
        return new HeldCredits(held, releases);
    }

    /// <summary>
    /// What each cancelled booking will still hand back to its partners at the next reconcile —
    /// three reads for all of them together: their partner seats, what their payers owe, and every
    /// share row on them. The arithmetic is <see cref="ShareLedger"/>'s own, per seat.
    /// </summary>
    private static async Task<Dictionary<Guid, decimal>> PendingReturnsAsync(
        MainframeDbContext db, List<Booking> cancelled, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var result = new Dictionary<Guid, decimal>();
        if (cancelled.Count == 0) return result;
        var ids = cancelled.Select(b => b.Id).ToList();

        var seats = await db.BookingParticipants.AsNoTracking()
            .Where(p => ids.Contains(p.BookingId) && p.Seat > 1 && p.UserId != null)
            .ToListAsync(ct);
        var sums = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.RelatedBookingId != null && ids.Contains(l.RelatedBookingId.Value) && l.Type != LedgerEntryType.ShareTransfer)
            .GroupBy(l => new { Booking = l.RelatedBookingId!.Value, l.UserId })
            .Select(g => new { g.Key.Booking, g.Key.UserId, Sum = g.Sum(l => l.AmountCredits) })
            .ToListAsync(ct);
        var shareRows = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.RelatedBookingId != null && ids.Contains(l.RelatedBookingId.Value)
                        && l.Type == LedgerEntryType.ShareTransfer && l.ExternalReference != null)
            .Select(l => new { l.UserId, Reference = l.ExternalReference!, l.AmountCredits })
            .ToListAsync(ct);

        foreach (var booking in cancelled)
        {
            var payer = ShareLedger.PayerOf(booking);
            var owed = Math.Max(0m, -sums.Where(x => x.Booking == booking.Id && x.UserId == payer).Sum(x => x.Sum));
            decimal pending = 0m;
            foreach (var seat in seats.Where(p => p.BookingId == booking.Id))
            {
                var prefix = ShareLedger.Prefix(seat.Id);
                var paid = -shareRows.Where(r => r.UserId == seat.UserId && r.Reference.StartsWith(prefix, StringComparison.Ordinal))
                    .Sum(r => r.AmountCredits);
                var target = ShareLedger.TargetFor(booking, seat, owed, paid, ShareLedger.IsClosed(booking, seat, settings, now));
                pending += Math.Max(0m, paid - target);
            }
            result[booking.Id] = pending;
        }
        return result;
    }
}
