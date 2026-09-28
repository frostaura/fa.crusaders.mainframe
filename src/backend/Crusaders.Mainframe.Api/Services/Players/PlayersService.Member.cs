using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>A partner's own answers: accept (and pay), decline, withdraw — by seat or by link.</summary>
public sealed partial class PlayersService
{
    /// <summary>The seat a link names, or null. A malformed token never reaches the database.</summary>
    public async Task<BookingParticipant?> SeatForTokenAsync(string? token, CancellationToken ct)
    {
        if (!InviteTokens.LooksValid(token)) return null;
        var hash = InviteTokens.Hash(token!);
        return await _db.BookingParticipants.AsNoTracking().FirstOrDefaultAsync(p => p.InviteTokenHash == hash, ct);
    }

    /// <summary>Accepts through a shared link — claiming an open seat, or answering one addressed to the caller.</summary>
    public async Task<PlayerOutcome> AcceptByTokenAsync(string? token, Guid me, decimal? expectedShare, CancellationToken ct)
    {
        var seat = await SeatForTokenAsync(token, ct);
        if (seat is null || (seat.UserId is { } owner && owner != me)) return PlayerOutcome.InviteNotFound;
        return await AcceptAsync(seat.Id, me, expectedShare, ct, viaToken: true);
    }

    /// <summary>
    /// Accept — and pay — a seat. The partner's own consent, to the share they were SHOWN:
    /// <paramref name="expectedShare"/> is the figure on their accept sheet, required, and a share
    /// that has risen past it since is refused with <c>409 share_changed</c> and the current
    /// figure — a tap is consent to what the partner read, never to what the organiser typed after.
    ///
    /// <para>
    /// <b>An open link seat is claimed only through its link</b> (<paramref name="viaToken"/>):
    /// the seat route answers such a seat as a seat that names nothing, so a participant id seen
    /// in a detail view is no way round a link the organiser rotated.
    /// </para>
    ///
    /// <para>
    /// <b>Under the partner's lock, in one save.</b> The seat's new state and the first payment
    /// commit together or not at all: an accept the partner cannot afford changes nothing and
    /// answers 402 with the figures a top-up needs. The daily cap (D12) is asked under the same
    /// lock, which is the cap's own unit, so two accepts cannot both squeeze under it.
    /// </para>
    ///
    /// <para>
    /// <b>Idempotent.</b> A second tap finds the seat accepted and fully paid and answers the same
    /// 200 — one pair on the ledger, however many times the button was pressed. Accepting an
    /// already-accepted seat whose share went UP is how a partner consents to the new figure.
    /// </para>
    /// </summary>
    public async Task<PlayerOutcome> AcceptAsync(Guid seatId, Guid me, decimal? expectedShare, CancellationToken ct, bool viaToken = false)
    {
        PlayerOutcome outcome;
        try
        {
            outcome = await AcceptUnderLockAsync(new AcceptAsk(seatId, me, expectedShare, viaToken), ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            _db.ChangeTracker.Clear();
            return await AlreadyAnsweredAsync(seatId, me, ct, expectedShare);
        }
        catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: "23505" })
        {
            _db.ChangeTracker.Clear();
            return await AlreadyAnsweredAsync(seatId, me, ct, expectedShare);
        }

