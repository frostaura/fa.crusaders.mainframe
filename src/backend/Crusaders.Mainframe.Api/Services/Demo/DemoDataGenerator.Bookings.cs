using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services.Demo;

public sealed partial class DemoDataGenerator
{
    /// <summary>How a planned game ends — or, for one still ahead, where it stands.</summary>
    internal enum GameFate
    {
        Completed,
        NoShow,
        CancelledEarly,
        CancelledLate,
        InPlay,
        Upcoming,
        UpcomingCancelled,
    }

    /// <summary>A game the generator has planned: its booking, who organised it and who was asked.</summary>
    internal sealed class PlannedGame
    {
        public required Booking Booking { get; init; }
        public required DemoPerson Organiser { get; init; }
        public required GameFate Fate { get; init; }
        public required string CourtName { get; init; }
        public List<(DemoPerson Person, BookingParticipant Seat)> Partners { get; } = [];
    }

    /// <summary>One slot on one court on one day.</summary>
    internal readonly record struct Slot(Court Court, DateOnly Day, int Minute, int Length, DateTimeOffset Start, DateTimeOffset End);

    /// <summary>
    /// Walks every court of every day from <see cref="DemoSeed.HistoryDays"/> ago to
    /// <see cref="DemoSeed.AheadDays"/> ahead, inside the club's opening hours, filling slots at the
    /// occupancy a squash club actually sees: quiet mid-mornings, busy lunchtimes, packed evenings,
    /// busy weekend mornings — and, ahead of today, thinning out the further away the day is,
    /// because people book closer to the day.
    /// </summary>
    private List<PlannedGame> PlanBookings(DemoWorld w, DemoSeed seed)
    {
        var games = new List<PlannedGame>();
        var ahead = Math.Min(seed.AheadDays, Math.Max(w.Settings.AdvanceBookingDays, 1));
        for (var d = -seed.HistoryDays; d <= ahead; d++)
        {
            var day = w.Today.AddDays(d);
            if (OpenHours(w, day) is not { } hours) continue;
            foreach (var court in w.Courts) PlanCourtDay(w, games, court, day, hours);
        }
        PlanForMirrors(w, games);
        return games;
    }

    private void PlanCourtDay(DemoWorld w, List<PlannedGame> games, Court court, DateOnly day, (int Open, int Close) hours)
    {
        var slice = Math.Max(w.Settings.SliceMinutes, 1);
        var minute = hours.Open;
        while (minute < hours.Close)
        {
            var length = PickLength(w, slice);
            if (minute + length > hours.Close) break;
            var slot = new Slot(court, day, minute, length, w.At(day, minute), w.At(day, minute) + TimeSpan.FromMinutes(length));
            if (w.CourtFree(court.Id, slot.Start, slot.End) && w.Chance(Occupancy(day, minute) * Lead(w, slot))
                && TryPlanGame(w, slot) is { } game)
            {
                games.Add(game);
                minute += length;
                continue;
            }
            minute += slice * w.Rng.Next(1, 4);
        }
    }

    /// <summary>The club's hours on a day, from its settings; the club's day bounds when it names none.</summary>
    private static (int Open, int Close)? OpenHours(DemoWorld w, DateOnly day)
    {
        if (w.Settings.OperatingHours.IsEmpty) return (Math.Max(w.Settings.DayStartMinute, 6 * 60), Math.Min(w.Settings.DayEndMinute, 22 * 60));
        return w.Settings.OperatingHours.For(day.DayOfWeek) is { } h && h.CloseMinute > h.OpenMinute ? (h.OpenMinute, h.CloseMinute) : null;
    }

    /// <summary>Thirty, forty-five or sixty minutes — never past the club's per-day cap, always whole slices.</summary>
    private static int PickLength(DemoWorld w, int slice)
    {
        var roll = w.Rng.NextDouble();
        var wanted = roll < 0.2 ? 30 : roll < 0.45 ? 45 : 60;
        var cap = w.Settings.MemberPerDayMaxMinutes > 0 ? w.Settings.MemberPerDayMaxMinutes : 60;
        var length = Math.Min(wanted, cap) / slice * slice;
        return Math.Max(length, slice);
    }

