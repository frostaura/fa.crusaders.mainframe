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
public sealed record HeldMinutes(int Held, DateTimeOffset? ReleasesAt, int OwedBack = 0)
{
    public static readonly HeldMinutes None = new(0, null);

    /// <summary>Held plus owed back: the part of the balance that is not the member's to spend.</summary>
    public int Reserved => Held + OwedBack;

    /// <summary>
    /// <see cref="Held"/> broken down by release instant — one part per share deadline, soonest
    /// first, summing to <see cref="Held"/> (review round 2, C4). <b>Why:</b> "60.00 held until
    /// Fri" was one date for money that frees on two days; the wallet now says which part frees when.
    /// </summary>
    public IReadOnlyList<HeldPart> Parts { get; init; } = [];

    /// <summary>The parts as the wire carries them: <c>[{minutes, until}]</c>.</summary>
    public IEnumerable<object> WireParts()
    {
        return Parts.Select(p => new { minutes = p.Minutes, until = p.Until });
    }
}

/// <summary>Minutes held until one share deadline.</summary>
public sealed record HeldPart(int Minutes, DateTimeOffset Until);

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
    public static async Task<HeldMinutes> ForAsync(
        MainframeDbContext db, Guid userId, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var snapshot = await SnapshotAsync(db, userId, settings, now, ct);
        var parts = snapshot.Held
            .GroupBy(kv => snapshot.Deadlines[kv.Key])
            .OrderBy(g => g.Key)
            .Select(g => new HeldPart(g.Sum(kv => kv.Value), g.Key))
            .ToList();
        return new HeldMinutes(snapshot.Held.Values.Sum(), snapshot.ReleasesAt, snapshot.OwedBack(snapshot.Waiting)) { Parts = parts };
    }

    /// <summary>
    /// What may go back from <see cref="CoverageAsk.BookingId"/> to the partner on
    /// <see cref="CoverageAsk.SeatId"/> without overdrawing the organiser (review round 4):
    ///
    /// <c>min(earmark left for this return, money behind the holds not drawn by EARLIER returns)
    /// + max(0, balance − held(all) − what EARLIER returns need beyond their own earmarks)</c> —
    /// see <see cref="HoldSnapshot.CoverageFor"/>.
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
    public static async Task<int> CoverageAsync(
        MainframeDbContext db, CoverageAsk ask, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var snapshot = await SnapshotAsync(db, ask.UserId, settings, now, ct);
        var mine = snapshot.Waiting.FirstOrDefault(w => w.SeatId == ask.SeatId);
        var earlier = snapshot.Waiting.Where(w => w.SeatId != ask.SeatId && IsEarlier(w, mine, ask.SeatId)).ToList();
        return snapshot.CoverageFor(ask.BookingId, earlier, ask.Balance);
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
        var (held, releases, deadlines) = (new Dictionary<Guid, int>(), (DateTimeOffset?)null, new Dictionary<Guid, DateTimeOffset>());
        var afterCheckIn = new HashSet<Guid>();
        if (nets.Count > 0)
        {
            var ids = nets.Keys.ToList();
            var bookings = await db.Bookings.AsNoTracking().Where(b => ids.Contains(b.Id)).ToDictionaryAsync(b => b.Id, ct);

            // Cancelled bookings hold only what they will still hand back — read for all of them
            // at once, not booking by booking (review (b)).
            var cancelled = bookings.Values.Where(b => b.Status == BookingStatus.Cancelled && ShareLedger.PayerOf(b) == userId).ToList();
            var pending = (await PendingSeatReturnsAsync(db, cancelled, settings, now, ct))
                .GroupBy(p => p.BookingId).ToDictionary(g => g.Key, g => g.Sum(p => p.Pending));
            (held, releases, deadlines) = Sum(nets, bookings, pending, userId, settings, now);
            afterCheckIn.UnionWith(bookings.Values.Where(b => b.Status == BookingStatus.Cancelled && b.CheckedInAt != null).Select(b => b.Id));
        }
        return new HoldSnapshot(held, releases, await WaitingAsync(db, userId, settings, now, ct))
        {
            NotEarmarked = afterCheckIn,
            Deadlines = deadlines,
        };
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
        return (await PendingSeatReturnsAsync(db, bookings, settings, now, ct)).Where(p => p.Since is not null && p.Pending > 0).ToList();
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
    private static async Task<Dictionary<Guid, int>> NetsAsync(
        MainframeDbContext db, Guid userId, Expression<Func<Booking, bool>> window, CancellationToken ct)
    {
        var rows = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.UserId == userId && l.Type == LedgerEntryType.ShareTransfer && l.RelatedBookingId != null)
            .Join(db.Bookings.AsNoTracking().Where(window), l => l.RelatedBookingId, b => (Guid?)b.Id, (l, b) => new { b.Id, l.AmountMinutes })
            .GroupBy(x => x.Id)
            .Select(g => new { BookingId = g.Key, Net = g.Sum(x => x.AmountMinutes) })
            .ToListAsync(ct);
        return rows.Where(r => r.Net > 0).ToDictionary(r => r.BookingId, r => r.Net);
    }

    private static (Dictionary<Guid, int> PerBooking, DateTimeOffset? ReleasesAt, Dictionary<Guid, DateTimeOffset> Deadlines) Sum(
        Dictionary<Guid, int> nets, Dictionary<Guid, Booking> bookings, Dictionary<Guid, int> pending, Guid userId,
        TenantSettingsView settings, DateTimeOffset now)
    {
        var held = new Dictionary<Guid, int>();
        var deadlines = new Dictionary<Guid, DateTimeOffset>();
        DateTimeOffset? releases = null;
        foreach (var n in nets.Select(kv => new { BookingId = kv.Key, Net = kv.Value }))
        {
            var booking = bookings[n.BookingId];
            if (ShareLedger.PayerOf(booking) != userId) continue;
            var deadline = PlayerSettings.ShareDeadline(booking, settings);
            if (now >= deadline) continue;

            var amount = booking.Status == BookingStatus.Cancelled ? pending.GetValueOrDefault(booking.Id) : n.Net;
            if (amount <= 0) continue;
            held[n.BookingId] = Math.Min(amount, n.Net);
            deadlines[n.BookingId] = deadline;
            releases = releases is { } r && r <= deadline ? r : deadline;
        }
        return (held, releases, deadlines);
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
            .Select(g => new { g.Key.Booking, g.Key.UserId, Sum = g.Sum(l => l.AmountMinutes) })
            .ToListAsync(ct)).ToDictionary(x => (x.Booking, x.UserId), x => x.Sum);
        var shareRows = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.RelatedBookingId != null && ids.Contains(l.RelatedBookingId.Value)
                        && l.Type == LedgerEntryType.ShareTransfer && l.ExternalReference != null)
            .Select(l => new { l.UserId, Reference = l.ExternalReference!, l.AmountMinutes })
            .ToListAsync(ct);

        var result = new List<SeatPending>();
        foreach (var booking in bookings)
        {
            var owed = Math.Max(0, -owedBy.GetValueOrDefault((booking.Id, ShareLedger.PayerOf(booking))));
            foreach (var seat in seats.Where(p => p.BookingId == booking.Id))
            {
                var prefix = ShareLedger.Prefix(seat.Id);
                var paid = -shareRows.Where(r => r.UserId == seat.UserId && r.Reference.StartsWith(prefix, StringComparison.Ordinal))
                    .Sum(r => r.AmountMinutes);
                var target = ShareLedger.TargetFor(booking, seat, owed, paid, ShareLedger.IsClosed(booking, seat, settings, now));
                result.Add(new SeatPending(seat.Id, booking.Id, seat.ReturnPendingSince, Math.Max(0, paid - target)));
            }
        }
        return result;
    }
}

