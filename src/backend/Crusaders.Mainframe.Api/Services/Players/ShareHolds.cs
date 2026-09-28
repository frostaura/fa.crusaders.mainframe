using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// What a member has set aside for their partners right now: <see cref="Held"/>, shares received
/// that may still have to go back (released at the deadline, <see cref="ReleasesAt"/> the earliest),
/// and <see cref="OwedBack"/>, returns already due that are WAITING for their credits to cover them
/// (review round 3). Neither is spendable: <see cref="Reserved"/> is what every spend check takes
/// off the balance. The balance itself is untouched — both are derived, neither is a ledger row.
/// </summary>
public sealed record HeldCredits(decimal Held, DateTimeOffset? ReleasesAt, decimal OwedBack = 0m)
{
    public static readonly HeldCredits None = new(0m, null);

    /// <summary>Held plus owed back: the part of the balance that is not the member's to spend.</summary>
    public decimal Reserved => Held + OwedBack;
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
    /// <param name="excludingBookingId">
    /// Leave this booking's hold out — for the COVERAGE of a return from it: what the organiser
    /// holds for that very booking is exactly what may go back from it, so it covers, not blocks.
    /// </param>
    public static async Task<HeldCredits> ForAsync(
        MainframeDbContext db, Guid userId, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct,
        Guid? excludingBookingId = null)
    {
        var nets = await NetsAsync(db, userId, DeadlineAhead(now, UnstampedFrom(now, settings)), ct);
        nets.Remove(excludingBookingId ?? Guid.Empty);
        var (perBooking, releases) = (new Dictionary<Guid, decimal>(), (DateTimeOffset?)null);
        if (nets.Count > 0)
        {
            var ids = nets.Keys.ToList();
            var bookings = await db.Bookings.AsNoTracking().Where(b => ids.Contains(b.Id)).ToDictionaryAsync(b => b.Id, ct);

            // Cancelled bookings hold only what they will still hand back — read for all of them
            // at once, not booking by booking (review (b)).
            var pending = await PendingReturnsAsync(
                db, bookings.Values.Where(b => b.Status == BookingStatus.Cancelled && ShareLedger.PayerOf(b) == userId).ToList(), settings, now, ct);
            (perBooking, releases) = Sum(nets, bookings, pending, userId, settings, now);
        }

        var owedBack = await OwedBackAsync(db, userId, perBooking, settings, now, ct);
        owedBack.Remove(excludingBookingId ?? Guid.Empty);
        return new HeldCredits(perBooking.Values.Sum(), releases, owedBack.Values.Sum());
    }

    /// <summary>
    /// Returns WAITING on this member (a seat of a booking they pay for, stamped
    /// <c>ReturnPendingSince</c>): set aside from what they may spend exactly like a hold, whatever
    /// the booking's age (review round 3). Without it a top-up short of the whole return was
    /// spendable on a new court, the next one too, and the partner waited for ever. What a
    /// booking already holds is not counted twice. Per booking, so the caller can leave one out
    /// (a return's own coverage), as for the hold.
    /// </summary>
    private static async Task<Dictionary<Guid, decimal>> OwedBackAsync(
        MainframeDbContext db, Guid userId, Dictionary<Guid, decimal> held,
        TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var waiting = await db.BookingParticipants.AsNoTracking()
            .Where(p => p.ReturnPendingSince != null)
            .Join(db.Bookings.AsNoTracking(), p => p.BookingId, b => b.Id, (p, b) => b)
            .Where(b => (b.PaidByUserId ?? b.UserId) == userId)
            .Distinct()
            .ToListAsync(ct);
        if (waiting.Count == 0) return [];
        var pending = await PendingReturnsAsync(db, waiting, settings, now, ct);
        return pending.ToDictionary(kv => kv.Key, kv => Math.Max(0m, kv.Value - held.GetValueOrDefault(kv.Key)));
    }

    /// <summary>
    /// A booking whose deadline can still be ahead: stamped and not passed (the stamp IS the
    /// deadline, whatever the setting says now), or unstamped and started since
    /// <paramref name="unstampedFrom"/>. Indexed on <c>(TenantId, ShareDeadlineAt)</c>.
    /// </summary>
    public static Expression<Func<Booking, bool>> DeadlineAhead(DateTimeOffset now, DateTimeOffset unstampedFrom) =>
        b => b.ShareDeadlineAt > now || (b.ShareDeadlineAt == null && b.StartsAt >= unstampedFrom);

    /// <summary>The earliest start an UNSTAMPED booking's deadline can still be ahead from: the lapse hours plus a day (a sold end is at most a day after its start).</summary>
    public static DateTimeOffset UnstampedFrom(DateTimeOffset now, TenantSettingsView settings) =>
        now.AddHours(-PlayerSettings.ShareLapseHours(settings)).AddDays(-1);

    /// <summary>The member's net share rows per booking in <paramref name="window"/>, positive ones only (what they received).</summary>
    private static async Task<Dictionary<Guid, decimal>> NetsAsync(
        MainframeDbContext db, Guid userId, Expression<Func<Booking, bool>> window, CancellationToken ct)
    {
        var rows = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.UserId == userId && l.Type == LedgerEntryType.ShareTransfer && l.RelatedBookingId != null)
            .Join(db.Bookings.AsNoTracking().Where(window), l => l.RelatedBookingId, b => (Guid?)b.Id, (l, b) => new { b.Id, l.AmountCredits })
            .GroupBy(x => x.Id)
            .Select(g => new { BookingId = g.Key, Net = g.Sum(x => x.AmountCredits) })
            .ToListAsync(ct);
        return rows.Where(r => r.Net > 0m).ToDictionary(r => r.BookingId, r => r.Net);
    }

    private static (Dictionary<Guid, decimal> PerBooking, DateTimeOffset? ReleasesAt) Sum(
        Dictionary<Guid, decimal> nets, Dictionary<Guid, Booking> bookings, Dictionary<Guid, decimal> pending, Guid userId,
        TenantSettingsView settings, DateTimeOffset now)
    {
        var held = new Dictionary<Guid, decimal>();
        DateTimeOffset? releases = null;
        foreach (var n in nets.Select(kv => new { BookingId = kv.Key, Net = kv.Value }))
        {
            var booking = bookings[n.BookingId];
            if (ShareLedger.PayerOf(booking) != userId) continue;
            var deadline = PlayerSettings.ShareDeadline(booking, settings);
            if (now >= deadline) continue;

            var amount = booking.Status == BookingStatus.Cancelled ? pending.GetValueOrDefault(booking.Id) : n.Net;
            if (amount <= 0m) continue;
            held[n.BookingId] = Math.Min(amount, n.Net);
            releases = releases is { } r && r <= deadline ? r : deadline;
        }
        return (held, releases);
    }

    /// <summary>
    /// What each booking (a cancelled one, or one with a waiting return) will still hand back to
    /// its partners at the next reconcile — three reads for all of them together: their partner seats, what their payers owe, and every
    /// share row on them. The arithmetic is <see cref="ShareLedger"/>'s own, per seat.
    /// </summary>
    private static async Task<Dictionary<Guid, decimal>> PendingReturnsAsync(
        MainframeDbContext db, List<Booking> bookings, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var result = new Dictionary<Guid, decimal>();
        if (bookings.Count == 0) return result;
        var ids = bookings.Select(b => b.Id).ToList();

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

        foreach (var booking in bookings)
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
