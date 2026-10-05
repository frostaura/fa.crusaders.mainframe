using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>One share pair this reconcile posted: positive <see cref="Delta"/> collected from the partner, negative returned to them.</summary>
public sealed record ShareMove(Guid ParticipantId, Guid PartnerUserId, Guid OrganiserUserId, int Delta, int Seq);

/// <summary>Who is reconciling, and whether one seat may be collected below zero (an admin's explicit collect).</summary>
/// <param name="ClubRemoval">The club took this seat off the game (an admin's remove): its return's receipts say so, with the reason (review round 2, B-8).</param>
public sealed record ReconcileOptions(Guid ActorUserId, Guid? OverdraftSeatId = null, ClubRemoval? ClubRemoval = null)
{
    /// <summary>
    /// The member whose own action caused this reconcile — the organiser's remove, split change or
    /// cancellation (review round 4, I4-5). Their receipts are born read, as an accept's already
    /// are; it changes nothing else (the ledger rows keep <see cref="ActorUserId"/>).
    /// </summary>
    public Guid? OwnActionBy { get; init; }

    /// <summary>
    /// R15 E15-8: the reason the desk recorded for an act whose return this reconcile posts — the
    /// settle-outside's — so both receipts carry it as a collect's and a removal's already do.
    /// </summary>
    public string? ClubReason { get; init; }
}

/// <summary>The club removed <paramref name="SeatId"/>'s member, for <paramref name="Reason"/>.</summary>
public sealed record ClubRemoval(Guid SeatId, string? Reason);

/// <summary>
/// The club's hand in a share movement (B8, review round 2 B-8): a collect (with the partner's
/// balance after it) or a removal, and the reason the admin recorded — both receipts say it.
/// </summary>
public sealed record ClubReceipt(bool Collected, int? BalanceAfter, string? Reason);