/// <summary>A return one partner seat is due: how much, on which booking, and since when it has waited (null: not waiting).</summary>
public sealed record SeatPending(Guid SeatId, Guid BookingId, DateTimeOffset? Since, int Pending);

/// <summary>Whose coverage, for a return from which booking to which seat, against which balance.</summary>
public sealed record CoverageAsk(Guid UserId, Guid BookingId, Guid SeatId, int Balance);

/// <summary>What a member has set aside: per-booking holds, the earliest release, and the returns waiting on them.</summary>
public sealed record HoldSnapshot(Dictionary<Guid, int> Held, DateTimeOffset? ReleasesAt, List<SeatPending> Waiting)
{
    /// <summary>
    /// Bookings whose hold is NOT an earmark: games cancelled after check-in (S4). Every share on
    /// one stays owed in full, so it held nothing and the organiser could spend it; its "hold" only
    /// appears once a return falls due on it — the very return being asked about (review round 5).
    /// Its returns are payable from free balance only. Its hold is still set aside from spending.
    /// </summary>
    public IReadOnlySet<Guid> NotEarmarked { get; init; } = new HashSet<Guid>();

    /// <summary>Each held booking's share deadline — when its part of <see cref="Held"/> frees (C4).</summary>
    public IReadOnlyDictionary<Guid, DateTimeOffset> Deadlines { get; init; } = new Dictionary<Guid, DateTimeOffset>();

