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
    public static async Task<HeldCredits> ForAsync(
        MainframeDbContext db, Guid userId, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var snapshot = await SnapshotAsync(db, userId, settings, now, ct);
        return new HeldCredits(snapshot.Held.Values.Sum(), snapshot.ReleasesAt, snapshot.OwedBack(snapshot.Waiting));
    }

    /// <summary>
    /// What may go back from <see cref="CoverageAsk.BookingId"/> to the partner on
    /// <see cref="CoverageAsk.SeatId"/> without overdrawing the organiser (review round 4):
    ///
    /// <c>min(balance, held(booking) + max(0, balance − held(all) − owed back to returns stamped EARLIER))</c>.
    ///
    /// <para>
    /// <b>Held money is earmarked.</b> What the organiser holds for this booking is its partners'
    /// money, so a return up to it always covers — an ordinary return (a withdrawal, a lowered
    /// share) never waits behind a return waiting on another game. <b>Waiting returns queue</b>:
    /// the free balance goes first to the return stamped first (<c>ReturnPendingSince</c>, then
    /// participant id); one not stamped yet is the newest. So two waiting returns no longer block
    /// each other when the balance covers one. Spend checks still set aside ALL of it (round 3).
    /// </para>
    ///
    /// <para>
    /// <b>Never more than the balance.</b> An earmark is only as good as the money behind it: a
    /// desk debit can take a balance below its holds, and a game cancelled after check-in "holds"
    /// the very return being asked about (its hold is its pending returns) although that share was
    /// spendable, and spent, a moment before. Capping at the balance means no return ever takes an
    /// organiser below zero without the desk's named overdraft.
    /// </para>
    /// </summary>
    public static async Task<decimal> CoverageAsync(
        MainframeDbContext db, CoverageAsk ask, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var snapshot = await SnapshotAsync(db, ask.UserId, settings, now, ct);
        var mine = snapshot.Waiting.FirstOrDefault(w => w.SeatId == ask.SeatId);
        var earlier = snapshot.Waiting.Where(w => w.SeatId != ask.SeatId && IsEarlier(w, mine, ask.SeatId)).ToList();
        var free = ask.Balance - snapshot.Held.Values.Sum() - snapshot.OwedBack(earlier);
        return Math.Max(0m, Math.Min(ask.Balance, snapshot.Held.GetValueOrDefault(ask.BookingId) + Math.Max(0m, free)));
    }

    /// <summary>First come, first served: by stamp, then by participant id. An unstamped return is the newest.</summary>
    private static bool IsEarlier(SeatPending other, SeatPending? mine, Guid mySeatId)
    {
        if (mine?.Since is not { } since) return true;
        var bySince = other.Since!.Value.CompareTo(since);
        return bySince < 0 || (bySince == 0 && other.SeatId.CompareTo(mySeatId) < 0);
    }

    /// <summary>
    /// One read of everything a member has set aside: what each booking holds for its partners
    /// (and the earliest release), and every return waiting on them with its stamp and amount.
    /// </summary>
    private static async Task<HoldSnapshot> SnapshotAsync(
        MainframeDbContext db, Guid userId, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var nets = await NetsAsync(db, userId, DeadlineAhead(now, UnstampedFrom(now, settings)), ct);
        var (held, releases) = (new Dictionary<Guid, decimal>(), (DateTimeOffset?)null);
        if (nets.Count > 0)
        {
            var ids = nets.Keys.ToList();
            var bookings = await db.Bookings.AsNoTracking().Where(b => ids.Contains(b.Id)).ToDictionaryAsync(b => b.Id, ct);

            // Cancelled bookings hold only what they will still hand back — read for all of them
            // at once, not booking by booking (review (b)).
            var cancelled = bookings.Values.Where(b => b.Status == BookingStatus.Cancelled && ShareLedger.PayerOf(b) == userId).ToList();
            var pending = (await PendingSeatReturnsAsync(db, cancelled, settings, now, ct))
                .GroupBy(p => p.BookingId).ToDictionary(g => g.Key, g => g.Sum(p => p.Pending));
            (held, releases) = Sum(nets, bookings, pending, userId, settings, now);
        }
        return new HoldSnapshot(held, releases, await WaitingAsync(db, userId, settings, now, ct));
    }

    /// <summary>
    /// Returns WAITING on this member (a seat of a booking they pay for, stamped
    /// <c>ReturnPendingSince</c>), each with its amount, whatever the booking's age (review round 3).
    /// </summary>
    private static async Task<List<SeatPending>> WaitingAsync(
        MainframeDbContext db, Guid userId, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var bookings = await db.BookingParticipants.AsNoTracking()
            .Where(p => p.ReturnPendingSince != null)
            .Join(db.Bookings.AsNoTracking(), p => p.BookingId, b => b.Id, (p, b) => b)
            .Where(b => (b.PaidByUserId ?? b.UserId) == userId)
            .Distinct()
            .ToListAsync(ct);
        if (bookings.Count == 0) return [];
        return (await PendingSeatReturnsAsync(db, bookings, settings, now, ct)).Where(p => p.Since is not null && p.Pending > 0m).ToList();
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
    /// What each partner seat of these bookings will still get back at the next reconcile — three
    /// reads for all of them together: their partner seats, what their payers owe, and every share
    /// row on them. The arithmetic is <see cref="ShareLedger"/>'s own, per seat.
    /// </summary>
    private static async Task<List<SeatPending>> PendingSeatReturnsAsync(
        MainframeDbContext db, List<Booking> bookings, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        if (bookings.Count == 0) return [];
        var ids = bookings.Select(b => b.Id).ToList();

        var seats = await db.BookingParticipants.AsNoTracking()
            .Where(p => ids.Contains(p.BookingId) && p.Seat > 1 && p.UserId != null)
            .ToListAsync(ct);
        var owedBy = (await db.LedgerEntries.AsNoTracking()
            .Where(l => l.RelatedBookingId != null && ids.Contains(l.RelatedBookingId.Value) && l.Type != LedgerEntryType.ShareTransfer)
            .GroupBy(l => new { Booking = l.RelatedBookingId!.Value, l.UserId })
            .Select(g => new { g.Key.Booking, g.Key.UserId, Sum = g.Sum(l => l.AmountCredits) })
            .ToListAsync(ct)).ToDictionary(x => (x.Booking, x.UserId), x => x.Sum);
        var shareRows = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.RelatedBookingId != null && ids.Contains(l.RelatedBookingId.Value)
                        && l.Type == LedgerEntryType.ShareTransfer && l.ExternalReference != null)
            .Select(l => new { l.UserId, Reference = l.ExternalReference!, l.AmountCredits })
            .ToListAsync(ct);

        var result = new List<SeatPending>();
        foreach (var booking in bookings)
        {
            var owed = Math.Max(0m, -owedBy.GetValueOrDefault((booking.Id, ShareLedger.PayerOf(booking))));
            foreach (var seat in seats.Where(p => p.BookingId == booking.Id))
            {
                var prefix = ShareLedger.Prefix(seat.Id);
                var paid = -shareRows.Where(r => r.UserId == seat.UserId && r.Reference.StartsWith(prefix, StringComparison.Ordinal))
                    .Sum(r => r.AmountCredits);
                var target = ShareLedger.TargetFor(booking, seat, owed, paid, ShareLedger.IsClosed(booking, seat, settings, now));
                result.Add(new SeatPending(seat.Id, booking.Id, seat.ReturnPendingSince, Math.Max(0m, paid - target)));
            }
        }
        return result;
    }
}

/// <summary>A return one partner seat is due: how much, on which booking, and since when it has waited (null: not waiting).</summary>
public sealed record SeatPending(Guid SeatId, Guid BookingId, DateTimeOffset? Since, decimal Pending);

/// <summary>Whose coverage, for a return from which booking to which seat, against which balance.</summary>
public sealed record CoverageAsk(Guid UserId, Guid BookingId, Guid SeatId, decimal Balance);

/// <summary>What a member has set aside: per-booking holds, the earliest release, and the returns waiting on them.</summary>
public sealed record HoldSnapshot(Dictionary<Guid, decimal> Held, DateTimeOffset? ReleasesAt, List<SeatPending> Waiting)
{
    /// <summary>
    /// What <paramref name="waiting"/> sets aside beyond what their own bookings already hold — a
    /// booking's hold is not counted twice when it also has a waiting return.
    /// </summary>
    public decimal OwedBack(IEnumerable<SeatPending> waiting) =>
        waiting.GroupBy(w => w.BookingId).Sum(g => Math.Max(0m, g.Sum(w => w.Pending) - Held.GetValueOrDefault(g.Key)));
}
