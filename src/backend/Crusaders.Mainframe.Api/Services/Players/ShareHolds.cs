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
        // A sold end is at most a day after the start, so this bounds the read to bookings whose
        // deadline can still be ahead without computing the deadline in SQL.
        var horizon = now.AddHours(-PlayerSettings.ShareLapseHours(settings)).AddDays(-1);
        var nets = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.UserId == userId && l.Type == LedgerEntryType.ShareTransfer && l.RelatedBookingId != null)
            .Join(db.Bookings.AsNoTracking().Where(b => b.StartsAt >= horizon), l => l.RelatedBookingId, b => (Guid?)b.Id,
                (l, b) => new { b.Id, l.AmountCredits })
            .GroupBy(x => x.Id)
            .Select(g => new { BookingId = g.Key, Net = g.Sum(x => x.AmountCredits) })
            .Where(x => x.Net > 0m)
            .ToListAsync(ct);
        if (nets.Count == 0) return HeldCredits.None;

        var ids = nets.Select(n => n.BookingId).ToList();
        var bookings = await db.Bookings.AsNoTracking().Where(b => ids.Contains(b.Id)).ToDictionaryAsync(b => b.Id, ct);

        decimal held = 0m;
        DateTimeOffset? releases = null;
        foreach (var n in nets)
        {
            var booking = bookings[n.BookingId];
            if (ShareLedger.PayerOf(booking) != userId) continue;
            var deadline = PlayerSettings.ShareDeadline(booking, settings);
            if (now >= deadline) continue;

            var amount = booking.Status == BookingStatus.Cancelled
                ? await PendingReturnsAsync(db, booking, settings, now, ct)
                : n.Net;
            if (amount <= 0m) continue;
            held += Math.Min(amount, n.Net);
            releases = releases is { } r && r <= deadline ? r : deadline;
        }
        return new HeldCredits(held, releases);
    }

    /// <summary>What a cancelled booking will still hand back to its partners at the next reconcile.</summary>
    private static async Task<decimal> PendingReturnsAsync(
        MainframeDbContext db, Booking booking, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var seats = await db.BookingParticipants.AsNoTracking()
            .Where(p => p.BookingId == booking.Id && p.Seat > 1 && p.UserId != null)
            .ToListAsync(ct);
        var owed = await ShareLedger.OwedOfAsync(db, booking, ct);
        decimal pending = 0m;
        foreach (var seat in seats)
        {
            var paid = await ShareLedger.PaidOfAsync(db, seat, ct);
            var target = ShareLedger.TargetFor(booking, seat, owed, paid, ShareLedger.IsClosed(booking, seat, settings, now));
            pending += Math.Max(0m, paid - target);
        }
        return pending;
    }
}
