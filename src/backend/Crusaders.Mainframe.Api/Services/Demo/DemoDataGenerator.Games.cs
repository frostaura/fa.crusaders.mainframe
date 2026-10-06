using System.Globalization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;

namespace Crusaders.Mainframe.Api.Services.Demo;

public sealed partial class DemoDataGenerator
{
    /// <summary>
    /// One game, written as the club would have written it: the booking, its seats and the money
    /// each step moved, on the timeline the step happened on. <paramref name="mirrorInvited"/>
    /// keeps any mirror partner's seat open (an invite waiting on the admin's Invites tab).
    /// </summary>
    private PlannedGame PlanGame(DemoWorld w, Slot slot, DemoPerson organiser, List<DemoPerson> partners, GameFate fate, bool mirrorInvited = false)
    {
        var created = CreatedAt(w, slot, organiser);
        var booking = new Booking
        {
            TenantId = w.TenantId,
            CourtId = slot.Court.Id,
            UserId = organiser.UserId,
            BookedByUserId = organiser.UserId,
            ActorUserId = organiser.UserId,
            StartsAt = slot.Start,
            EndsAt = slot.End,
            SliceMinutes = Math.Max(w.Settings.SliceMinutes, 1),
            SliceCount = Math.Max(slot.Length / Math.Max(w.Settings.SliceMinutes, 1), 1),
            AmountChargedMinutes = slot.Length,
            Status = BookingStatus.Booked,
            ChargedAt = created,
            CreatedAt = created,
        };
        var game = new PlannedGame { Booking = booking, Organiser = organiser, Fate = fate, CourtName = slot.Court.Name };
        _db.Bookings.Add(booking);

        w.Hold(slot.Court.Id, slot.Start, slot.End);
        organiser.OrganisedOn.Add(slot.Day);
        organiser.Occupy(slot.Day, slot.Start, slot.End);
        w.Money.Add(new DemoMoney(created, organiser.UserId, LedgerEntryType.BookingCharge, -slot.Length,
            $"Booking {slot.Court.Name} · {Local(w, slot.Start)}")
        { BookingId = booking.Id, ActorUserId = organiser.UserId });

        Settle(w, game, slot);
        if (partners.Count > 0) Seat(w, game, partners, mirrorInvited);
        return game;
    }

    private static DateTimeOffset CreatedAt(DemoWorld w, Slot slot, DemoPerson organiser)
    {
        var created = slot.Start - w.Between(TimeSpan.FromHours(3), TimeSpan.FromDays(Math.Min(6, Math.Max(w.Settings.AdvanceBookingDays, 1))));
        if (created > w.Now) created = w.Now - w.Between(TimeSpan.FromMinutes(20), TimeSpan.FromDays(2));
        if (created < organiser.JoinedAt) created = organiser.JoinedAt.AddHours(1);
        return created.Storable();
    }

    /// <summary>The booking's own ending and the money it moved (settlement S1–S5).</summary>
    private static void Settle(DemoWorld w, PlannedGame game, Slot slot)
    {
        var b = game.Booking;
        var payer = game.Organiser.UserId;
        var penalty = (int)Math.Floor(slot.Length * w.Settings.PenaltyPct / 100m);
        switch (game.Fate)
        {
            case GameFate.Completed:
                b.Status = BookingStatus.Completed;
                b.CheckedInAt = (slot.Start + TimeSpan.FromMinutes(w.Rng.Next(-4, 5))).Storable();
                b.LightsOnCuedAt = b.CheckedInAt;
                b.LightsOffCuedAt = slot.End;
                break;
            case GameFate.InPlay:
                b.CheckedInAt = (slot.Start + TimeSpan.FromMinutes(w.Rng.Next(-3, 2))).Storable();
                b.LightsOnCuedAt = b.CheckedInAt;
                break;
            case GameFate.NoShow:
                var swept = (slot.Start + TimeSpan.FromMinutes(w.Settings.GraceWindowMinutes + 1)).Storable();
                b.Status = BookingStatus.NoShow;
                b.EndsAt = swept < slot.End ? swept : slot.End;
                w.Money.Add(new DemoMoney(swept, payer, LedgerEntryType.CancellationRefund, slot.Length, "No-show — booking refunded") { BookingId = b.Id });
                if (penalty > 0)
                {
                    w.Money.Add(new DemoMoney(swept.AddSeconds(1), payer, LedgerEntryType.NoShowPenalty, -penalty,
                        $"No-show penalty ({EmailTemplates.Num(w.Settings.PenaltyPct)}% of {EmailTemplates.Min(slot.Length)})")
                    { BookingId = b.Id });
                }
                break;
            case GameFate.CancelledEarly or GameFate.UpcomingCancelled:
                Cancel(w, game, EarlyCancelAt(w, game, slot), 0);
                break;
            case GameFate.CancelledLate:
                var late = (slot.Start - TimeSpan.FromMinutes(w.Rng.Next(3, Math.Max(4, w.Settings.PenaltyWindowMinutes)))).Storable();
                Cancel(w, game, late < b.CreatedAt ? b.CreatedAt.AddMinutes(1) : late, penalty);
                break;
        }
    }

    private static DateTimeOffset EarlyCancelAt(DemoWorld w, PlannedGame game, Slot slot)
    {
        var latest = slot.Start - TimeSpan.FromMinutes(w.Settings.PenaltyWindowMinutes + 30);
        if (latest > w.Now) latest = w.Now;
        var earliest = game.Booking.CreatedAt.AddMinutes(2);
        if (latest <= earliest) return earliest;
        return (earliest + TimeSpan.FromTicks((long)((latest - earliest).Ticks * w.Rng.NextDouble()))).Storable();
    }

    private static void Cancel(DemoWorld w, PlannedGame game, DateTimeOffset at, int penalty)
    {
        var b = game.Booking;
        b.Status = BookingStatus.Cancelled;
        b.CancelledAt = at;
        var payer = game.Organiser.UserId;
        w.Money.Add(new DemoMoney(at, payer, LedgerEntryType.CancellationRefund, b.AmountChargedMinutes, "Cancellation refund")
        { BookingId = b.Id, ActorUserId = payer });
        if (penalty > 0)
        {
            w.Money.Add(new DemoMoney(at.AddSeconds(1), payer, LedgerEntryType.LateCancellationPenalty, -penalty,
                $"Late-cancellation penalty {MoneyFormat.Number(w.Settings.PenaltyPct)}%")
            { BookingId = b.Id, ActorUserId = payer });
        }
    }

    /// <summary>The booking's club-local start, as every booking's ledger line names it.</summary>
    private static string Local(DemoWorld w, DateTimeOffset start) =>
        TimeZoneInfo.ConvertTime(start, w.Zone).ToString(ClubDate.Format, CultureInfo.InvariantCulture);
}
