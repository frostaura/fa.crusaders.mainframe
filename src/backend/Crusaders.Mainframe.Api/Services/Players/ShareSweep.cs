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

    public ShareSweep(
        MainframeDbContext db, ITenantContext tenant, ShareLedger shares, TenantSettingsAccessor settings, IRealtimeBus bus)
    {
        _db = db; _tenant = tenant; _shares = shares; _settings = settings; _bus = bus;
    }

    /// <summary>
    /// After a settlement path committed: move the shares, and tell every player once when the
    /// game has been cancelled. A booking with no seats costs one indexed read.
    /// </summary>
    public async Task SettleBookingAsync(Guid bookingId, CancellationToken ct)
    {
        var seats = await _db.BookingParticipants.AsNoTracking().Where(p => p.BookingId == bookingId).ToListAsync(ct);
        if (!seats.Any(p => p.Seat > 1)) return;

        var moves = await _shares.ReconcileAsync(bookingId, ct);
        var told = await TellCancelledAsync(bookingId, seats, ct);

        var touched = moves.SelectMany(m => new[] { m.PartnerUserId, m.OrganiserUserId }).Concat(told);
        await MemberNotices.PublishUnreadAsync(_db, _bus, _tenant.TenantId, touched, ct);
    }

    /// <summary>
    /// "The game is off" to every player still in it but the organiser, once per booking and
    /// player. The organiser is told by the cancellation itself.
    /// </summary>
    private async Task<IReadOnlyList<Guid>> TellCancelledAsync(Guid bookingId, List<BookingParticipant> seats, CancellationToken ct)
    {
        var booking = await _db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        if (booking is null || booking.Status != BookingStatus.Cancelled) return [];

        var settings = await _settings.GetAsync(ct);
        var game = await GameText.ForAsync(_db, booking, settings, ct);
        var organiser = PersonNames.Of(booking.UserId, await PersonNames.ForAsync(_db, [booking.UserId], ct)) ?? "The organiser";
        var told = new List<Guid>();
        foreach (var seat in seats.Where(p => p.Seat > 1 && p.UserId is not null && p.IsLive))
        {
            var notice = new MemberNotice(
                seat.UserId!.Value, MemberEventCatalogue.GameCancelled, $"game-cancelled:{bookingId:N}:{seat.UserId:N}",
                new GameCancelledPayload(bookingId, organiser, game.CourtName, game.StartsLocal),
                $"Cancelled — {game.CourtName}, {game.StartsLocal}", $"/bookings/{bookingId}", bookingId);
            if (await MemberNotices.RaiseAsync(_db, _tenant.TenantId, notice, settings, ct)) told.Add(seat.UserId.Value);
        }
        return told;
    }

    /// <summary>
    /// The worker's pass over one club at <paramref name="now"/>: lapse what is past its deadline,
    /// remind what is due a reminder, reconcile every recent split booking, prune read inbox lines.
    /// </summary>
    /// <summary>
    /// Once, when the worker starts (review round 3): every booking on which a return may have
    /// fallen due while nothing was running — a partner who paid and is off the game, settled by
    /// hand, or on a game cancelled or a no-show — reconciled whatever its age, so a return due
    /// during an outage is found and, if uncovered, stamped and waiting like any other. The
    /// minute sweep's week would never reach it. Idempotent: a reconcile with nothing due posts
    /// nothing.
    /// </summary>
    public async Task CatchUpAsync(CancellationToken ct)
    {
        var seats = await _db.BookingParticipants.AsNoTracking()
            .Where(p => p.Seat > 1 && p.UserId != null && p.ReturnPendingSince == null)
            .Where(p => p.Status != ParticipantStatus.Accepted || p.SettledOutsideAt != null
                        || _db.Bookings.Any(b => b.Id == p.BookingId && (b.Status == BookingStatus.Cancelled || b.Status == BookingStatus.NoShow)))
            .Select(p => new { p.BookingId, UserId = p.UserId!.Value })
            .ToListAsync(ct);
        var ids = seats.Select(s => s.BookingId).Distinct().ToList();
        var paid = await _db.LedgerEntries.AsNoTracking()
            .Where(l => l.Type == LedgerEntryType.ShareTransfer && l.RelatedBookingId != null && ids.Contains(l.RelatedBookingId.Value))
            .GroupBy(l => new { Booking = l.RelatedBookingId!.Value, l.UserId })
            .Where(g => g.Sum(l => l.AmountCredits) < 0m)
            .Select(g => new { g.Key.Booking, g.Key.UserId })
            .ToListAsync(ct);
        var due = seats.Where(s => paid.Any(p => p.Booking == s.BookingId && p.UserId == s.UserId)).Select(s => s.BookingId).Distinct();
        foreach (var id in due) await SettleBookingAsync(id, ct);
    }

    public async Task SweepAsync(DateTimeOffset now, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        // A week past each booking's own deadline: the stamp where it has one (review H2), else the
        // club's current lapse hours past the end.
        var horizon = now.AddHours(-(PlayerSettings.ShareLapseHours(settings) + (7 * 24)));
        var stampedHorizon = now.AddDays(-7);

        // ...and every booking with a seat whose return is WAITING, however old (review round 2):
        // selected on the seat's own indexed stamp, so a return is never stranded by the window.
        var bookingIds = await _db.BookingParticipants.AsNoTracking()
            .Where(p => p.Seat > 1 && (p.ReturnPendingSince != null || _db.Bookings.Any(b => b.Id == p.BookingId
                && (b.ShareDeadlineAt >= stampedHorizon || (b.ShareDeadlineAt == null && b.EndsAt >= horizon)))))
            .Select(p => p.BookingId)
            .Distinct()
            .ToListAsync(ct);

        foreach (var id in bookingIds) await SettleBookingAsync(id, ct);

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
            if (x.Seat.Status == ParticipantStatus.Accepted && unpaid <= 0m) continue;

            var shareForNotice = x.Seat.Status == ParticipantStatus.Invited ? x.Seat.ShareCredits : unpaid;
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
        Booking booking, BookingParticipant seat, decimal unpaid, TenantSettingsView settings, CancellationToken ct)
    {
        var game = await GameText.ForAsync(_db, booking, settings, ct);
        var names = await PersonNames.ForAsync(_db, [booking.UserId, seat.UserId], ct);
        var organiser = PersonNames.Of(booking.UserId, names) ?? "The organiser";
        var partner = PersonNames.Of(seat.UserId, names) ?? "Your partner";
        var link = $"/bookings/{booking.Id}";

        MemberNotices.Stage(_db, _tenant.TenantId, new MemberNotice(
            seat.UserId!.Value, MemberEventCatalogue.Lapsed, $"lapsed:{seat.Id:N}:partner",
            new LapsedPayload(booking.Id, organiser, game.CourtName, game.StartsLocal, unpaid, ToOrganiser: false),
            $"Your invite closed — {game.CourtName}, {game.StartsLocal}", link, booking.Id), settings);
        if (booking.UserId is { } organiserId)
        {
            MemberNotices.Stage(_db, _tenant.TenantId, new MemberNotice(
                organiserId, MemberEventCatalogue.Lapsed, $"lapsed:{seat.Id:N}:organiser",
                new LapsedPayload(booking.Id, partner, game.CourtName, game.StartsLocal, unpaid, ToOrganiser: true),
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
            if (x.Seat.Status == ParticipantStatus.Accepted && unpaid <= 0m) continue;

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
