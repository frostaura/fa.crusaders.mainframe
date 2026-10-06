using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services.Demo;

public sealed partial class DemoDataGenerator
{
    /// <summary>
    /// The organiser's seat and each partner's, split equally at the invite (D11) — a declined or
    /// lapsed seat's share stays with the organiser — and each accepted share moved as the
    /// <see cref="ShareLedger"/> moves it: one pair at the accept, and the pair back when the
    /// game is cancelled.
    /// </summary>
    private static void Seat(DemoWorld w, PlannedGame game, List<DemoPerson> partners, bool mirrorInvited)
    {
        var b = game.Booking;
        var organiser = game.Organiser.UserId;
        var asked = b.CreatedAt.AddMinutes(1);
        var organiserSeat = NewSeat(w, b, 1, organiser, organiser, b.CreatedAt);
        organiserSeat.Status = ParticipantStatus.Accepted;
        organiserSeat.RespondedAt = b.CreatedAt;
        game.Partners.Add((game.Organiser, organiserSeat));

        var inputs = Enumerable.Range(1, partners.Count + 1).Select(n => new SplitSeat(n, false)).ToList();
        var shares = SplitCalculator.Split(b.AmountChargedMinutes, SplitModes.Equal, inputs).Shares!;
        var live = 0;
        for (var i = 0; i < partners.Count; i++)
        {
            var seat = NewSeat(w, b, i + 2, partners[i].UserId, organiser, asked);
            seat.ShareMinutes = shares.First(s => s.Seat == i + 2).ShareMinutes;
            Respond(w, game, partners[i], seat, mirrorInvited && partners[i].IsMirror);
            if (seat.IsLive) live += seat.ShareMinutes;
            game.Partners.Add((partners[i], seat));
        }
        organiserSeat.ShareMinutes = Math.Max(0, b.AmountChargedMinutes - live);
        b.ShareDeadlineAt = PlayerSettingsDeadline(w, b);
    }

    private static BookingParticipant NewSeat(DemoWorld w, Booking b, int seat, Guid userId, Guid invitedBy, DateTimeOffset at)
    {
        return new BookingParticipant
        {
            TenantId = w.TenantId,
            BookingId = b.Id,
            Seat = seat,
            UserId = userId,
            Status = ParticipantStatus.Invited,
            ShareWeight = 1,
            SplitMode = seat == 1 ? SplitModes.Equal : null,
            InvitedByUserId = invitedBy,
            InvitedAt = at,
            CreatedAt = at,
            UpdatedAt = at,
        };
    }

    /// <summary>What the partner did with the invite, and the money their answer moved.</summary>
    private static void Respond(DemoWorld w, PlannedGame game, DemoPerson partner, BookingParticipant seat, bool keepOpen)
    {
        var b = game.Booking;
        var status = keepOpen ? ParticipantStatus.Invited : AnswerFor(w, game, partner);
        seat.Status = status;
        var day = w.DateOf(b.StartsAt);
        if (seat.IsLive) partner.Occupy(day, b.StartsAt, b.EndsAt);
        if (status == ParticipantStatus.Invited) return;

        var answered = AnsweredAt(w, game, seat);
        seat.RespondedAt = answered;
        seat.UpdatedAt = answered;
        if (status == ParticipantStatus.Lapsed)
        {
            seat.RespondedAt = null;
            seat.LapsedAt = PlayerSettingsDeadline(w, b);
            return;
        }
        if (status != ParticipantStatus.Accepted) return;

        seat.ConsentedMinutes = seat.ShareMinutes;
        if (b.CheckedInAt is { } lit) seat.CheckedInAt = lit.AddMinutes(w.Rng.Next(0, 4));
        if (seat.ShareMinutes == 0) return;
        Pair(w, b, seat, (1, answered), (partner.UserId, game.Organiser.UserId));
        if (b.CancelledAt is { } cancelled) Pair(w, b, seat, (2, cancelled.AddSeconds(2)), (game.Organiser.UserId, partner.UserId));
    }

    private static ParticipantStatus AnswerFor(DemoWorld w, PlannedGame game, DemoPerson partner)
    {
        var roll = w.Rng.NextDouble();
        return game.Fate switch
        {
            GameFate.InPlay => ParticipantStatus.Accepted,
            GameFate.Completed when PlayerSettingsDeadline(w, game.Booking) > w.Now => roll < 0.9 ? ParticipantStatus.Accepted : ParticipantStatus.Declined,
            GameFate.Completed => roll < 0.85 ? ParticipantStatus.Accepted : roll < 0.95 ? ParticipantStatus.Declined : ParticipantStatus.Lapsed,
            GameFate.Upcoming when partner.IsMirror => roll < 0.7 ? ParticipantStatus.Invited : ParticipantStatus.Accepted,
            GameFate.Upcoming => roll < 0.55 ? ParticipantStatus.Accepted : roll < 0.95 ? ParticipantStatus.Invited : ParticipantStatus.Declined,
            _ => roll < 0.65 ? ParticipantStatus.Accepted : ParticipantStatus.Declined,
        };
    }

    private static DateTimeOffset AnsweredAt(DemoWorld w, PlannedGame game, BookingParticipant seat)
    {
        var b = game.Booking;
        var at = seat.InvitedAt + w.Between(TimeSpan.FromMinutes(4), TimeSpan.FromHours(30));
        var latest = new[] { b.StartsAt.AddMinutes(-10), w.Now.AddMinutes(-1), (b.CancelledAt ?? DateTimeOffset.MaxValue).AddMinutes(-1) }.Min();
        if (at > latest) at = latest;
        if (at <= seat.InvitedAt) at = seat.InvitedAt.AddSeconds(30);
        return at.Storable();
    }

    /// <summary>A share pair, as <see cref="ShareLedger.Pair"/> writes it: the debited member's <c>out</c> leg and the receiver's <c>in</c> leg.</summary>
    private static void Pair(DemoWorld w, Booking b, BookingParticipant seat, (int Seq, DateTimeOffset At) leg, (Guid Debited, Guid Received) who)
    {
        var (seq, at) = leg;
        var (debited, received) = who;
        var back = seq > 1;
        var reason = back ? "Share of a split booking returned" : "Share of a split booking";
        var actor = back ? received == seat.UserId ? debited : received : debited;
        w.Money.Add(new DemoMoney(at, debited, LedgerEntryType.ShareTransfer, -seat.ShareMinutes, reason)
        { BookingId = b.Id, Reference = ShareLedger.Reference(seat.Id, seq, "out"), ActorUserId = actor });
        w.Money.Add(new DemoMoney(at, received, LedgerEntryType.ShareTransfer, seat.ShareMinutes, reason)
        { BookingId = b.Id, Reference = ShareLedger.Reference(seat.Id, seq, "in"), ActorUserId = actor });
    }

    /// <summary>The share deadline the booking is stamped with when it first gets players.</summary>
    private static DateTimeOffset PlayerSettingsDeadline(DemoWorld w, Booking b) =>
        PlayerSettings.DeadlineFromSettings(b, w.Settings).Storable();
}