        if (outcome.IsOk && outcome.Body is AcceptBody body)
        {
            await AfterAsync(body.BookingId, [body.OrganiserId], ct);
            return PlayerOutcome.Ok(body.Answer);
        }
        return outcome;
    }

    private sealed record AcceptBody(Guid BookingId, Guid OrganiserId, object Answer);

    /// <summary>One accept: whose, of which seat, at which figure, and by which route.</summary>
    private sealed record AcceptAsk(Guid SeatId, Guid Me, decimal? Expected, bool ViaToken);

    /// <summary>
    /// After a lost race: the winner's accept is this caller's answer too — but only when it was
    /// theirs AND the consent on it still covers the share, and the share is still the figure the
    /// caller agreed to. A share raised between the two taps is a 409 with the current figure,
    /// never a stale 200 that reads as "you agreed to this".
    /// </summary>
    internal async Task<PlayerOutcome> AlreadyAnsweredAsync(Guid seatId, Guid me, CancellationToken ct, decimal? expected = null)
    {
        var seat = await _db.BookingParticipants.AsNoTracking().FirstOrDefaultAsync(p => p.Id == seatId, ct);
        if (seat?.UserId != me || seat.Status != ParticipantStatus.Accepted) return PlayerOutcome.Refuse(409, PlayerErrors.InviteClosed);
        if (seat.ConsentedCredits < seat.ShareCredits || (expected is { } e && seat.ShareCredits > e))
        {
            return PlayerOutcome.Refuse(409, PlayerErrors.ShareChanged, new { share_credits = seat.ShareCredits });
        }
        return PlayerOutcome.Ok(await AnswerAsync(seat, ct));
    }

    private async Task<PlayerOutcome> AcceptUnderLockAsync(AcceptAsk ask, CancellationToken ct)
    {
        var (seatId, me) = (ask.SeatId, ask.Me);
        await using var payerLock = await PayerLock.BeginAsync(_db, _tenant.TenantId, me, _p.Outbox, ct);
        await LockSeatAsync(seatId, ct);
        var now = DateTimeOffset.UtcNow;

        var seat = await _db.BookingParticipants.FirstOrDefaultAsync(p => p.Id == seatId, ct);
        if (SeatRefusal(seat, ask) is { } notYours) return notYours;
        var expected = ask.Expected!.Value;
        var game = await LoadAsync(seat!.BookingId, ct);
        if (game is null) return PlayerOutcome.InviteNotFound;
        seat = game.Seats.First(s => s.Id == seatId);

        if (await AcceptRefusalAsync(game, seat, me, now, ct) is { } refused) return refused;
        if (seat.ShareCredits > expected)
        {
            return PlayerOutcome.Refuse(409, PlayerErrors.ShareChanged, new { share_credits = seat.ShareCredits });
        }

        var fresh = seat.Status == ParticipantStatus.Invited;
        seat.UserId = me;
        seat.Status = ParticipantStatus.Accepted;
        seat.ConsentedCredits = Math.Max(seat.ConsentedCredits, seat.ShareCredits);
        seat.RespondedAt ??= now.Storable();
        seat.UpdatedAt = now.Storable();

        // Open by the refusal above (before the deadline, not lapsed), so never closed here.
        var paid = await _p.Shares.PaidAsync(seat, ct);
        var delta = ShareLedger.TargetFor(game.Booking, seat, await _p.Shares.OwedAsync(game.Booking, ct), paid) - paid;
        IReadOnlyList<LedgerPosting> postings = [];
        if (delta > 0)
        {
            // Spendable: shares this partner holds as an organiser elsewhere are not theirs to pay with (D11).
            var balance = await _p.Ledger.GetSpendableAsync(me, ct);
            if (balance < delta)
            {
                _db.ChangeTracker.Clear();
                return PlayerOutcome.Refuse(402, PlayerErrors.InsufficientBalance, new { current_credits = balance, required_credits = delta });
            }
            postings = await _p.Shares.StageCollectionAsync(game.Booking, seat, delta, me, ct);
        }
        if (fresh) MemberNotices.Stage(_db, _tenant.TenantId, await PlayerNotices.ResponseAsync(_db, game.Booking, seat, game.Settings, "accepted", ct), game.Settings);

        // One save: the seat, the pair, the receipts. An empty posting list still saves the seat.
        await _p.Ledger.PostManyAsync(postings, ct);
        await payerLock.CommitAsync(ct);
        return PlayerOutcome.Ok(new AcceptBody(game.Booking.Id, game.Booking.UserId!.Value, await AnswerAsync(seat, ct)));
    }

    /// <summary>
    /// The seat's own lock, taken AFTER the member's, inside the same transaction. Two members
    /// claiming one open link seat hold different member locks, so without this they both staged
    /// the seat's update and the first pair's references and deadlocked on each other's rows
    /// (40P01, seen under the racing-claim test). Always member-then-seat, so no cycle is possible.
    /// </summary>
    private async Task LockSeatAsync(Guid seatId, CancellationToken ct)
    {
        if (!_db.Database.IsNpgsql()) return;
        await _db.Database.ExecuteSqlRawAsync(
            "SELECT pg_advisory_xact_lock({0})", [PayerLock.KeyFor(_tenant.TenantId, seatId)], ct);
    }

    /// <summary>
    /// Is this seat the caller's to accept at all? A 404 for anything that is not — the organiser's
    /// seat, a guest's, somebody else's, and an open link seat reached by its id rather than its
    /// link. Only then is the figure asked for, so a stranger reads the same uninformative 404.
    /// </summary>
    private static PlayerOutcome? SeatRefusal(BookingParticipant? seat, AcceptAsk ask)
    {
        if (seat is null || seat.Seat == 1 || seat.GuestName is not null) return PlayerOutcome.InviteNotFound;
        if (seat.UserId is { } owner && owner != ask.Me) return PlayerOutcome.InviteNotFound;
        if (seat.UserId is null && !ask.ViaToken) return PlayerOutcome.InviteNotFound;
        return ask.Expected is null ? PlayerOutcome.Refuse(400, PlayerErrors.ExpectedShareRequired) : null;
    }

    /// <summary>
    /// The seat and the game as they stand: closed, the caller already on it, or the caller taken
    /// off it — no link, open or addressed, puts a removed member back; only an admin's add does.
    /// </summary>
    private static PlayerOutcome? StandingRefusal(Game game, BookingParticipant seat, Guid me, DateTimeOffset now)
    {
        if (!seat.IsLive || !IsOpen(game, now) || seat.SettledOutsideAt is not null || seat.LapsedAt is not null)
        {
            return PlayerOutcome.Refuse(409, PlayerErrors.InviteClosed);
        }
        if (game.Booking.UserId == me || game.Live.Any(s => s.Id != seat.Id && s.UserId == me))
        {
            return PlayerOutcome.Refuse(409, PlayerErrors.AlreadyInBooking);
        }
        return game.Seats.Any(s => s.Id != seat.Id && s.UserId == me && s.Status == ParticipantStatus.Removed)
            ? PlayerOutcome.Refuse(409, PlayerErrors.PreviouslyRemoved)
            : null;
    }

    /// <summary>Every reason an accept is refused, in the order a partner would want to hear them.</summary>
    private async Task<PlayerOutcome?> AcceptRefusalAsync(Game game, BookingParticipant seat, Guid me, DateTimeOffset now, CancellationToken ct)
    {
        if (StandingRefusal(game, seat, me, now) is { } standing) return standing;
        if (!await IsActiveMemberAsync(me, ct)) return PlayerOutcome.Refuse(403, PlayerErrors.MembershipInactive);

        // D12, asked only for a game still ahead and only on the first yes: a partner paying
        // after the game has been played is settling up, not taking court time.
        if (seat.Status == ParticipantStatus.Invited && game.Booking.StartsAt > now
            && await _p.Rules.PartnerCapRefusalAsync(me, game.Booking, game.Settings, ct) is { } cap)
        {
            return PlayerOutcome.Refuse(409, PlayerErrors.PartnerCapExceeded, CapFigures(cap));
        }

        // A seat already accepted and fully paid at its current share: nothing to do.
        if (seat.Status == ParticipantStatus.Accepted && seat.ConsentedCredits >= seat.ShareCredits
            && await _p.Shares.UnpaidAsync(game.Booking, seat, ct) <= 0m)
        {
            return PlayerOutcome.Ok(await AnswerAsync(seat, ct));
        }
        return null;
    }

    /// <summary>The cap refusal's own figures, under the partner-cap code.</summary>
    internal static object CapFigures(BookingResult cap)
    {
        switch (cap)
        {
            case BookingResult.PerDaySlotCapExceeded s:
                return new { cap = "slots", cap_slots = s.CapSlots, booked_slots = s.BookedSlots, attempted_slots = s.AttemptedSlots, club_day = s.ClubDay };
            case BookingResult.PerDayCapExceeded m:
                return new { cap = "minutes", cap_minutes = m.CapMinutes, already_booked_minutes = m.AlreadyBookedMinutes, attempted_minutes = m.AttemptedMinutes, club_day = m.ClubDay };
            default:
                return new { cap = BookingRefusals.CodeOf(cap) };
        }
    }

    /// <summary>
    /// The accept's answer. <c>balance_credits</c> is the RAW balance, as on every route; what the
    /// partner may spend and what they hold for partners of their own sit beside it (review (a)).
    /// </summary>
    private async Task<object> AnswerAsync(BookingParticipant seat, CancellationToken ct)
    {
        var balance = seat.UserId is { } u ? await _p.Ledger.GetBalanceAsync(u, ct) : 0m;
        var held = seat.UserId is { } h ? await _p.Ledger.GetHeldAsync(h, ct) : HeldCredits.None;
        return new
        {
            participant_id = seat.Id,
            booking_id = seat.BookingId,
            status = PlayerViews.StatusName(seat.Status),
            share_credits = seat.ShareCredits,
            consented_credits = seat.ConsentedCredits,
            paid_credits = await _p.Shares.PaidAsync(seat, ct),
            balance_credits = balance,
            spendable_credits = balance - held.Held,
            held_credits = held.Held,
        };
    }

    /// <summary>Declines an invite addressed to the caller. The seat goes back to the organiser.</summary>
    public async Task<PlayerOutcome> DeclineAsync(Guid seatId, Guid me, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var seat = await _db.BookingParticipants.AsNoTracking().FirstOrDefaultAsync(p => p.Id == seatId, ct);
        if (seat is null || seat.UserId != me) return PlayerOutcome.InviteNotFound;
        var game = await LoadAsync(seat.BookingId, ct);
        if (game is null) return PlayerOutcome.InviteNotFound;
        seat = game.Seats.First(s => s.Id == seatId);
        if (seat.Status != ParticipantStatus.Invited) return PlayerOutcome.Refuse(409, PlayerErrors.NotInvited);

        seat.Status = ParticipantStatus.Declined;
        seat.RespondedAt = now.Storable();
        seat.UpdatedAt = now.Storable();
        MemberNotices.Stage(_db, _tenant.TenantId, await PlayerNotices.ResponseAsync(_db, game.Booking, seat, game.Settings, "declined", ct), game.Settings);
        if (await SaveAsync(ct) is { } conflict) return conflict;
        await AfterAsync(game.Booking.Id, [game.Booking.UserId!.Value], ct);
        return PlayerOutcome.Ok(new { participant_id = seat.Id, status = PlayerViews.StatusName(seat.Status) });
    }

    /// <summary>
    /// An accepted partner pulling out — allowed only outside the club's late-cancel window, the
    /// same line the organiser's own cancellation is held to. Inside it the seat stands and so
    /// does the share: the organiser can no longer resell the court either.
    /// </summary>
    public async Task<PlayerOutcome> WithdrawAsync(Guid seatId, Guid me, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var seat = await _db.BookingParticipants.AsNoTracking().FirstOrDefaultAsync(p => p.Id == seatId, ct);
        if (seat is null || seat.UserId != me || seat.Seat == 1) return PlayerOutcome.PlayerNotFound;
        var game = await LoadAsync(seat.BookingId, ct);
        if (game is null) return PlayerOutcome.PlayerNotFound;
        seat = game.Seats.First(s => s.Id == seatId);
        if (seat.Status != ParticipantStatus.Accepted) return PlayerOutcome.Refuse(409, PlayerErrors.NotInvited);

        var closesAt = game.Booking.StartsAt.AddMinutes(-game.Settings.PenaltyWindowMinutes);
        if (now >= closesAt || game.Booking.Status != BookingStatus.Booked)
        {
            return PlayerOutcome.Refuse(409, PlayerErrors.WithdrawWindowClosed, new { closed_at = closesAt });
        }

        seat.Status = ParticipantStatus.Withdrawn;
        seat.RespondedAt = now.Storable();
        seat.UpdatedAt = now.Storable();
        MemberNotices.Stage(_db, _tenant.TenantId, await PlayerNotices.ResponseAsync(_db, game.Booking, seat, game.Settings, "withdrew", ct), game.Settings);
        if (await SaveAsync(ct) is { } conflict) return conflict;
        await AfterAsync(game.Booking.Id, [game.Booking.UserId!.Value], ct);
        return PlayerOutcome.Ok(new { participant_id = seat.Id, status = PlayerViews.StatusName(seat.Status) });
    }
}
