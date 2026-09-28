using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services.Realtime;
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
    public async Task SweepAsync(DateTimeOffset now, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        var horizon = now.AddHours(-(PlayerSettings.ShareLapseHours(settings) + (7 * 24)));

        var bookingIds = await _db.BookingParticipants.AsNoTracking()
            .Where(p => p.Seat > 1 && _db.Bookings.Any(b => b.Id == p.BookingId && b.EndsAt >= horizon))
            .Select(p => p.BookingId)
            .Distinct()
            .ToListAsync(ct);

        foreach (var id in bookingIds) await SettleBookingAsync(id, ct);

        await LapseAsync(now, settings, ct);
        await RemindAsync(now, settings, ct);
        await PruneAsync(now, settings, ct);
    }

    /// <summary>
    /// Past the deadline: an unanswered invite lapses, and an accepted seat still short of its
    /// target is marked lapsed — its consent frozen, the organiser's cover standing. Both told once.
    /// </summary>
    private async Task LapseAsync(DateTimeOffset now, TenantSettingsView settings, CancellationToken ct)
    {
        var candidates = await _db.BookingParticipants
            .Where(p => p.Seat > 1 && p.UserId != null && p.LapsedAt == null && p.SettledOutsideAt == null
                        && (p.Status == ParticipantStatus.Invited || p.Status == ParticipantStatus.Accepted))
            .Join(_db.Bookings, p => p.BookingId, b => b.Id, (p, b) => new { Seat = p, Booking = b })
            .Where(x => x.Booking.StartsAt < now)
            .ToListAsync(ct);

        foreach (var x in candidates.Where(x => PlayerSettings.ShareDeadline(x.Booking, settings) <= now))
        {
            var unpaid = await _shares.UnpaidAsync(x.Booking, x.Seat, ct);
            if (x.Seat.Status == ParticipantStatus.Accepted && unpaid <= 0m) continue;

            var shareForNotice = x.Seat.Status == ParticipantStatus.Invited ? x.Seat.ShareCredits : unpaid;
            if (x.Seat.Status == ParticipantStatus.Invited) x.Seat.Status = ParticipantStatus.Lapsed;
            x.Seat.LapsedAt = now.Storable();
            x.Seat.UpdatedAt = now.Storable();
            await StageLapseNoticesAsync(x.Booking, x.Seat, shareForNotice, settings, ct);
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

        var due = await _db.BookingParticipants
            .Where(p => p.Seat > 1 && p.UserId != null && p.LapsedAt == null && p.SettledOutsideAt == null
                        && p.ReminderCount < max && p.InvitedAt <= since
                        && (p.LastReminderAt == null || p.LastReminderAt <= since)
                        && (p.Status == ParticipantStatus.Invited || p.Status == ParticipantStatus.Accepted))
            .Join(_db.Bookings.Where(b => b.Status == BookingStatus.Booked || b.Status == BookingStatus.Completed),
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
