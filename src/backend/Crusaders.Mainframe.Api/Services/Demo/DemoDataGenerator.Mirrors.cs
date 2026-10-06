namespace Crusaders.Mainframe.Api.Services.Demo;

public sealed partial class DemoDataGenerator
{
    /// <summary>
    /// The admin's own corner of the demo, so the member screens have something to show them: three
    /// invites waiting on their Invites tab, and two games of their own ahead — one a single with a
    /// partner, one a doubles with seats still answering.
    /// </summary>
    private void PlanForMirrors(DemoWorld w, List<PlannedGame> games)
    {
        foreach (var mirror in w.Players.Where(p => p.IsMirror).ToList())
        {
            var friends = mirror.Friends.Count >= 4 ? mirror.Friends : w.Players.Where(p => p != mirror).ToList();
            for (var i = 0; i < 3; i++)
            {
                var organiser = w.Pick(friends);
                var others = i == 2 ? friends.Where(f => f != organiser).Take(2).ToList() : [];
                if (FindSlot(w, 1 + i * 2, [organiser, mirror, .. others]) is { } slot)
                {
                    games.Add(PlanGame(w, slot, organiser, [mirror, .. others], GameFate.Upcoming, mirrorInvited: true));
                }
            }

            var single = friends.Take(1).ToList();
            if (FindSlot(w, 2, [mirror, .. single]) is { } own) games.Add(PlanGame(w, own, mirror, single, GameFate.Upcoming));
            var doubles = friends.Skip(1).Take(3).ToList();
            if (FindSlot(w, 5, [mirror, .. doubles]) is { } four) games.Add(PlanGame(w, four, mirror, doubles, GameFate.Upcoming));
        }
    }

    /// <summary>The first evening slot from <paramref name="fromDay"/> days ahead where a court and everybody named are free.</summary>
    private static Slot? FindSlot(DemoWorld w, int fromDay, List<DemoPerson> people)
    {
        var length = PickLength(w, Math.Max(w.Settings.SliceMinutes, 1));
        var ahead = Math.Max(w.Settings.AdvanceBookingDays, 1);
        for (var d = fromDay; d <= Math.Min(fromDay + 6, ahead); d++)
        {
            var day = w.Today.AddDays(d);
            if (OpenHours(w, day) is not { } hours) continue;
            for (var minute = Math.Max(hours.Open, 17 * 60); minute + length <= hours.Close; minute += 30)
            {
                var start = w.At(day, minute);
                var end = start + TimeSpan.FromMinutes(length);
                if (people.Any(p => !p.IsFree(day, start, end) || p.OrganisedOn.Contains(day) && p == people[0])) continue;
                var court = w.Courts.FirstOrDefault(c => w.CourtFree(c.Id, start, end));
                if (court is not null) return new Slot(court, day, minute, length, start, end);
            }
        }
        return null;
    }
}
