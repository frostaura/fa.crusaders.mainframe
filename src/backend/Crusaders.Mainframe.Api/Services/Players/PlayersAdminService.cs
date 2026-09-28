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
/// them (<see cref="BookingParticipant.ConsentedCredits"/> stays where the member left it). Money
/// moves from a partner only through the member's own accept or through <see cref="CollectAsync"/>,
/// which must be sent with <c>allowNegativeBalance</c> and a reason — the R19 posture, applied to
/// shares.
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

    /// <summary>What one admin action is about: which booking, which seat, who, why.</summary>
    public sealed record AdminAct(Guid BookingId, Guid? SeatId, Guid ActorId, string? Reason);

    /// <summary>Adds a member or a guest. The member is invited (or placed, with <paramref name="accepted"/>) — never charged.</summary>
    public async Task<PlayerOutcome> AddAsync(AdminAct act, PlayerSpec spec, bool accepted, CancellationToken ct)
    {
        var game = await _players.LoadAsync(act.BookingId, ct);
        if (game is null) return PlayerOutcome.BookingNotFound;
        if (game.Booking.Status is not (BookingStatus.Booked or BookingStatus.Completed)) return PlayerOutcome.Refuse(409, PlayerErrors.BookingNotOpen);

        // The organiser's own path, acting as the organiser: the same seats, split and invites.
        var added = await _players.AddAsync(act.BookingId, game.Booking.UserId!.Value, new PlayersRequest([spec]), ct, act.ActorId);
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

        await RecordAsync(AdminChangeActions.BookingPlayerRemoved, act, seat, new { status = "removed" }, ct);
        return await _players.RemoveSeatAsync(game, seat.Id, DateTimeOffset.UtcNow, ct);
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
        await RecordAsync(AdminChangeActions.BookingPlayerAcceptedOnBehalf, act, seat, new { status = "accepted", consented_credits = seat.ConsentedCredits }, ct);
        return await SaveAndSettleAsync(game!, seat, ct);
    }

    /// <summary>
    /// The share was paid by hand — cash at the desk, a transfer between friends. Nothing is
    /// collected in the app after this, and anything already collected goes back to the partner.
    /// </summary>
    public async Task<PlayerOutcome> SettleOutsideAsync(AdminAct act, CancellationToken ct)
    {
        if (Reason(act) is { } missing) return missing;
        var (game, seat) = await SeatAsync(act, ct);
        if (seat is null || seat.UserId is null) return PlayerOutcome.PlayerNotFound;

        var paid = await _shares.PaidAsync(seat, ct);
        seat.Status = ParticipantStatus.Accepted;
        seat.SettledOutsideAt = StorableTime.UtcNow;
        seat.RespondedAt ??= StorableTime.UtcNow;
        seat.UpdatedAt = StorableTime.UtcNow;
        await RecordAsync(AdminChangeActions.BookingShareSettledOutside, act, seat,
            new { share_credits = seat.ShareCredits, paid_in_app_credits = paid }, ct);
        return await SaveAndSettleAsync(game!, seat, ct);
    }

    /// <summary>
    /// Collects the rest of a partner's share whatever their balance — the one path that may take a
    /// partner below zero, and only when <paramref name="allowNegativeBalance"/> says so by name.
    /// </summary>
    public async Task<PlayerOutcome> CollectAsync(AdminAct act, bool allowNegativeBalance, CancellationToken ct)
    {
        if (Reason(act) is { } missing) return missing;
        if (!allowNegativeBalance) return PlayerOutcome.Refuse(400, PlayerErrors.OverdraftNotAuthorised);
        var (game, seat) = await SeatAsync(act, ct);
        if (seat is null || seat.UserId is not { } partner) return PlayerOutcome.PlayerNotFound;
        if (seat.Status != ParticipantStatus.Accepted || seat.SettledOutsideAt is not null) return PlayerOutcome.Refuse(409, PlayerErrors.NotInvited);

        var unpaid = await _shares.UnpaidAsync(game!.Booking, seat, ct);
        if (unpaid <= 0m) return PlayerOutcome.Refuse(409, PlayerErrors.NothingToCollect);

        var before = await _ledger.GetBalanceAsync(partner, ct);
        seat.ConsentedCredits = seat.ShareCredits;
        seat.UpdatedAt = StorableTime.UtcNow;
        await RecordAsync(AdminChangeActions.BookingShareCollected, act, seat,
            new { collected_credits = unpaid, balance_before_credits = before, balance_after_credits = before - unpaid }, ct);
        await _db.SaveChangesAsync(ct);

        var moves = await _shares.ReconcileAsync(game.Booking.Id, ct, new ReconcileOptions(act.ActorId, seat.Id));
        return PlayerOutcome.Ok(new
        {
            participant_id = seat.Id,
            collected_credits = moves.Where(m => m.ParticipantId == seat.Id).Sum(m => m.Delta),
            balance_after_credits = await _ledger.GetBalanceAsync(partner, ct),
        });
    }

    private async Task<(PlayersService.Game?, BookingParticipant?)> SeatAsync(AdminAct act, CancellationToken ct)
    {
        var game = await _players.LoadAsync(act.BookingId, ct);
        var seat = game?.Seats.FirstOrDefault(s => s.Id == act.SeatId && s.Seat > 1 && s.IsLive && s.GuestName is null);
        return (game, seat);
    }

    private async Task<PlayerOutcome> SaveAndSettleAsync(PlayersService.Game game, BookingParticipant seat, CancellationToken ct)
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
        await _shares.ReconcileAsync(game.Booking.Id, ct);
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