    private int EarmarkOf(Guid bookingId) => NotEarmarked.Contains(bookingId) ? 0 : Held.GetValueOrDefault(bookingId);

    /// <summary>
    /// Coverage for a return from <paramref name="bookingId"/>, behind the <paramref name="earlier"/>
    /// waiting returns, against <paramref name="balance"/> (review rounds 4 and 5):
    /// <list type="bullet">
    ///   <item>an earlier return draws first on its own booking's earmark, and whatever it needs
    ///   beyond that on the free balance;</item>
    ///   <item>this return may use its own booking's earmark, less what earlier returns on that
    ///   booking drew — but only as far as there is money behind the holds (<c>min(balance,
    ///   held(all))</c>) that earlier returns have not drawn, so when a desk debit leaves the holds
    ///   underwater the older return is paid first;</item>
    ///   <item>plus the free balance left after every hold and every earlier return's excess.</item>
    /// </list>
    /// Never more than the balance, never below zero.
    /// </summary>
    public int CoverageFor(Guid bookingId, IReadOnlyCollection<SeatPending> earlier, int balance)
    {
        var need = earlier.GroupBy(w => w.BookingId).ToDictionary(g => g.Key, g => g.Sum(w => w.Pending));
        var drawn = need.Sum(kv => Math.Min(kv.Value, EarmarkOf(kv.Key)));
        var excess = need.Sum(kv => Math.Max(0, kv.Value - EarmarkOf(kv.Key)));
        // Only EARMARKS stand between the balance and the free money. An S4 game's hold is its own
        // pending returns — the very returns this arithmetic pays from free balance — so counting
        // it here as well charged each such return twice: it posted only once the balance reached
        // twice the return (review round 6). Spend checks still set the S4 hold aside (ForAsync).
        var held = Held.Where(kv => !NotEarmarked.Contains(kv.Key)).Sum(kv => kv.Value);

        var mine = Math.Max(0, EarmarkOf(bookingId) - need.GetValueOrDefault(bookingId));
        var backed = Math.Max(0, Math.Min(balance, held) - drawn);
        return Math.Min(mine, backed) + Math.Max(0, balance - held - excess);
    }

    /// <summary>
    /// What <paramref name="waiting"/> sets aside beyond what their own bookings already hold — a
    /// booking's hold is not counted twice when it also has a waiting return.
    /// </summary>
    public int OwedBack(IEnumerable<SeatPending> waiting) =>
        waiting.GroupBy(w => w.BookingId).Sum(g => Math.Max(0, g.Sum(w => w.Pending) - Held.GetValueOrDefault(g.Key)));
}