/// <summary>
/// Moves each partner's share of a split booking to or from the organiser until what they have
/// paid equals what they should have paid (D11). The one writer of
/// <see cref="LedgerEntryType.ShareTransfer"/>.
///
/// <para>
/// <b>Idempotent by construction.</b> Paid is read off the ledger (the partner's
/// <c>share:{participant}:*</c> rows), the target comes from <see cref="ShareRules"/>, and only
/// the difference is posted — so running it twice, or after every event, or from a sweep that
/// also ran a minute ago, posts nothing the second time. That is what lets it be called after
/// every participant action AND after every existing settlement path without any of those paths
/// knowing it exists: the settlement code moves the organiser's <c>Owed</c>, and this follows.
/// </para>
///
/// <para>
/// <b>A pair, in one save, under the DEBITED member's lock.</b> A collection debits the partner
/// and locks them, so their balance check is the one that counts (the <see cref="PayerLock"/>
/// argument, unchanged); a return debits the organiser and locks them. Nobody else is locked:
/// a member whose balance only rises never overspends. The pair's references — <c>share:{participant}:{seq}:out</c> and
/// <c>:in</c> — are unique in the ledger, so two reconciles racing to post the same pair lose on
/// the index rather than paying twice, and the loser re-reads and finds nothing to do.
/// </para>
///
/// <para>
/// <b>Never a debt.</b> A collection the partner cannot cover is simply not posted: the share
/// stays unpaid, payable by the partner until the deadline, after which the organiser's cover
/// stands. Only an admin's explicit collect (<see cref="ReconcileOptions.OverdraftSeatId"/>) may
/// take a partner below zero, and that is written to the change record by its caller.
/// </para>
/// </summary>
public sealed class ShareLedger
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly LedgerService _ledger;
    private readonly TenantSettingsAccessor _settings;
    private readonly RealtimeOutbox _outbox;
    private readonly ILogger<ShareLedger> _logger;

    public ShareLedger(
        MainframeDbContext db, ITenantContext tenant, LedgerService ledger, TenantSettingsAccessor settings,
        RealtimeOutbox outbox, ILogger<ShareLedger> logger)
    {
        _db = db; _tenant = tenant; _ledger = ledger; _settings = settings; _outbox = outbox; _logger = logger;
    }

    /// <summary>Every reference one seat's pairs are posted under starts with this.</summary>
    public static string Prefix(Guid participantId)
    {
        // Block body: lizard reads an interpolation's braces in an expression body as the end of the function.
        return $"{SharePrefix}{participantId:N}:";
    }

    /// <summary>What every share reference starts with, before the seat id.</summary>
    private const string SharePrefix = "share:";

    /// <summary>One leg's reference: <c>out</c> is the debited member's row, <c>in</c> the receiving one's.</summary>
    public static string Reference(Guid participantId, int seq, string leg)
    {
        return $"{Prefix(participantId)}{seq}:{leg}";
    }

    /// <summary>
    /// The organiser's <c>Owed(b)</c> (settlement model §1): every row naming the booking on the
    /// payer's wallet, negated — share transfers excepted, because they are between the players and
    /// not between a player and the club.
    /// </summary>
    public Task<int> OwedAsync(Booking booking, CancellationToken ct) => OwedOfAsync(_db, booking, ct);

    /// <summary>What this seat's partner has paid the organiser, net — read off their own share rows.</summary>
    public Task<int> PaidAsync(BookingParticipant seat, CancellationToken ct) => PaidOfAsync(_db, seat, ct);

    /// <summary><see cref="OwedAsync"/> on a given context — for a reader that cannot take this service (the hold).</summary>
    public static async Task<int> OwedOfAsync(MainframeDbContext db, Booking booking, CancellationToken ct)
    {
        var payer = PayerOf(booking);
        var sum = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.RelatedBookingId == booking.Id && l.UserId == payer && l.Type != LedgerEntryType.ShareTransfer)
            .SumAsync(l => (int?)l.AmountMinutes, ct) ?? 0;
        return Math.Max(0, -sum);
    }

    /// <summary><see cref="PaidAsync"/> on a given context.</summary>
    public static async Task<int> PaidOfAsync(MainframeDbContext db, BookingParticipant seat, CancellationToken ct)
    {
        if (seat.UserId is not { } partner) return 0;
        var prefix = Prefix(seat.Id);
        var sum = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.UserId == partner && l.Type == LedgerEntryType.ShareTransfer
                        && l.ExternalReference != null && l.ExternalReference.StartsWith(prefix))
            .SumAsync(l => (int?)l.AmountMinutes, ct) ?? 0;
        return -sum;
    }

    /// <summary>
    /// <see cref="PaidOfAsync"/> for many seats in ONE read (review round 5, P5-5): the wallet's
    /// share summaries awaited one sum per seat — 37 connection opens for a page of twenty bookings.
    /// Same rows, same sign: each seat's own <c>share:{seat}:*</c> rows on its partner's wallet,
    /// grouped by the seat id the reference carries. A seat with no partner, or nothing paid, is 0.
    /// </summary>
    public static async Task<Dictionary<Guid, int>> PaidOfManyAsync(
        MainframeDbContext db, IReadOnlyCollection<BookingParticipant> seats, CancellationToken ct)
    {
        var result = seats.Select(s => s.Id).Distinct().ToDictionary(id => id, _ => 0);
        var bySeat = seats.Where(s => s.UserId is not null).DistinctBy(s => s.Id).ToDictionary(s => s.Id.ToString("N"), s => s);
        if (bySeat.Count == 0) return result;

        var keys = bySeat.Keys.ToList();
        var partners = bySeat.Values.Select(s => s.UserId!.Value).Distinct().ToList();
        var start = SharePrefix.Length;
        var sums = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.Type == LedgerEntryType.ShareTransfer && partners.Contains(l.UserId)
                        && l.ExternalReference != null && l.ExternalReference.StartsWith(SharePrefix)
                        && keys.Contains(l.ExternalReference.Substring(start, 32)))
            .GroupBy(l => new { Seat = l.ExternalReference!.Substring(start, 32), l.UserId })
            .Select(g => new { g.Key.Seat, g.Key.UserId, Sum = g.Sum(l => l.AmountMinutes) })
            .ToListAsync(ct);

        foreach (var row in sums)
        {
            if (bySeat.TryGetValue(row.Seat, out var seat) && seat.UserId == row.UserId) result[seat.Id] = -row.Sum;
        }
        return result;
    }

    /// <summary>
    /// What has come BACK to this seat's partner (review round 2, F2-4): the sum of the return legs
    /// on their wallet (<c>share:{seat}:*</c> rows with a positive amount). <see cref="PaidOfAsync"/>
    /// nets these out, so a cancelled game's detail read "paid 0" and nobody could see the refund.
    ///
    /// <para>
    /// <b><paramref name="since"/></b> keeps only the returns posted from that instant on — the
    /// booking's cancellation (review round 4, M4-4): a partner whose share was lowered from 31 to
    /// 25 and then refunded read "31.00 back" for a cancellation that returned 25.
    /// </para>
    /// </summary>
    public static async Task<int> ReturnedOfAsync(
        MainframeDbContext db, BookingParticipant seat, CancellationToken ct, DateTimeOffset? since = null)
    {
        if (seat.UserId is not { } partner) return 0;
        var prefix = Prefix(seat.Id);
        var rows = db.LedgerEntries.AsNoTracking()
            .Where(l => l.UserId == partner && l.Type == LedgerEntryType.ShareTransfer && l.AmountMinutes > 0
                        && l.ExternalReference != null && l.ExternalReference.StartsWith(prefix));
        if (since is { } from) rows = rows.Where(l => l.CreatedAt >= from);
        return await rows.SumAsync(l => (int?)l.AmountMinutes, ct) ?? 0;
    }

    /// <summary>
    /// A seat that can no longer be collected from: it lapsed, or its share deadline has passed
    /// (the sweep stamps <c>LapsedAt</c> a minute late at worst; the clock is not).
    /// </summary>
    public static bool IsClosed(Booking booking, BookingParticipant seat, TenantSettingsView settings, DateTimeOffset now) =>
        seat.LapsedAt is not null || now >= PlayerSettings.ShareDeadline(booking, settings);

    /// <summary>
    /// What this seat's partner would still pay if they paid now — the full ask, as if they had
    /// consented to all of it, less what they have paid. The "unpaid" of every screen and sweep.
    /// Nothing, once the seat has closed — unless <paramref name="evenIfClosed"/>: what the seat
    /// fell short by, for the lapse that records it and the admin collect that may still take it.
    /// </summary>
    public async Task<int> UnpaidAsync(Booking booking, BookingParticipant seat, CancellationToken ct, bool evenIfClosed = false)
    {
        var asked = new BookingParticipant
        {
            Id = seat.Id,
            TenantId = seat.TenantId,
            BookingId = seat.BookingId,
            Seat = seat.Seat,
            UserId = seat.UserId,
            GuestName = seat.GuestName,
            Status = ParticipantStatus.Accepted,
            ShareMinutes = seat.ShareMinutes,
            ConsentedMinutes = Math.Max(seat.ConsentedMinutes, seat.ShareMinutes),
            SettledOutsideAt = seat.SettledOutsideAt,
        };
        var paid = await PaidAsync(seat, ct);
        var closed = !evenIfClosed && IsClosed(booking, seat, await _settings.GetAsync(ct), DateTimeOffset.UtcNow);
        var target = TargetFor(booking, asked, await OwedAsync(booking, ct), paid, closed);
        return Math.Max(0, target - paid);
    }

    /// <summary>
    /// The target for one seat against one booking, given the organiser's current <c>Owed</c>,
    /// what the partner has paid, and whether the seat has closed (see <see cref="ShareFacts"/>).
    /// </summary>
    public static int TargetFor(Booking booking, BookingParticipant seat, int owed, int paid = 0, bool closed = false)
    {
        return ShareRules.TargetFor(new ShareFacts(
            seat.Status, seat.IsPartner && seat.UserId is not null, seat.SettledOutsideAt is not null,
            seat.ShareMinutes, seat.ConsentedMinutes, booking.Status, booking.CheckedInAt is not null,
            booking.CancellationReason == BookingService.ResoldTailRefunded, booking.AmountChargedMinutes, owed,
            paid, closed));
    }

    public static Guid PayerOf(Booking booking) => booking.PaidByUserId ?? booking.UserId ?? Guid.Empty;

    /// <summary>
    /// A booking whose court is being paid for by more than one member: any partner seat still
    /// asked for a share, or any share already moved. The pay-for-at-the-box path (P7) refuses
    /// these with <c>split_booking</c> (<see cref="Endpoints.DevicePayForEndpoint.SplitBooking"/>, the
    /// code the box firmware and the device corpus already pin — it paints SPLIT BOOKING / PAY IN
    /// APP) — a stranger paying the organiser's price would leave the
    /// partners' shares paid to somebody who no longer bore the court.
    /// </summary>
    public Task<bool> IsSplitAsync(Guid bookingId, CancellationToken ct) => BookingPlayerQueries.IsSplitAsync(_db, bookingId, ct);

    /// <summary>
    /// Brings every partner seat of this booking to its target. Safe to call at any time, any
    /// number of times; answers the pairs it actually posted.
    /// </summary>
    public async Task<IReadOnlyList<ShareMove>> ReconcileAsync(Guid bookingId, CancellationToken ct, ReconcileOptions? options = null)
    {
        // Waiting returns first, first come first served (stamp, then participant id), so the
        // receipts and the log read in the order the coverage rule already pays them (round 5).
        var seats = await _db.BookingParticipants.AsNoTracking()
            .Where(p => p.BookingId == bookingId && p.Seat > 1 && p.UserId != null)
            .OrderBy(p => p.ReturnPendingSince == null).ThenBy(p => p.ReturnPendingSince).ThenBy(p => p.Id)
            .Select(p => p.Id)
            .ToListAsync(ct);
        if (seats.Count == 0) return [];

        var moves = new List<ShareMove>();
        foreach (var seatId in seats)
        {
            if (await ReconcileSeatAsync(bookingId, seatId, options ?? new ReconcileOptions(Guid.Empty), ct) is { } move)
            {
                moves.Add(move);
            }
        }
        return moves;
    }

    /// <summary>
    /// One seat: estimate unlocked to learn whom to lock, then decide again under that lock. A race
    /// lost on a reference is retried against the winner's rows, where the difference is zero.
    /// </summary>
    private async Task<ShareMove?> ReconcileSeatAsync(Guid bookingId, Guid seatId, ReconcileOptions options, CancellationToken ct)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var estimate = await DeltaAsync(bookingId, seatId, options, ct);
            if (estimate is { Delta: >= 0, Seat.ReturnPendingSince: not null }) await ClearStaleWaitAsync(bookingId, seatId, PayerOf(estimate.Booking), options, ct);
            if (estimate is not { } first || first.Delta == 0) return null;

            var debited = first.Delta > 0 ? first.Seat.UserId!.Value : PayerOf(first.Booking);
            try
            {
                return await PostUnderLockAsync(bookingId, seatId, debited, options, ct);
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex))
            {
                _logger.LogInformation("Share reconcile of seat {Seat} lost a race; re-reading", seatId);
                _db.ChangeTracker.Clear();
            }
        }
        return null;
    }

    private sealed record SeatDelta(Booking Booking, BookingParticipant Seat, int Target, int Paid)
    {
        public int Delta => Target - Paid;
    }

    private async Task<SeatDelta?> DeltaAsync(Guid bookingId, Guid seatId, ReconcileOptions options, CancellationToken ct)
    {
        var booking = await _db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        var seat = await _db.BookingParticipants.AsNoTracking().FirstOrDefaultAsync(p => p.Id == seatId, ct);
        if (booking?.UserId is null || seat?.UserId is null) return null;

        // Closed means no collection, ever — the admin's explicit collect of THIS seat excepted.
        var closed = options.OverdraftSeatId != seatId
                     && IsClosed(booking, seat, await _settings.GetAsync(ct), DateTimeOffset.UtcNow);
        var paid = await PaidAsync(seat, ct);
        return new SeatDelta(booking, seat, TargetFor(booking, seat, await OwedAsync(booking, ct), paid, closed), paid);
    }

    private async Task<ShareMove?> PostUnderLockAsync(
        Guid bookingId, Guid seatId, Guid debited, ReconcileOptions options, CancellationToken ct)
    {
        await using var payerLock = await PayerLock.BeginAsync(_db, _tenant.TenantId, debited, _outbox, ct);

        // Decided again under the lock: the unlocked read chose WHOM to lock, this one decides.
        if (await DeltaAsync(bookingId, seatId, options, ct) is not { } now || now.Delta == 0) return null;
        var collecting = now.Delta > 0;
        var partner = now.Seat.UserId!.Value;
        if ((collecting ? partner : PayerOf(now.Booking)) != debited) return null;

        // Spendable, not balance: shares the partner has received as an organiser elsewhere are
        // held for their own partners' returns and are not theirs to pay with.
        if (collecting && options.OverdraftSeatId != seatId
            && await _ledger.GetSpendableAsync(partner, ct) < now.Delta)
        {
            // Unpaid, not owed. Payable by the partner until the deadline; never a debt.
            return null;
        }

        // A return posts only when it is COVERED (review rounds 2 and 4 — keyed on coverage, never on
        // the deadline): this booking's own hold, earmarked for its partners, plus the balance left
        // free after every hold and every return that started waiting EARLIER. So an ordinary
        // return always is, and waiting returns are paid first come first served; one that is not — a hold released at the deadline and spent, or a share a cancellation
        // after check-in let them spend — WAITS: stamped, both sides told once, retried by the
        // sweep (however old) and by any minutes the organiser receives. Never a silent overdraft:
        // only the desk's named overdraft (OverdraftSeatId) posts it regardless.
        if (!collecting && options.OverdraftSeatId != seatId
            && await _ledger.GetCoverageAsync(debited, bookingId, seatId, ct) < -now.Delta)
        {
            await MarkWaitingAsync(now.Booking, now.Seat, -now.Delta, ct);
            await payerLock.CommitAsync(ct);
            return null;
        }
        if (!collecting && now.Seat.ReturnPendingSince is not null) await ClearWaitingAsync(seatId, debited, ct);

        var seq = await NextSeqAsync(seatId, partner, ct);
        var move = new ShareMove(seatId, partner, PayerOf(now.Booking), now.Delta, seq);
        var why = await StageReceiptsAsync(now.Booking, move, options, ct, RemovalReceipt(options, move));
        // R14 E14-2: the person whose act moved it is the rows' actor, as on the refund beside them.
        await _ledger.PostManyAsync(Pair(now.Booking, move, why.ActorUserId ?? options.ActorUserId, why), ct);
        await payerLock.CommitAsync(ct);
        return move;
    }

    /// <summary>
    /// Stamps a seat's return as waiting — the first time only — and, in the same commit, tells
    /// the partner and the organiser once (<see cref="MemberEventCatalogue.ReturnWaiting"/>). A
    /// sweep or reconcile that finds it still waiting finds the stamp and says nothing again.
    /// </summary>
    private async Task MarkWaitingAsync(Booking booking, BookingParticipant seat, int amount, CancellationToken ct)
    {
        var at = DateTimeOffset.UtcNow.Storable();
        var stamped = await _db.BookingParticipants
            .Where(p => p.Id == seat.Id && p.ReturnPendingSince == null)
            .ExecuteUpdateAsync(u => u.SetProperty(p => p.ReturnPendingSince, at), ct);
        if (stamped == 0) return;

        var settings = await _settings.GetAsync(ct);
        var game = await GameText.ForAsync(_db, booking, settings, ct);
        var organiser = PayerOf(booking);
        var names = await PersonNames.ForAsync(_db, [seat.UserId, organiser], ct);
        var key = $"return-waiting:{seat.Id:N}:{at.UtcTicks}";
        foreach (var (to, other, toOrganiser) in new[]
                 {
                     (seat.UserId!.Value, PersonNames.Of(organiser, names) ?? "The organiser", false),
                     (organiser, PersonNames.Of(seat.UserId, names) ?? "Your partner", true),
                 })
        {
            MemberNotices.Stage(_db, _tenant.TenantId, new MemberNotice(
                to, MemberEventCatalogue.ReturnWaiting, $"{key}:{(toOrganiser ? "organiser" : "partner")}",
                new ReturnWaitingPayload(booking.Id, other, game.CourtName, game.StartsLocal, amount, toOrganiser, seat.Id, OffGame: !seat.IsLive),
                toOrganiser ? $"{Cr(amount)} for {other} is waiting on your balance" : $"{Cr(amount)} of your share is on its way back",
                BookingPath(booking.Id, !toOrganiser && !seat.IsLive ? seat.Id : null), booking.Id), settings);
        }
        await _db.SaveChangesAsync(ct);
        await _ledger.PublishSetAsideAsync(organiser, ct);
    }

    private static string Cr(int amount) => MoneyFormat.Minutes(amount);

    /// <summary>
    /// R13 J13-3: the app path a notice links to — the booking, or for a reader no longer on it
    /// (<paramref name="offGameSeat"/>) the booking naming their seat, which the page answers with
    /// what became of them rather than "Booking not found".
    /// </summary>
    internal static string BookingPath(Guid bookingId, Guid? offGameSeat)
    {
        return offGameSeat is { } seat ? $"/bookings/{bookingId}?seat={seat}" : $"/bookings/{bookingId}";
    }

    /// <summary>A return caused by the club's removal of THIS seat is told as the club's (review round 2, B-8); anything else is not.</summary>
    private static ClubReceipt? RemovalReceipt(ReconcileOptions options, ShareMove move)
    {
        if (options.ClubRemoval is not { } removal || removal.SeatId != move.ParticipantId || move.Delta >= 0) return null;
        return new ClubReceipt(false, null, removal.Reason);
    }

    /// <summary>
    /// The unlocked estimate saw a stamp and nothing owed back: decided again under the ORGANISER's
    /// lock before the stamp is cleared (2026-09-30). The estimate is several reads, so it could see
    /// the seat stamped before a return posted and the ledger after — and by its clear, a NEW return
    /// could have started waiting on the same seat. An unconditional clear there wiped that fresh
    /// stamp: due, unpaid, out of owed-back, and past the sweep's week never retried. Stamps are only
    /// set, and returns only posted, under this lock, so the re-read here cannot be overtaken.
    /// </summary>
    private async Task ClearStaleWaitAsync(Guid bookingId, Guid seatId, Guid organiser, ReconcileOptions options, CancellationToken ct)
    {
        await using var organiserLock = await PayerLock.BeginAsync(_db, _tenant.TenantId, organiser, _outbox, ct);
        if (await DeltaAsync(bookingId, seatId, options, ct) is { Delta: >= 0, Seat.ReturnPendingSince: not null } now
            && PayerOf(now.Booking) == organiser)
        {
            await ClearWaitingAsync(seatId, organiser, ct);
        }
        await organiserLock.CommitAsync(ct);
    }

    /// <summary>The seat's return has posted, or is no longer due: it is not waiting any more.</summary>
    /// <remarks>The organiser's owed-back falls with it, so their live wallet is told.</remarks>
    private async Task ClearWaitingAsync(Guid seatId, Guid organiserId, CancellationToken ct)
    {
        var cleared = await _db.BookingParticipants.Where(p => p.Id == seatId && p.ReturnPendingSince != null)
            .ExecuteUpdateAsync(u => u.SetProperty(p => p.ReturnPendingSince, (DateTimeOffset?)null), ct);
        if (cleared > 0) await _ledger.PublishSetAsideAsync(organiserId, ct);
    }

    /// <summary>
    /// A collection of <paramref name="delta"/> from the seat's partner, built and its receipts
    /// staged — for a caller that already holds the partner's lock and owns the save (the accept,
    /// which must commit the seat's new state and its first payment as one decision).
    /// </summary>
    public async Task<IReadOnlyList<LedgerPosting>> StageCollectionAsync(
        Booking booking, BookingParticipant seat, int delta, Guid actorUserId, CancellationToken ct)
    {
        var partner = seat.UserId ?? throw new InvalidOperationException("a seat with no member pays nothing");
        var move = new ShareMove(seat.Id, partner, PayerOf(booking), delta, await NextSeqAsync(seat.Id, partner, ct));
        var why = await StageReceiptsAsync(booking, move, new ReconcileOptions(actorUserId), ct);
        return Pair(booking, move, actorUserId, why);
    }

    /// <summary>What an admin's collect actually moved, and the partner's balance either side of it.</summary>
    public sealed record Collected(ShareMove Move, int BalanceBefore, int BalanceAfter);

    /// <summary>
    /// An admin's explicit collect (R19 posture, applied to shares): the seat's consent raised to
    /// its share, the rest of the share collected whatever the partner's balance — even past the
    /// deadline — and the change-log line staged by <paramref name="record"/> with the figure
    /// actually posted. ONE transaction under the partner's lock, so the record, the consent and
    /// the money land together or not at all. Null when there is nothing to collect (nothing is
    /// written); throws <see cref="DbUpdateException"/> when the pair could not post (nothing is
    /// written either).
    /// </summary>
    public async Task<Collected?> CollectAsync(
        Guid bookingId, Guid seatId, Guid actorUserId, Func<BookingParticipant, int, int, Task> record, CancellationToken ct,
        string? reason = null)
    {
        var partner = await _db.BookingParticipants.AsNoTracking().Where(p => p.Id == seatId).Select(p => p.UserId).FirstOrDefaultAsync(ct);
        if (partner is not { } partnerId) return null;

        await using var payerLock = await PayerLock.BeginAsync(_db, _tenant.TenantId, partnerId, _outbox, ct);
        var booking = await _db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        var seat = await _db.BookingParticipants.FirstOrDefaultAsync(p => p.Id == seatId && p.BookingId == bookingId, ct);
        if (booking?.UserId is null || seat is null || seat.UserId != partnerId) return null;

        seat.ConsentedMinutes = seat.ShareMinutes;
        seat.UpdatedAt = DateTimeOffset.UtcNow.Storable();
        var paid = await PaidAsync(seat, ct);
        var delta = TargetFor(booking, seat, await OwedAsync(booking, ct), paid, closed: false) - paid;
        if (delta <= 0)
        {
            _db.ChangeTracker.Clear();
            return null;
        }

        var before = await _ledger.GetBalanceAsync(partnerId, ct);
        var move = new ShareMove(seatId, partnerId, PayerOf(booking), delta, await NextSeqAsync(seatId, partnerId, ct));
        await record(seat, delta, before);
        var why = await StageReceiptsAsync(booking, move, new ReconcileOptions(actorUserId), ct, new ClubReceipt(true, before - delta, reason));
        try
        {
            await _ledger.PostManyAsync(Pair(booking, move, actorUserId, why), ct);
        }
        catch (DbUpdateException)
        {
            _db.ChangeTracker.Clear();
            throw;
        }
        await payerLock.CommitAsync(ct);
        return new Collected(move, before, before - delta);
    }

    /// <summary>The next pair number for a seat: one past the pairs its partner's rows already carry.</summary>
    private async Task<int> NextSeqAsync(Guid seatId, Guid partner, CancellationToken ct)
    {
        var prefix = Prefix(seatId);
        // Pairs, not rows: each pair puts exactly one row on the partner's wallet.
        var rows = await _db.LedgerEntries.AsNoTracking()
            .CountAsync(l => l.UserId == partner && l.Type == LedgerEntryType.ShareTransfer
                             && l.ExternalReference != null && l.ExternalReference.StartsWith(prefix), ct);
        return rows + 1;
    }

    /// <summary>
    /// The two legs. A collection debits the partner (<c>out</c>) and pays the organiser
    /// (<c>in</c>); a return debits the organiser and pays the partner. Same type, opposite
    /// signs, both naming the booking — so every per-booking sum and every club total is unmoved.
    /// </summary>
    /// <param name="why">Why it moved, for the live wallet frame (E11-1); never stored.</param>
    public static IReadOnlyList<LedgerPosting> Pair(Booking booking, ShareMove move, Guid actorUserId, ShareWhy? why = null)
    {
        var amount = Math.Abs(move.Delta);
        var (debited, received) = move.Delta > 0
            ? (move.PartnerUserId, move.OrganiserUserId)
            : (move.OrganiserUserId, move.PartnerUserId);
        var reason = move.Delta > 0 ? "Share of a split booking" : "Share of a split booking returned";
        return
        [
            new LedgerPosting(debited, LedgerEntryType.ShareTransfer, -amount, actorUserId, booking.Id, reason,
                Reference(move.ParticipantId, move.Seq, "out")) { Share = why },
            new LedgerPosting(received, LedgerEntryType.ShareTransfer, amount, actorUserId, booking.Id, reason,
                Reference(move.ParticipantId, move.Seq, "in")) { Share = why },
        ];
    }

    /// <summary>
    /// Both receipts, staged in the pair's own save — one per member, keyed on the pair, so a pair
    /// that rolls back leaves no receipt and a committed one cannot lose it.
    /// </summary>
    /// <param name="club">
    /// Set when the CLUB moved it: a collect (the partner's balance after it — both receipts say the
    /// club did it, and the partner's where their balance stands, B8) or a removal's return; either
    /// way with the admin's reason (review round 2, B-8).
    /// </param>
    /// <param name="who">Who moved it (<see cref="ReconcileOptions.ActorUserId"/>) and whose own action it was (<see cref="ReconcileOptions.OwnActionBy"/>).</param>
    /// <returns>Why it moved, for the live wallet frame (E11-1).</returns>
    private async Task<ShareWhy> StageReceiptsAsync(Booking booking, ShareMove move, ReconcileOptions who, CancellationToken ct, ClubReceipt? club = null)
    {
        bool Own(Guid reader) => who.ActorUserId == reader || who.OwnActionBy == reader;
        var settings = await _settings.GetAsync(ct);
        var game = await GameText.ForAsync(_db, booking, settings, ct);
        var f = await ReceiptFactsAsync(booking, move, club, ct);
        var names = await PersonNames.ForAsync(_db, [move.PartnerUserId, move.OrganiserUserId, f.Scanner], ct);
        var partnerName = PersonNames.Of(move.PartnerUserId, names) ?? "Your partner";
        var organiserName = PersonNames.Of(move.OrganiserUserId, names) ?? "The organiser";
        var scannerName = PersonNames.Of(f.Scanner, names);
        var amount = Math.Abs(move.Delta);
        var key = $"share:{move.ParticipantId:N}:{move.Seq}";

        var (partnerSide, organiserSide) = move.Delta > 0
            ? (ShareDirection.Paid, ShareDirection.Received)
            : (ShareDirection.Refunded, ShareDirection.Returned);

        // B12: what an organiser receives is held to the booking's deadline (D11); the receipt says until when.
        var heldUntil = organiserSide == ShareDirection.Received
            ? GameText.Local(PlayerSettings.ShareDeadline(booking, settings), settings)
            : null;
        (club, var seat, var refund, var kept, var cause, var cancel) = (f.Club, f.Seat, f.Refund, f.Kept, f.Cause, f.Cancel);
        var byClub = club?.Collected == true;
        var removed = club is { Collected: false };
        // R15 E15-8: a settle-outside's return carries the desk's reason, as a collect's and a removal's do.
        var reason = ClubReasonOf(club) ?? (cause == WalletShareCauses.ClubSettled ? ClubReasonOf(new ClubReceipt(false, null, who.ClubReason)) : null);
        var attended = f.Attended;
        var actor = ActorOf(new ActorFacts(who, move, cause, f.Scanner, cancel, seat));
        var why = new HeadlineWhy(byClub, attended, refund, kept)
        {
            Withdrew = seat.Withdrew,
            Cause = cause,
            Game = game,
            CancelledByClub = cancel?.ByClub,
        };
        var told = new ShareTold(PayloadCause(cause), cancel?.By);

        // R15 J15-5: a share taken again names whose check-in it was, to each reader.
        var partnerScan = new ScanWords(attended ? f.Scanner : null, scannerName, move.PartnerUserId);
        var organiserScan = new ScanWords(attended ? f.Scanner : null, scannerName, move.OrganiserUserId);

        Stage(new SharePayload(booking.Id, partnerSide, organiserName, game.CourtName, game.StartsLocal, amount,
                ByClub: byClub, BalanceAfterMinutes: club?.BalanceAfter, ClubRemoved: removed, ClubReason: reason,
                AfterAttendance: attended, ClubRefund: refund, KeptMinutes: kept, Withdrew: seat.Withdrew, OffGameSeatId: seat.OffGame)
        {
            Cause = told.Cause,
            CancelledBy = told.CancelledBy,
            ScannerName = partnerScan.OtherName,
            ScannedByReader = partnerScan.Mine,
        },
            move.PartnerUserId, $"{key}:partner", HeadlineFor(partnerSide, organiserName, amount, why with { Scan = partnerScan }), settings,
            Own(move.PartnerUserId));
        Stage(new SharePayload(booking.Id, organiserSide, partnerName, game.CourtName, game.StartsLocal, amount,
                HeldUntilLocal: heldUntil, ByClub: byClub, ClubRemoved: removed, ClubReason: reason, AfterAttendance: attended,
                ClubRefund: refund, KeptMinutes: kept, Withdrew: seat.Withdrew)
        {
            Cause = told.Cause,
            CancelledBy = told.CancelledBy,
            ScannerName = organiserScan.OtherName,
            ScannedByReader = organiserScan.Mine,
        },
            move.OrganiserUserId, $"{key}:organiser", HeadlineFor(organiserSide, partnerName, amount, why with { Scan = organiserScan }), settings,
            Own(move.OrganiserUserId));
        return new ShareWhy(cause, kept, f.Scanner)
        {
            ActorUserId = actor,
            ActorIsPlayer = IsPlayer(actor, booking, move),
        };
    }

    /// <summary>
    /// R15 J15-5: whose late check-in made a session attended, as one reader is told it — their own
    /// (<see cref="Mine"/>), somebody else by name (<see cref="OtherName"/>), or nobody on the record.
    /// </summary>
    private sealed record ScanWords(Guid? Scanner, string? Name, Guid Reader)
    {
        public bool Mine => Scanner == Reader;

        public string? OtherName => Scanner is { } s && s != Reader ? Name : null;

        /// <summary>"you checked in" / "Olive Organiser checked in" / null.</summary>
        public string? Clause()
        {
            if (Mine) return "you checked in";
            return OtherName is { Length: > 0 } name ? $"{name} checked in" : null;
        }
    }

    /// <summary>R14 E14-2: <paramref name="actor"/> is on the game — its organiser or this pair's partner — so members may be told their name.</summary>
    private static bool IsPlayer(Guid? actor, Booking booking, ShareMove move)
    {
        return actor is { } a && (a == move.PartnerUserId || a == move.OrganiserUserId || a == booking.UserId);
    }

    /// <summary>The admin's recorded reason for a club collect or removal, trimmed; null when there is none (B-8).</summary>
    private static string? ClubReasonOf(ClubReceipt? club)
    {
        return club?.Reason?.Trim() is { Length: > 0 } r ? r : null;
    }

    /// <summary>Everything a receipt is worded from, read once (see <see cref="ReceiptFactsAsync"/>).</summary>
    private sealed record ReceiptFacts(
        ClubReceipt? Club, SeatFacts Seat, string? Refund, int? Kept, bool Attended, string Cause, BookingCancellation? Cancel, Guid? Scanner);

    /// <summary>
    /// Why this share moved, read off the booking, the seat and the record: a club refund's cause
    /// (E10-7), the seat's fate, the club's hand (a removal's record counts — R14 X14-2: a removal's
    /// return that waited for cover is still the club's), a re-collection after a late check-in (R9
    /// E9-2) and its scanner, a no-show's kept part (R11 E11-2), and who cancelled (R14 J14-8).
    /// </summary>
    private async Task<ReceiptFacts> ReceiptFactsAsync(Booking booking, ShareMove move, ClubReceipt? club, CancellationToken ct)
    {
        var refund = RefundCauseOf(booking, move, club);
        var seat = await SeatFacts.ReadAsync(_db, move, club, refund, ct);
        if (club is null && seat.Removal is { ByClub: true }) club = new ClubReceipt(false, null, null);
        var attended = club is null && move.Delta > 0 && booking.NoShowReversedAt is not null;
        var kept = refund == ShareRefundCauses.NoShow ? await KeptOfNoShowAsync(move, Math.Abs(move.Delta), ct) : null;
        var cause = CauseOf(booking, move, club, attended, refund, seat);
        var cancel = cause == WalletShareCauses.BookingCancelled ? await BookingCancellation.ForAsync(_db, booking, ct) : null;
        var scanner = attended ? await ScannerOfAsync(booking, ct) : null;
        return new ReceiptFacts(club, seat, refund, kept, attended, cause, cancel, scanner);
    }

    /// <summary>R14 J14-8 / X14-2: what both receipts' mails say of why — the cause they word themselves, and who cancelled.</summary>
    private sealed record ShareTold(string? Cause, string? CancelledBy);

    /// <summary>The causes a receipt's mail words for itself (R14 J14-8 / X14-2); null for the rest, which carry their own flags.</summary>
    private static string? PayloadCause(string cause)
    {
        return cause is WalletShareCauses.OrganiserRemoved or WalletShareCauses.SplitChanged or WalletShareCauses.BookingCancelled
            or WalletShareCauses.ClubSettled ? cause : null;
    }

    /// <summary>What <see cref="ActorOf"/> decides from.</summary>
    private sealed record ActorFacts(
        ReconcileOptions Who, ShareMove Move, string Cause, Guid? Scanner, BookingCancellation? Cancel, SeatFacts Seat);

    /// <summary>
    /// R14 E14-2 / E14-3: the person whose act moved this share — the caller's named actor, else read
    /// off the facts: the scanner whose late check-in made it attended, whoever cancelled (the
    /// record's actor), the partner who withdrew, the organiser who took them off or changed the
    /// split. Null when the club's system did it. A return that waited for cover and posts on a
    /// sweep is still the act that caused it, so the Night and the CSV say who. Review L1/M1: an act
    /// is only ever named off its record — never assumed to be the organiser's. Review L2: a partner
    /// paying their own share is the expected case and names nobody on the frame.
    /// </summary>
    private static Guid? ActorOf(ActorFacts f)
    {
        if (f.Cause == WalletShareCauses.SharePaid) return null;
        if (f.Who.ActorUserId != Guid.Empty) return f.Who.ActorUserId;
        return f.Cause switch
        {
            WalletShareCauses.Attended => f.Scanner,
            WalletShareCauses.BookingCancelled => f.Cancel?.ActorUserId,
            WalletShareCauses.ShareReturned => f.Move.PartnerUserId,
            WalletShareCauses.OrganiserRemoved or WalletShareCauses.ClubRemoved => f.Seat.Removal?.ActorUserId,
            WalletShareCauses.SplitChanged => f.Seat.Split?.ActorUserId,
            _ => null,
        };
    }

    /// <summary>
    /// R12 E12-2 (C2): whose scan made a reversed session attended — the seat stamped at the
    /// booking's check-in (the reversal stamps the scanner's own seat), else the booker, whose
    /// check-in stamps no seat when they hold none.
    /// </summary>
    private async Task<Guid?> ScannerOfAsync(Booking booking, CancellationToken ct)
    {
        if (booking.CheckedInAt is not { } at) return null;
        var seat = await _db.BookingParticipants.AsNoTracking()
            .Where(p => p.BookingId == booking.Id && p.CheckedInAt == at && p.UserId != null)
            .OrderBy(p => p.Seat)
            .Select(p => p.UserId)
            .FirstOrDefaultAsync(ct);
        return seat ?? booking.UserId;
    }

    /// <summary>
    /// R11 E11-2: what a no-show return leaves behind — the partner's paid share before this return,
    /// less what returns. Null when nothing is kept (a zero penalty), so the words stay the plain refund's.
    /// </summary>
    private async Task<int?> KeptOfNoShowAsync(ShareMove move, int returned, CancellationToken ct)
    {
        var seat = await _db.BookingParticipants.AsNoTracking().FirstOrDefaultAsync(p => p.Id == move.ParticipantId, ct);
        if (seat is null) return null;
        var kept = await PaidAsync(seat, ct) - returned;
        return kept > 0 ? kept : null;
    }

    /// <summary>
    /// R11 E11-1: the frame's <c>share_cause</c> — one of <see cref="WalletShareCauses"/>, decided from
    /// the same facts the receipts are worded from, so the toast and the inbox say the same thing.
    /// </summary>
    internal static string CauseOf(Booking booking, ShareMove move, ClubReceipt? club, bool attended, string? refund, SeatFacts? seat = null)
    {
        if (move.Delta > 0)
        {
            if (club?.Collected == true) return WalletShareCauses.ClubCollected;
            return attended ? WalletShareCauses.Attended : WalletShareCauses.SharePaid;
        }
        if (club is { Collected: false }) return WalletShareCauses.ClubRemoved;
        return refund switch
        {
            ShareRefundCauses.Outage => WalletShareCauses.OutageRefund,
            ShareRefundCauses.NoShow => WalletShareCauses.NoShow,
            ShareRefundCauses.Displaced => WalletShareCauses.Displaced,
            _ => booking.Status == BookingStatus.Cancelled ? WalletShareCauses.BookingCancelled : PlainReturnCause(seat),
        };
    }

    /// <summary>
    /// R14 X14-2: a plain return, by what became of the seat — and only by what the record says
    /// (review M1/L1): the partner withdrew; the organiser took them off (the removal's record); the
    /// club recorded the share paid outside the app; the organiser lowered it (the split's own record,
    /// newer than any share movement on the seat). Anything else — a desk adjustment to the booking,
    /// a removal from before the record existed — is <see cref="WalletShareCauses.ShareBack"/>.
    /// </summary>
    private static string PlainReturnCause(SeatFacts? seat)
    {
        if (seat is null) return WalletShareCauses.ShareBack;
        if (seat.Status == ParticipantStatus.Withdrawn) return WalletShareCauses.ShareReturned;
        if (seat.Status == ParticipantStatus.Removed) return seat.Removal is null ? WalletShareCauses.ShareBack : WalletShareCauses.OrganiserRemoved;
        if (seat.SettledOutside) return WalletShareCauses.ClubSettled;
        return seat.Split is null ? WalletShareCauses.ShareBack : WalletShareCauses.SplitChanged;
    }

    /// <param name="ownAction">
    /// The receipt's reader moved the money themselves — born read (review round 3, I-9). A move
    /// somebody else made on their money (the partner's payment to the organiser, the club's
    /// collect) is news and arrives unread.
    /// </param>
    private void Stage(SharePayload payload, Guid userId, string key, string headline, TenantSettingsView settings, bool ownAction)
    {
        MemberNotices.Stage(_db, _tenant.TenantId, new MemberNotice(
            userId, MemberEventCatalogue.ShareMoved, key, payload, headline, BookingPath(payload.BookingId, payload.OffGameSeatId), payload.BookingId)
        {
            BornRead = ownAction,
        }, settings);
    }

    /// <summary>
    /// Review round 10, E10-7: why the CLUB refunded a split session a share is going back on — an
    /// outage refund, a no-show settled by the sweep, a displacement — or null when it did not (an
    /// organiser's cancel or remove, a split change), which keeps the ordinary words.
    /// </summary>
    internal static string? ClubRefundOf(Booking booking)
    {
        if (booking.NoShowReversedAt is not null) return null;
        if (booking.OutageRefundedAt is not null) return ShareRefundCauses.Outage;
        if (booking.DisplacedByBookingId is not null) return ShareRefundCauses.Displaced;
        return booking.Status == BookingStatus.NoShow ? ShareRefundCauses.NoShow : null;
    }

    /// <summary>E10-7: a club refund's cause, only for a RETURN the club did not make by hand (a collect or removal has its own words).</summary>
    private static string? RefundCauseOf(Booking booking, ShareMove move, ClubReceipt? club) =>
        club is null && move.Delta < 0 ? ClubRefundOf(booking) : null;

    /// <summary>The receipt's headline: a club refund's words when there is one (E10-7), else <see cref="ShareHeadline"/>.</summary>
    private static string HeadlineFor(ShareDirection d, string other, int amount, HeadlineWhy why) =>
        NoShowHeadline(d, other, amount, why) ?? RefundHeadline(d, other, amount, why.Refund) ?? WithdrewHeadline(d, other, amount, why)
        ?? OrganiserActHeadline(d, other, amount, why) ?? ShareHeadline(d, other, amount, why);

    /// <summary>
    /// R14 X14-2 / J14-8: a return the organiser's act or a cancellation caused, said as that, with the
    /// court and the day: "16 minutes of your share came back — Olive took you off Court 1, Tue 08 Oct
    /// 18:00". On the partner's side <paramref name="other"/> is the organiser; on theirs, the partner.
    /// </summary>
    private static string? OrganiserActHeadline(ShareDirection d, string other, int amount, HeadlineWhy why)
    {
        if (why.Game is not { } game || d is not (ShareDirection.Refunded or ShareDirection.Returned)) return null;
        var mine = d == ShareDirection.Refunded;
        if (ActClause(why, mine, other, $"{game.CourtName}, {game.StartsLocal}") is not { } clause) return null;
        var minutes = MoneyFormat.Minutes(amount);
        return mine ? $"{minutes} of your share came back — {clause}" : $"{minutes} went back to {other} — {clause}";
    }

    /// <summary>The clause after the dash in <see cref="OrganiserActHeadline"/>, or null for any other cause.</summary>
    private static string? ActClause(HeadlineWhy why, bool mine, string other, string where)
    {
        return why.Cause switch
        {
            WalletShareCauses.OrganiserRemoved => mine ? $"{other} took you off {where}" : $"you took them off {where}",
            WalletShareCauses.SplitChanged => mine ? $"{other} lowered your share of {where}" : $"you lowered their share of {where}",
            WalletShareCauses.ClubSettled => mine
                ? $"the club recorded your share of {where} as paid outside the app"
                : $"the club recorded their share of {where} as paid outside the app",
            WalletShareCauses.BookingCancelled => CancelClause(why.CancelledByClub, mine, other, where),
            _ => null,
        };
    }

    /// <summary>R14 J14-8: who cancelled, as the receipt says it.</summary>
    private static string CancelClause(bool? byClub, bool mine, string other, string where)
    {
        if (byClub is null) return $"the booking on {where} was cancelled";
        if (byClub.Value) return $"the club cancelled {where}";
        return mine ? $"{other} cancelled {where}" : $"you cancelled {where}";
    }

    /// <summary>R13 E13-4: "7 minutes went back to Paula — they withdrew from the game", or the partner's own.</summary>
    private static string? WithdrewHeadline(ShareDirection d, string other, int amount, HeadlineWhy why)
    {
        if (!why.Withdrew) return null;
        var minutes = MoneyFormat.Minutes(amount);
        return d == ShareDirection.Refunded
            ? $"{minutes} of your share came back — you withdrew from the game"
            : $"{minutes} went back to {other} — they withdrew from the game";
    }

    /// <summary>The facts a receipt's headline is worded from.</summary>
    private sealed record HeadlineWhy(bool ByClub, bool Attended, string? Refund, int? Kept)
    {
        /// <summary>R13 E13-4: the partner withdrew, so their share went back.</summary>
        public bool Withdrew { get; init; }

        /// <summary>R14: the frame's cause (<see cref="WalletShareCauses"/>).</summary>
        public string? Cause { get; init; }

        /// <summary>R14: the game's court and start, which the organiser-act headlines name.</summary>
        public GameText? Game { get; init; }

        /// <summary>R14 J14-8: on a cancellation's return, whether the club cancelled; null when the record does not say.</summary>
        public bool? CancelledByClub { get; init; }

        /// <summary>R15 J15-5: whose late check-in made it attended, as this reader is told it.</summary>
        public ScanWords? Scan { get; init; }
    }

    /// <summary>
    /// R11 E11-2: a no-show return names the penalty and the partner's part of it. "The club refunded
    /// the session" alone left a partner who paid 15 and got 11 back with 4 minutes unexplained.
    /// </summary>
    private static string? NoShowHeadline(ShareDirection d, string other, int amount, HeadlineWhy why)
    {
        if (why.Refund != ShareRefundCauses.NoShow || why.Kept is not { } kept) return null;
        var minutes = MoneyFormat.Minutes(amount);
        var part = $"{MoneyFormat.Minutes(kept)} {(kept == 1 ? "is" : "are")}";
        return d == ShareDirection.Refunded
            ? $"{minutes} of your share came back — nobody checked in, and {part} your part of the no-show penalty"
            : $"{minutes} went back to {other} — nobody checked in, and {part} {other}'s part of the no-show penalty";
    }

    /// <summary>E10-7: the headline for a share the club's refund sent back, or null to use <see cref="ShareHeadline"/>.</summary>
    private static string? RefundHeadline(ShareDirection d, string other, int amount, string? cause)
    {
        if (ShareRefundCauses.Because(cause) is not { } because) return null;
        var minutes = MoneyFormat.Minutes(amount);
        return d == ShareDirection.Refunded
            ? $"{minutes} of your share came back — the club refunded the session: {because}"
            : $"{minutes} went back to {other} — the club refunded the session: {because}";
    }

    /// <summary>
    /// The plain receipt line — R15 J15-5: every one names the court and the day ("You paid Owen 7
    /// minutes" said neither), and a share taken again names whose check-in it was.
    /// </summary>
    private static string ShareHeadline(ShareDirection d, string other, int amount, HeadlineWhy why)
    {
        var minutes = MoneyFormat.Minutes(amount);
        var where = why.Game is { } game ? $"{game.CourtName}, {game.StartsLocal}" : "the game";
        if (why.Attended) return AttendedHeadline(d, other, minutes, where, why.Scan?.Clause());
        if (why.ByClub && d == ShareDirection.Paid) return $"The club collected {minutes} for your share of {where}";
        if (why.ByClub && d == ShareDirection.Received) return $"The club collected {other}'s share of {where}: {minutes}";
        switch (d)
        {
            case ShareDirection.Paid: return $"You paid {other} {minutes} for {where}";
            case ShareDirection.Received: return $"{other} paid you {minutes} for {where}";
            case ShareDirection.Refunded: return $"{minutes} of your share of {where} came back";
            default: return $"{minutes} went back to {other} for {where}";
        }
    }

    /// <summary>R9 E9-2 / R15 J15-5: a share taken again because a late check-in showed the session was attended.</summary>
    private static string AttendedHeadline(ShareDirection d, string other, string minutes, string where, string? scanned)
    {
        var why = scanned is null ? "the session was attended" : $"{scanned}, so the session was attended";
        return d == ShareDirection.Paid
            ? $"{minutes} taken again for your share of {where} — {why}"
            : $"{other}'s share of {minutes} came back to you for {where} — {why}";
    }

    private static bool IsUniqueViolation(DbUpdateException ex)
    {
        return ex.InnerException is Npgsql.PostgresException { SqlState: "23505" };
    }
}

/// <summary>A game's court and start, in the club's words — the two facts every players message leads with.</summary>
public sealed record GameText(string CourtName, string StartsLocal)
{
    public static async Task<GameText> ForAsync(MainframeDbContext db, Booking booking, TenantSettingsView settings, CancellationToken ct)
    {
        var court = await db.Courts.AsNoTracking().Where(c => c.Id == booking.CourtId).Select(c => c.Name).FirstOrDefaultAsync(ct);
        return new GameText(court ?? "Court", Local(booking.StartsAt, settings));
    }

    public static string Local(DateTimeOffset at, TenantSettingsView settings) =>
        TimeZoneInfo.ConvertTime(at, ClubClock.ZoneOf(settings))
            .ToString(ClubDate.Format, System.Globalization.CultureInfo.InvariantCulture);
}