    /// <summary>How likely a free slot is taken, by weekday and time of day.</summary>
    private static double Occupancy(DateOnly day, int minute)
    {
        var hour = minute / 60.0;
        var weekend = day.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday;
        if (weekend) return hour < 9 ? 0.35 : hour < 13 ? 0.7 : hour < 16 ? 0.4 : hour < 19 ? 0.3 : 0.12;
        if (hour < 7) return 0.3;
        if (hour < 9) return 0.4;
        if (hour < 12) return 0.12;
        if (hour < 14) return 0.32;
        if (hour < 16.5) return 0.15;
        if (hour < 17.5) return 0.55;
        return hour < 20 ? 0.88 : 0.42;
    }

    /// <summary>The past is as full as it was; ahead of now, the further the day the fewer have booked yet.</summary>
    private static double Lead(DemoWorld w, Slot slot)
    {
        if (slot.Start <= w.Now) return 1;
        var days = slot.Day.DayNumber - w.Today.DayNumber;
        return days switch { 0 => 0.95, <= 2 => 0.85, <= 6 => 0.55, <= 10 => 0.3, _ => 0.16 };
    }

    /// <summary>A game in this slot, if anybody who plays then is free; null when nobody is.</summary>
    private PlannedGame? TryPlanGame(DemoWorld w, Slot slot)
    {
        var organiser = PickOrganiser(w, slot);
        if (organiser is null) return null;
        var fate = FateFor(w, slot);
        var wanted = fate is GameFate.NoShow or GameFate.CancelledLate ? 0 : w.Rng.NextDouble() switch { < 0.3 => 0, < 0.88 => 1, _ => 3 };
        var partners = PickPartners(w, organiser, slot, wanted);
        return PlanGame(w, slot, organiser, partners, fate);
    }

    private static DemoPerson? PickOrganiser(DemoWorld w, Slot slot)
    {
        var early = slot.Minute < 9 * 60;
        var eligible = w.Players
            .Where(p => p.JoinedAt < slot.Start.AddDays(-1) && !p.OrganisedOn.Contains(slot.Day) && p.IsFree(slot.Day, slot.Start, slot.End))
            .Select(p => (Person: p, Weight: p.Weight * (early ? (p.EarlyBird ? 3 : 0.3) : (p.EarlyBird ? 0.6 : 1))))
            .ToList();
        var total = eligible.Sum(e => e.Weight);
        if (total <= 0) return null;
        var roll = w.Rng.NextDouble() * total;
        foreach (var (person, weight) in eligible)
        {
            roll -= weight;
            if (roll <= 0) return person;
        }
        return eligible[^1].Person;
    }

    private static List<DemoPerson> PickPartners(DemoWorld w, DemoPerson organiser, Slot slot, int wanted)
    {
        var pool = organiser.Friends.Count > 0 && w.Chance(0.85) ? organiser.Friends : w.Players;
        return pool
            .Where(p => p != organiser && p.JoinedAt < slot.Start && p.IsFree(slot.Day, slot.Start, slot.End))
            .OrderBy(_ => w.Rng.Next())
            .Take(wanted)
            .ToList();
    }

    private static GameFate FateFor(DemoWorld w, Slot slot)
    {
        var roll = w.Rng.NextDouble();
        if (slot.End <= w.Now)
        {
            return roll switch { < 0.83 => GameFate.Completed, < 0.87 => GameFate.NoShow, < 0.965 => GameFate.CancelledEarly, _ => GameFate.CancelledLate };
        }
        if (slot.Start <= w.Now) return GameFate.InPlay;
        return roll < 0.06 ? GameFate.UpcomingCancelled : GameFate.Upcoming;
    }
}
