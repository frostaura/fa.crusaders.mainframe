using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services.Realtime;
using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Everything that happens to a split booking because TIME passed or because the settlement code
/// moved the organiser's money (D11): shares reconciled, players told the game is off, invites
/// lapsed at the deadline, reminders sent on the club's cadence. One club per call; the tenant is
/// the caller's.
///
/// <para>
/// <b>Every step is idempotent</b> — the reconcile by construction, the notices by their dedupe
/// keys, the lapse by the status it moves out of — so the post-settlement hook and the worker can
/// both run it over the same booking without either knowing the other did.
/// </para>
/// </summary>
public sealed class ShareSweep
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly ShareLedger _shares;
    private readonly TenantSettingsAccessor _settings;
    private readonly IRealtimeBus _bus;
    private readonly ILogger<ShareSweep> _logger;

    public ShareSweep(
        MainframeDbContext db, ITenantContext tenant, ShareLedger shares, TenantSettingsAccessor settings, IRealtimeBus bus,
        ILogger<ShareSweep> logger)
    {
        _db = db; _tenant = tenant; _shares = shares; _settings = settings; _bus = bus; _logger = logger;
    }

    /// <summary>
    /// Records a failed reconcile of a booking's shares: marks it "reconcile due"
    /// (<see cref="Booking.ShareReconcileDueAt"/>, keeping the first time) for the minute sweep,
    /// whatever its age, and counts the attempt for the backoff (review round 6).
    /// </summary>
    public static Task<int> MarkReconcileDueAsync(MainframeDbContext db, Guid bookingId, CancellationToken ct)
    {
        var at = DateTimeOffset.UtcNow.Storable();
        return db.Bookings.Where(b => b.Id == bookingId)
            .ExecuteUpdateAsync(u => u
                .SetProperty(b => b.ShareReconcileDueAt, b => b.ShareReconcileDueAt ?? at)
                .SetProperty(b => b.ShareReconcileAttempts, b => b.ShareReconcileAttempts + 1)
                .SetProperty(b => b.ShareReconcileLastAttemptAt, at), ct);
    }

    /// <summary>
    /// Reconciled: a "reconcile due" marker a failure left has been made good — but only one
    /// recorded BEFORE this reconcile started. A failure recorded while it ran (a concurrent hook)
    /// is newer than this answer and stays for the next sweep (review round 6).
    /// </summary>
    private Task<int> ClearMarkerAsync(Guid bookingId, DateTimeOffset started, CancellationToken ct) =>
        _db.Bookings
            .Where(b => b.Id == bookingId && b.ShareReconcileDueAt != null
                        && (b.ShareReconcileLastAttemptAt == null || b.ShareReconcileLastAttemptAt <= started))
            .ExecuteUpdateAsync(u => u
                .SetProperty(b => b.ShareReconcileDueAt, (DateTimeOffset?)null)
                .SetProperty(b => b.ShareReconcileAttempts, 0)
                .SetProperty(b => b.ShareReconcileLastAttemptAt, (DateTimeOffset?)null), ct);

    /// <summary>The longest a failing booking waits between retries.</summary>
    public static readonly TimeSpan MaxReconcileBackoff = TimeSpan.FromHours(1);

    /// <summary>
    /// How long after its latest failure a marked booking waits before the sweep tries it again:
    /// a minute, doubling with each failed attempt, capped at <see cref="MaxReconcileBackoff"/> —
    /// so a booking that fails for good costs a retry an hour, not one a minute (review round 6).
    /// </summary>
    public static TimeSpan ReconcileBackoff(int attempts) =>
        attempts <= 1 ? TimeSpan.FromMinutes(1)
        : TimeSpan.FromMinutes(Math.Min(MaxReconcileBackoff.TotalMinutes, Math.Pow(2, Math.Min(attempts - 1, 10))));

    /// <summary>What became of one booking's reconcile: made, or failed and marked due, or failed unmarked.</summary>
    private enum Settled { Done, FailedMarked, FailedUnmarked }

    /// <summary>
    /// Reconciles one booking and never throws: a failure is logged — once per backoff step, as a
    /// retry happens only once per step — the booking is marked due with the attempt counted, and
    /// the caller goes on with the rest (review rounds 5 and 6).
    /// </summary>
    private async Task<Settled> TrySettleAsync(Guid bookingId, CancellationToken ct)
    {
        try
        {
            await SettleBookingAsync(bookingId, ct);
            return Settled.Done;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _db.ChangeTracker.Clear();
            _logger.LogError(ex, "Share reconcile of booking {Booking} failed; marked for the sweep with backoff", bookingId);
            try
            {
                await MarkReconcileDueAsync(_db, bookingId, ct);
                return Settled.FailedMarked;
            }
            catch (Exception mark) when (mark is not OperationCanceledException)
            {
                _logger.LogError(mark, "Could not mark booking {Booking} for the sweep", bookingId);
                return Settled.FailedUnmarked;
            }
        }
    }

    /// <summary>
    /// After a settlement path committed: move the shares, and tell every player once when the
    /// game has been cancelled. A booking with no seats costs one indexed read.
    /// </summary>
    /// <param name="ownActionBy">Whose own request settled it; their receipts are born read (I4-5).</param>
    public async Task SettleBookingAsync(Guid bookingId, CancellationToken ct, Guid? ownActionBy = null)
    {
        var started = DateTimeOffset.UtcNow.Storable();
        var seats = await _db.BookingParticipants.AsNoTracking().Where(p => p.BookingId == bookingId).ToListAsync(ct);
        if (!seats.Any(p => p.Seat > 1))
        {
            // Nothing to reconcile — but a marker a failure left here is made good all the same,
            // or no sweep would ever clear it (review round 7).
            await ClearMarkerAsync(bookingId, started, ct);
            return;
        }

        var moves = await _shares.ReconcileAsync(
            bookingId, ct, ownActionBy is null ? null : new ReconcileOptions(Guid.Empty) { OwnActionBy = ownActionBy });
        var told = await TellCancelledAsync(bookingId, seats, ct);

        await ClearMarkerAsync(bookingId, started, ct);

        var touched = moves.SelectMany(m => new[] { m.PartnerUserId, m.OrganiserUserId }).Concat(told);
        await MemberNotices.PublishUnreadAsync(_db, _bus, _tenant.TenantId, touched, ct);
    }

    /// <summary>
    /// "The game is off" to every player still in it but the organiser, once per booking and
    /// player. The organiser is told by the cancellation itself.
    ///
    /// <para>
    /// <b>An unanswered invitee gets the inbox line, not the mail</b> (review round 4, M4-5). They
    /// never said yes, paid nothing and lose nothing, and the kind is urgent (sent at once, quiet
    /// hours or not): an invite held overnight was dropped at release while this reached them at
    /// 23:00 for a game they had never heard of. Their invite now reads as a game that is off.
    /// </para>
    /// </summary>
    private async Task<IReadOnlyList<Guid>> TellCancelledAsync(Guid bookingId, List<BookingParticipant> seats, CancellationToken ct)
    {
        var booking = await _db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        if (booking is null || booking.Status != BookingStatus.Cancelled) return [];

        var settings = await _settings.GetAsync(ct);
        var game = await GameText.ForAsync(_db, booking, settings, ct);
        var organiser = PersonNames.Of(booking.UserId, await PersonNames.ForAsync(_db, [booking.UserId], ct)) ?? "The organiser";
        // R13 E13-6: who cancelled it, and why — the partner was never told the club had.
        var by = await BookingCancellation.ForAsync(_db, booking, ct);
        var told = new List<Guid>();
        foreach (var seat in seats.Where(p => p.Seat > 1 && p.UserId is not null && p.IsLive))
        {
            var notice = new MemberNotice(
                seat.UserId!.Value, MemberEventCatalogue.GameCancelled, $"game-cancelled:{bookingId:N}:{seat.UserId:N}",
                new GameCancelledPayload(bookingId, organiser, game.CourtName, game.StartsLocal, by?.ByClub, by?.Reason, CauseOf(by)),
                CancelledHeadline(by, organiser, game), $"/bookings/{bookingId}", bookingId)
            {
                Email = seat.Status == ParticipantStatus.Accepted,
            };
            if (await MemberNotices.RaiseAsync(_db, _tenant.TenantId, notice, settings, ct)) told.Add(seat.UserId.Value);
        }
        return told;
    }

    /// <summary>R13 E13-6: the inbox line says who cancelled — the club, or the organiser — when it is on the record.</summary>
    private static string CancelledHeadline(BookingCancellation? by, string organiser, GameText game)
    {
        if (by is null) return $"Cancelled — {game.CourtName}, {game.StartsLocal}";
        return by.ByClub
            ? $"The club cancelled {game.CourtName}, {game.StartsLocal}"
            : $"{organiser} cancelled {game.CourtName}, {game.StartsLocal}";
    }

    /// <summary>The system's cause in the mail's vocabulary (<see cref="Email.ShareRefundCauses"/>), or null.</summary>
    private static string? CauseOf(BookingCancellation? by) =>
        by?.Cause == BookingCancellation.Displaced ? Email.ShareRefundCauses.Displaced : null;

    /// <summary>
    /// Once per club, when the worker starts (review round 3): every booking on which a return
    /// has fallen due while nothing was running and not been made, reconciled whatever its age, so
    /// it is found and, if uncovered, stamped and waiting like any other — the minute sweep's week
    /// would never reach it. Answers the bookings it reconciled. Idempotent.
    /// </summary>
    public async Task<IReadOnlyList<Guid>> CatchUpAsync(CancellationToken ct)
    {
        // Selected in SQL, and only where a return is due and not yet made or stamped (review
        // round 4): a seat whose target is certainly NOTHING — the partner is off the game,
        // settled by hand, or the game was cancelled before anybody checked in — and whose member
        // has still paid something net on it. A no-show or a game cancelled after check-in owes
        // its partners a SHARE, not nothing; their returns follow the organiser's Owed through the
        // settlement hook, and every settled one of them in history would otherwise be
        // reconciled on every start. Normally the answer is empty.
        var due = await _db.BookingParticipants.AsNoTracking()
            .Where(p => p.Seat > 1 && p.UserId != null && p.ReturnPendingSince == null)
            .Join(_db.Bookings.AsNoTracking(), p => p.BookingId, b => b.Id, (p, b) => new { Seat = p, Booking = b })
            .Where(x => x.Seat.Status != ParticipantStatus.Accepted || x.Seat.SettledOutsideAt != null
                        || (x.Booking.Status == BookingStatus.Cancelled && x.Booking.CheckedInAt == null))
            .Where(x => _db.LedgerEntries.Where(l => l.RelatedBookingId == x.Booking.Id && l.UserId == x.Seat.UserId
                                                     && l.Type == LedgerEntryType.ShareTransfer)
                            .Sum(l => l.AmountMinutes) < 0)
            .Select(x => x.Booking.Id)
            .Distinct()
            .ToListAsync(ct);
        // Every due booking is tried. One that fails is marked due — and the marker is what makes it
        // good from then on, through the minute sweep with backoff — so the club IS caught up
        // (review round 6); only a failure that could not even be marked is reported, and the
        // catch-up is then retried on the next pass.
        var unmarked = new List<Guid>();
        foreach (var id in due)
        {
            if (await TrySettleAsync(id, ct) == Settled.FailedUnmarked) unmarked.Add(id);
        }
        if (unmarked.Count > 0) throw new InvalidOperationException($"share catch-up could not mark {unmarked.Count} booking(s): {string.Join(",", unmarked)}");
        return due;
    }

    /// <summary>
    /// The worker's pass over one club at <paramref name="now"/>: lapse what is past its deadline,
    /// remind what is due a reminder, reconcile every recent split booking, prune read inbox lines.
    /// </summary>
    public async Task SweepAsync(DateTimeOffset now, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        // A week past each booking's own deadline: the stamp where it has one (review H2), else the
        // club's current lapse hours past the end.
        var horizon = now.AddHours(-(PlayerSettings.ShareLapseHours(settings) + (7 * 24)));
        var stampedHorizon = now.AddDays(-7);

        // Every booking with a return WAITING, however old (review round 2), selected on the seat's
        // own indexed stamp and taken FIRST, oldest stamp first (then participant id): first come,
        // first served (round 5). Then every booking a failed reconcile marked due, however old
        // (round 5), and the window's, in a stable order.
        var waiting = await _db.BookingParticipants.AsNoTracking()
            .Where(p => p.Seat > 1 && p.ReturnPendingSince != null)
            .OrderBy(p => p.ReturnPendingSince).ThenBy(p => p.Id)
            .Select(p => p.BookingId)
            .ToListAsync(ct);
        var window = await _db.BookingParticipants.AsNoTracking()
            .Where(p => p.Seat > 1 && _db.Bookings.Any(b => b.Id == p.BookingId
                && (b.ShareDeadlineAt >= stampedHorizon || (b.ShareDeadlineAt == null && b.EndsAt >= horizon))))
            .Select(p => p.BookingId)
            .Distinct()
            .OrderBy(id => id)
            .ToListAsync(ct);
        // Marked bookings straight off the booking's own index — with or without partner seats
        // (review round 7): a marker on a booking whose players all came off must still be cleared.
        var marked = await _db.Bookings.AsNoTracking()
            .Where(b => b.ShareReconcileDueAt != null)
            .OrderBy(b => b.Id)
            .Select(b => b.Id)
            .ToListAsync(ct);

        // One booking's failure is logged and marked, and the rest of the club's sweep goes on; a
        // marked booking still inside its backoff is left alone this pass (review round 6).
        var resting = await BackingOffAsync(now, ct);
        foreach (var id in waiting.Concat(marked).Concat(window).Distinct().Where(id => !resting.Contains(id))) await TrySettleAsync(id, ct);

        await LapseAsync(now, settings, ct);
        await RemindAsync(now, settings, ct);
        await PruneAsync(now, settings, ct);
    }

    /// <summary>A partner seat that can still be asked or lapse: a member's, live, not lapsed, not settled by hand.</summary>
    private static readonly Expression<Func<BookingParticipant, bool>> OpenPartnerSeat =
        p => p.Seat > 1 && p.UserId != null && p.LapsedAt == null && p.SettledOutsideAt == null
             && (p.Status == ParticipantStatus.Invited || p.Status == ParticipantStatus.Accepted);

    /// <summary>
    /// A booking whose deadline passed within the last week — stamped (indexed), or unstamped and
    /// started since <paramref name="unstampedFrom"/>. A fully paid seat never lapses, so reading
    /// every one in the club's history every minute grew without bound (review round 2).
    /// </summary>
    private static Expression<Func<Booking, bool>> DeadlinePassedLastWeek(DateTimeOffset now, DateTimeOffset unstampedFrom)
    {
        var recent = now.AddDays(-7);
        return b => (b.ShareDeadlineAt <= now && b.ShareDeadlineAt > recent)
                    || (b.ShareDeadlineAt == null && b.StartsAt < now && b.StartsAt >= unstampedFrom);
    }

    /// <summary>The marked bookings whose backoff has not run out at <paramref name="now"/> — a handful, on the marker's index.</summary>
    private async Task<HashSet<Guid>> BackingOffAsync(DateTimeOffset now, CancellationToken ct)
    {
        var marked = await _db.Bookings.AsNoTracking()
            // A marker a settlement staged (round 8) counts no failure: due at the next sweep.
            .Where(b => b.ShareReconcileDueAt != null && b.ShareReconcileLastAttemptAt != null && b.ShareReconcileAttempts > 0)
            .Select(b => new { b.Id, b.ShareReconcileAttempts, b.ShareReconcileLastAttemptAt })
            .ToListAsync(ct);
        return marked.Where(b => now < b.ShareReconcileLastAttemptAt!.Value + ReconcileBackoff(b.ShareReconcileAttempts))
            .Select(b => b.Id).ToHashSet();
    }

    /// <summary>
    /// Past the deadline: an unanswered invite lapses, and an accepted seat still short of its
    /// target is marked lapsed — its consent frozen, the organiser's cover standing. Both told once
    /// — but only about a game that was on (booked, played or a no-show). An invite to a game that
    /// was cancelled or displaced lapses without a word: its players were already told it was off,
    /// and "your invite closed" about a game that never happened is noise, not news.
    /// </summary>
    private async Task LapseAsync(DateTimeOffset now, TenantSettingsView settings, CancellationToken ct)
    {
        var recent = await _db.BookingParticipants
            .Where(OpenPartnerSeat)
            .Join(_db.Bookings.Where(DeadlinePassedLastWeek(now, ShareHolds.UnstampedFrom(now, settings).AddDays(-7))),
                p => p.BookingId, b => b.Id, (p, b) => new { Seat = p, Booking = b })
            .ToListAsync(ct);
        // ...and every still-INVITED seat whose game has started, however long ago (review round
        // 3): a worker down for more than the week must not leave an invite open for ever. Cheap —
        // the partial index on open invites holds only unanswered seats.
        var overdueInvites = await _db.BookingParticipants
            .Where(p => p.Status == ParticipantStatus.Invited && p.LapsedAt == null && p.Seat > 1 && p.UserId != null)
            .Join(_db.Bookings.Where(b => b.StartsAt < now), p => p.BookingId, b => b.Id, (p, b) => new { Seat = p, Booking = b })
            .ToListAsync(ct);
        var candidates = recent.Concat(overdueInvites).DistinctBy(x => x.Seat.Id);

        foreach (var x in candidates.Where(x => PlayerSettings.ShareDeadline(x.Booking, settings) <= now))
        {
            var unpaid = await _shares.UnpaidAsync(x.Booking, x.Seat, ct, evenIfClosed: true);
            if (x.Seat.Status == ParticipantStatus.Accepted && unpaid <= 0) continue;

            var shareForNotice = x.Seat.Status == ParticipantStatus.Invited ? x.Seat.ShareMinutes : unpaid;
            if (x.Seat.Status == ParticipantStatus.Invited) x.Seat.Status = ParticipantStatus.Lapsed;
            x.Seat.LapsedAt = now.Storable();
            x.Seat.UpdatedAt = now.Storable();
            if (x.Booking.Status is BookingStatus.Booked or BookingStatus.Completed or BookingStatus.NoShow)
            {
                await StageLapseNoticesAsync(x.Booking, x.Seat, shareForNotice, settings, ct);
            }
            try
            {
                await _db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException)
            {
                // Somebody accepted or paid in the same instant; their answer stands, and the next
                // pass decides again from what is true then.
                _db.ChangeTracker.Clear();
            }
        }
    }

    private async Task StageLapseNoticesAsync(
        Booking booking, BookingParticipant seat, int unpaid, TenantSettingsView settings, CancellationToken ct)
    {
        var game = await GameText.ForAsync(_db, booking, settings, ct);
        var names = await PersonNames.ForAsync(_db, [booking.UserId, seat.UserId], ct);
        var organiser = PersonNames.Of(booking.UserId, names) ?? "The organiser";
        var partner = PersonNames.Of(seat.UserId, names) ?? "Your partner";
        var link = $"/bookings/{booking.Id}";

        MemberNotices.Stage(_db, _tenant.TenantId, new MemberNotice(
            seat.UserId!.Value, MemberEventCatalogue.Lapsed, $"lapsed:{seat.Id:N}:partner",
            new LapsedPayload(booking.Id, organiser, game.CourtName, game.StartsLocal, unpaid, ToOrganiser: false, seat.Id),
            $"Your invite closed — {game.CourtName}, {game.StartsLocal}", link, booking.Id), settings);
        if (booking.UserId is { } organiserId)
        {
            MemberNotices.Stage(_db, _tenant.TenantId, new MemberNotice(
                organiserId, MemberEventCatalogue.Lapsed, $"lapsed:{seat.Id:N}:organiser",
                new LapsedPayload(booking.Id, partner, game.CourtName, game.StartsLocal, unpaid, ToOrganiser: true, seat.Id),
                $"{partner}'s share closed — {game.CourtName}", link, booking.Id), settings);
        }
    }

    /// <summary>
    /// A reminder to each partner whose seat is still open or short, at most
    /// <c>share_reminder_max</c> times and no more often than every <c>share_reminder_hours</c>,
    /// and never before the first cadence has passed since they were invited.
    /// </summary>
    private async Task RemindAsync(DateTimeOffset now, TenantSettingsView settings, CancellationToken ct)
    {
        var max = PlayerSettings.ShareReminderMax(settings);
        if (max == 0) return;
        var since = now.AddHours(-PlayerSettings.ShareReminderHours(settings));
        // Only games whose deadline is still ahead (stamped, indexed; unstamped by start) — not
        // every accepted seat in history under the reminder cap (review round 2).
        var due = await _db.BookingParticipants
            .Where(OpenPartnerSeat)
            .Where(p => p.ReminderCount < max && p.InvitedAt <= since && (p.LastReminderAt == null || p.LastReminderAt <= since))
            .Join(_db.Bookings.Where(b => b.Status == BookingStatus.Booked || b.Status == BookingStatus.Completed)
                    .Where(ShareHolds.DeadlineAhead(now, ShareHolds.UnstampedFrom(now, settings))),
                p => p.BookingId, b => b.Id, (p, b) => new { Seat = p, Booking = b })
            .ToListAsync(ct);

        foreach (var x in due.Where(x => PlayerSettings.ShareDeadline(x.Booking, settings) > now))
        {
            var unpaid = await _shares.UnpaidAsync(x.Booking, x.Seat, ct);
            if (x.Seat.Status == ParticipantStatus.Accepted && unpaid <= 0) continue;

            x.Seat.ReminderCount++;
            x.Seat.LastReminderAt = now.Storable();
            MemberNotices.Stage(_db, _tenant.TenantId,
                await PlayerNotices.ReminderAsync(_db, x.Booking, x.Seat, settings, new ReminderKey(false, $"reminder:{x.Seat.Id:N}:{x.Seat.ReminderCount}"), ct),
                settings);
            try
            {
                await _db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException)
            {
                _db.ChangeTracker.Clear();
            }
        }
    }

    /// <summary>Read inbox lines past the club's retention. Unread ones are never pruned by age.</summary>
    private async Task PruneAsync(DateTimeOffset now, TenantSettingsView settings, CancellationToken ct)
    {
        var cutoff = now.AddDays(-PlayerSettings.NotificationRetentionDays(settings));
        await _db.MemberNotifications.Where(n => n.ReadAt != null && n.ReadAt < cutoff).ExecuteDeleteAsync(ct);
    }
}
