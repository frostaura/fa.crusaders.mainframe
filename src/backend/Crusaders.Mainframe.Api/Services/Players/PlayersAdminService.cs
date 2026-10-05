using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Admin god mode on a booking's players (D11): add, remove, accept on a member's behalf, record
/// a share as settled outside the app, and — only when asked for by name — collect a share below
/// zero. Every one is written to the undeletable <c>admin_change_log</c>.
///
/// <para>
/// <b>Nothing here debits a partner by implication.</b> An admin's accept records that the member
/// is playing; it does not record the member's consent, so the reconcile collects nothing from
/// them (<see cref="BookingParticipant.ConsentedMinutes"/> stays where the member left it). Money
/// moves from a partner only through the member's own accept or through <see cref="CollectAsync"/>,
/// which needs a reason and — when the partner's balance does not cover it (R16 J16-10) —
/// <c>allowNegativeBalance</c>: the R19 posture, applied to shares.
/// </para>
/// </summary>
public sealed class PlayersAdminService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly PlayersService _players;
    private readonly ShareLedger _shares;
    private readonly AdminChangeRecorder _changes;
    private readonly LedgerService _ledger;

    public PlayersAdminService(
        MainframeDbContext db, ITenantContext tenant, PlayersService players, ShareLedger shares,
        AdminChangeRecorder changes, LedgerService ledger)
    {
        _db = db; _tenant = tenant; _players = players; _shares = shares; _changes = changes; _ledger = ledger;
    }

    /// <summary>
    /// What one admin action is about: which booking, which seat, who, why — and whether the desk
    /// named the overdraft (<c>allowNegativeBalance</c>), which a hand-back after the share
    /// deadline needs (review H1).
    /// </summary>
    public sealed record AdminAct(Guid BookingId, Guid? SeatId, Guid ActorId, string? Reason, bool AllowNegativeBalance = false);

    /// <summary>
    /// A remove or a settle-outside hands the seat's paid share back from the organiser. When the
    /// organiser's COVERAGE for this seat (<see cref="ShareHolds.CoverageAsync"/>: the booking's own
    /// hold plus the balance free of other holds and earlier waiting returns) does not cover it, the desk must say the overdraft by name, exactly as for a collect, and it is on
    /// the change record; without it <c>400 overdraft_not_authorised</c>. Keyed on coverage, not the
    /// deadline (review round 2): a game cancelled after check-in releases its shares before the
    /// deadline. The ledger holds the same line on its own (<c>ShareLedger</c>): a return that
    /// slips past this check in a race waits rather than overdrawing.
    /// </summary>
    private async Task<PlayerOutcome?> UncoveredReturnRefusalAsync(
        PlayersService.Game game, BookingParticipant seat, AdminAct act, CancellationToken ct)
    {
        if (act.AllowNegativeBalance) return null;
        var paid = await _shares.PaidAsync(seat, ct);
        if (paid <= 0) return null;
        var coverage = await _ledger.GetCoverageAsync(ShareLedger.PayerOf(game.Booking), game.Booking.Id, seat.Id, ct);
        return coverage < paid
            ? PlayerOutcome.Refuse(400, PlayerErrors.OverdraftNotAuthorised, new { return_minutes = paid, covered_minutes = Math.Max(0, coverage) })
            : null;
    }

    /// <summary>The reconcile's authority for this act: the named overdraft lets this seat's return post whatever the organiser holds.</summary>
    private static ReconcileOptions OptionsFor(AdminAct act, BookingParticipant seat) =>
        new(act.ActorId, act.AllowNegativeBalance ? seat.Id : null);

    /// <summary>Adds a member or a guest. The member is invited (or placed, with <paramref name="accepted"/>) — never charged.</summary>
    public async Task<PlayerOutcome> AddAsync(AdminAct act, PlayerSpec spec, bool accepted, CancellationToken ct)
    {
        var game = await _players.LoadAsync(act.BookingId, ct);
        if (game is null) return PlayerOutcome.BookingNotFound;
        if (game.Booking.Status is not (BookingStatus.Booked or BookingStatus.Completed)) return PlayerOutcome.Refuse(409, PlayerErrors.BookingNotOpen);

        // The organiser's own path, acting as the organiser: the same seats, split and invites.
        var added = await _players.AddAsync(
            act.BookingId, game.Booking.UserId!.Value, new PlayersRequest([spec]), ct, new PlayersService.ClubAdd(act.ActorId, accepted));
        if (!added.IsOk) return added;

        var seat = await _db.BookingParticipants
            .Where(p => p.BookingId == act.BookingId && p.InvitedByUserId == act.ActorId
                        && (p.Status == ParticipantStatus.Invited || p.Status == ParticipantStatus.Accepted))
            .OrderByDescending(p => p.CreatedAt).FirstAsync(ct);
        if (accepted && seat.Status == ParticipantStatus.Invited && seat.UserId is not null)
        {
            seat.Status = ParticipantStatus.Accepted;
            seat.RespondedAt = StorableTime.UtcNow;
            seat.UpdatedAt = StorableTime.UtcNow;
        }
        await RecordAsync(AdminChangeActions.BookingPlayerAdded, act, seat, new { status = PlayerViews.StatusName(seat.Status), guest = seat.GuestName }, ct);
        await _db.SaveChangesAsync(ct);
        return added;
    }

    public async Task<PlayerOutcome> RemoveAsync(AdminAct act, CancellationToken ct)
    {
        if (Reason(act) is { } missing) return missing;
        var game = await _players.LoadAsync(act.BookingId, ct);
        if (game is null) return PlayerOutcome.BookingNotFound;
        var seat = game.Seats.FirstOrDefault(s => s.Id == act.SeatId && s.Seat > 1 && s.IsLive);
        if (seat is null) return PlayerOutcome.PlayerNotFound;
        if (await UncoveredReturnRefusalAsync(game, seat, act, ct) is { } uncovered) return uncovered;

        await RecordAsync(AdminChangeActions.BookingPlayerRemoved, act, seat,
            new { status = "removed", overdraft_authorised = act.AllowNegativeBalance }, ct);
        var options = OptionsFor(act, seat) with { ClubRemoval = new ClubRemoval(seat.Id, act.Reason) };
        return await WithReturnStateAsync(await _players.RemoveSeatAsync(game, seat.Id, DateTimeOffset.UtcNow, ct, options), seat.Id, ct);
    }

    /// <summary>
    /// The hand-back's answer tells the desk whether the money actually went (review round 3): the
    /// coverage check above is not under the organiser's lock, so a spend in between can leave the
    /// return waiting even though the action succeeded. <c>return_waiting</c> says so, with
    /// <c>return_minutes</c> — what is due back and waiting — when it does.
    /// </summary>
    private async Task<PlayerOutcome> WithReturnStateAsync(PlayerOutcome outcome, Guid seatId, CancellationToken ct)
    {
        if (!outcome.IsOk) return outcome;
        var seat = await _db.BookingParticipants.AsNoTracking().FirstAsync(p => p.Id == seatId, ct);
        var waiting = seat.ReturnPendingSince is not null;
        return PlayerOutcome.Ok(new
        {
            participant_id = seat.Id,
            status = PlayerViews.StatusName(seat.Status),
            return_waiting = waiting,
            return_minutes = waiting ? await _shares.PaidAsync(seat, ct) : (int?)null,
        });
    }

    /// <summary>Marks an invited member as playing. Records no consent, so collects nothing.</summary>
    public async Task<PlayerOutcome> AcceptOnBehalfAsync(AdminAct act, CancellationToken ct)
    {
        if (Reason(act) is { } missing) return missing;
        var (game, seat) = await SeatAsync(act, ct);
        if (seat is null) return PlayerOutcome.PlayerNotFound;
        if (seat.Status != ParticipantStatus.Invited || seat.UserId is null) return PlayerOutcome.Refuse(409, PlayerErrors.NotInvited);

        seat.Status = ParticipantStatus.Accepted;
        seat.RespondedAt = StorableTime.UtcNow;
        seat.UpdatedAt = StorableTime.UtcNow;
        await RecordAsync(AdminChangeActions.BookingPlayerAcceptedOnBehalf, act, seat, new { status = "accepted", consented_minutes = seat.ConsentedMinutes }, ct);
        // R16 E16-1: on the club's record too, in the act's own save — the partner's and the organiser's Nights said nothing.
        _db.AuditLogs.Add(PlayersService.SeatAuditFor(_tenant.TenantId, PlayersService.AcceptedByClubAction, game!.Booking, seat, act.ActorId,
            new { consented_minutes = seat.ConsentedMinutes }));
        // B8: the member is told the club said yes for them, in the same save.
        MemberNotices.Stage(_db, _tenant.TenantId,
            await PlayerNotices.ClubSeatAsync(_db, game.Booking, seat, game.Settings, "club-accepted", ct), game.Settings);
        // R16 E16-1: and the organiser — their game has a player they did not see say yes.
        MemberNotices.Stage(_db, _tenant.TenantId,
            await PlayerNotices.ClubAcceptedForOrganiserAsync(_db, game.Booking, seat, game.Settings, ct), game.Settings);
        return await SaveAndSettleAsync(game, seat, ct);
    }

    /// <summary>
    /// The share was paid by hand — cash at the desk, a transfer between friends. Nothing is
    /// collected in the app after this, and anything already collected goes back to the partner.
    /// Only for a seat the member took: settling an invite nobody answered would put them on
    /// the game without their yes — that is what accept-on-behalf is for, on its own record.
    /// </summary>
    public async Task<PlayerOutcome> SettleOutsideAsync(AdminAct act, CancellationToken ct)
    {
        if (Reason(act) is { } missing) return missing;
        var (game, seat) = await SeatAsync(act, ct);
        if (seat is null || seat.UserId is null) return PlayerOutcome.PlayerNotFound;
        if (seat.Status != ParticipantStatus.Accepted) return PlayerOutcome.Refuse(409, PlayerErrors.NotAccepted);
        if (await UncoveredReturnRefusalAsync(game!, seat, act, ct) is { } uncovered) return uncovered;

        var paid = await _shares.PaidAsync(seat, ct);
        seat.SettledOutsideAt = StorableTime.UtcNow;
        seat.RespondedAt ??= StorableTime.UtcNow;
        seat.UpdatedAt = StorableTime.UtcNow;
        await RecordAsync(AdminChangeActions.BookingShareSettledOutside, act, seat,
            new { share_minutes = seat.ShareMinutes, paid_in_app_minutes = paid, overdraft_authorised = act.AllowNegativeBalance }, ct);
        // R15 E15-3: on the club's record too, in the same save, so both players' Nights say it.
        _db.AuditLogs.Add(PlayersService.SeatAuditFor(_tenant.TenantId, PlayersService.SettledOutsideAction, game!.Booking, seat, act.ActorId,
            new { share_minutes = seat.ShareMinutes, paid_in_app_minutes = paid }));
        // R16 J16-6: both players are told, in the same save — the partner that they paid the organiser by hand.
        foreach (var notice in await PlayerNotices.SettledOutsideAsync(_db, game.Booking, seat, game.Settings, ct))
        {
            MemberNotices.Stage(_db, _tenant.TenantId, notice, game.Settings);
        }
        // R15 E15-8: the return's receipts carry the desk's reason.
        var options = OptionsFor(act, seat) with { ClubReason = act.Reason };
        return await WithReturnStateAsync(await SaveAndSettleAsync(game!, seat, ct, options), seat.Id, ct);
    }

    /// <summary>
    /// Collects the rest of a partner's share — the one path that may take a partner below zero, and
    /// only when <paramref name="allowNegativeBalance"/> says so by name; a share their spendable
    /// minutes cover needs no such word (R16 J16-10), and a short one without it is refused. It
    /// may collect after the share lapsed, which nothing else can.
    ///
    /// <para>
    /// <b>One transaction under the partner's lock</b> (<see cref="ShareLedger.CollectAsync"/>):
    /// the consent, the change-log line and the pair commit together, and the line records the
    /// figure actually posted — never a figure computed before the money moved, which is what a
    /// record written first and a reconcile run second used to leave when the reconcile posted
    /// less, or nothing.
    /// </para>
    /// </summary>
    public async Task<PlayerOutcome> CollectAsync(AdminAct act, bool allowNegativeBalance, CancellationToken ct)
    {
        if (Reason(act) is { } missing) return missing;
        var (game, seat) = await SeatAsync(act, ct);
        if (seat is null || seat.UserId is null) return PlayerOutcome.PlayerNotFound;
        // R16 E16-8: an invite nobody answered has no share to collect — said as that, not "not invited".
        if (seat.Status != ParticipantStatus.Accepted) return PlayerOutcome.Refuse(409, PlayerErrors.NotAccepted);
        if (seat.SettledOutsideAt is not null) return PlayerOutcome.Refuse(409, PlayerErrors.SettledOutside);
        _db.ChangeTracker.Clear();

        ShareLedger.Collected? collected;
        try
        {
            var booking = game!.Booking;
            collected = await _shares.CollectAsync(booking.Id, seat.Id, act.ActorId, (tracked, delta, before) =>
            {
                // R15 E15-3: the collect on the club's record, in the money's own save, with the figure posted.
                _db.AuditLogs.Add(PlayersService.SeatAuditFor(_tenant.TenantId, PlayersService.ShareCollectedAction, booking, tracked, act.ActorId,
                    new { collected_minutes = delta }));
                return RecordAsync(AdminChangeActions.BookingShareCollected, act, tracked,
                    new { collected_minutes = delta, balance_before_minutes = before, balance_after_minutes = before - delta }, ct);
            }, ct, new ShareLedger.CollectAsk(act.Reason, allowNegativeBalance));
        }
        catch (ShareLedger.CollectShortException shortBy)
        {
            // R16 J16-10: the overdraft is named only when it is one — a covered share collects without it.
            return PlayerOutcome.Refuse(400, PlayerErrors.OverdraftNotAuthorised,
                new { collect_minutes = shortBy.CollectMinutes, balance_minutes = shortBy.SpendableMinutes });
        }
        catch (DbUpdateException)
        {
            // Nothing was written — not the money, not the consent, not the record.
            return PlayerOutcome.Refuse(409, PlayerErrors.Conflict);
        }
        if (collected is null) return PlayerOutcome.Refuse(409, PlayerErrors.NothingToCollect);

        return PlayerOutcome.Ok(new
        {
            participant_id = seat.Id,
            collected_minutes = collected.Move.Delta,
            balance_after_minutes = collected.BalanceAfter,
        });
    }

    private async Task<(PlayersService.Game?, BookingParticipant?)> SeatAsync(AdminAct act, CancellationToken ct)
    {
        var game = await _players.LoadAsync(act.BookingId, ct);
        var seat = game?.Seats.FirstOrDefault(s => s.Id == act.SeatId && s.Seat > 1 && s.IsLive && s.GuestName is null);
        return (game, seat);
    }

    private async Task<PlayerOutcome> SaveAndSettleAsync(
        PlayersService.Game game, BookingParticipant seat, CancellationToken ct, ReconcileOptions? options = null)
    {
        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            _db.ChangeTracker.Clear();
            return PlayerOutcome.Refuse(409, PlayerErrors.Conflict);
        }
        await _shares.ReconcileAsync(game.Booking.Id, ct, options);
        return PlayerOutcome.Ok(new { participant_id = seat.Id, status = PlayerViews.StatusName(seat.Status) });
    }

    private static PlayerOutcome? Reason(AdminAct act) =>
        string.IsNullOrWhiteSpace(act.Reason) ? PlayerOutcome.Refuse(400, PlayerErrors.ReasonRequired) : null;

    private async Task RecordAsync(string action, AdminAct act, BookingParticipant seat, object after, CancellationToken ct)
    {
        var label = seat.UserId is { } u
            ? PersonNames.Of(u, await PersonNames.ForAsync(_db, [u], ct))
            : seat.GuestName;
        await _changes.StageAsync(new AdminChange(
            Action: action,
            ActorUserId: act.ActorId,
            SubjectKind: seat.UserId is null ? AdminChangeSubjects.Booking : AdminChangeSubjects.User,
            SubjectId: seat.UserId ?? act.BookingId,
            SubjectLabel: label,
            Reason: act.Reason?.Trim(),
            Before: new { booking_id = act.BookingId, participant_id = seat.Id, seat = seat.Seat },
            After: after), ct);
    }
}
