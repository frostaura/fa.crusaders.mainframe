using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services.Demo;

public sealed partial class DemoDataGenerator
{
    /// <summary>The results waiting on an answer — the admin's own included — for the inbox step.</summary>
    private readonly List<MatchResult> _pendingResults = [];

    /// <summary>
    /// Scores for most of the singles and doubles that were played, as members record them (D14):
    /// PAR-11, best of five mostly, confirmed by the other side or confirmed by 48 hours of
    /// silence; the last two days' still waiting for the other side to confirm, and the odd one
    /// disputed. Answers how many it wrote.
    /// </summary>
    private int PlanResults(DemoWorld w, List<PlannedGame> games)
    {
        var count = 0;
        var autoConfirm = TimeSpan.FromHours(Math.Max(w.Settings.ResultAutoConfirmHours, 1));
        foreach (var game in games.Where(g => g.Fate == GameFate.Completed))
        {
            var players = game.Partners.Where(p => p.Seat.Status == ParticipantStatus.Accepted).Select(p => p.Person).ToList();
            if (players.Count is not (2 or 4) || !w.Chance(0.62)) continue;

            var submitted = game.Booking.StartsAt + TimeSpan.FromMinutes(game.Booking.AmountChargedMinutes) + w.Between(TimeSpan.FromMinutes(5), TimeSpan.FromHours(6));
            if (submitted > w.Now) submitted = w.Now.AddMinutes(-2);
            var result = NewResult(w, game, players, submitted.Storable());
            Decide(w, result, players, autoConfirm);
            _db.MatchResults.Add(result);
            count++;
        }
        return count;
    }

    private static MatchResult NewResult(DemoWorld w, PlannedGame game, List<DemoPerson> players, DateTimeOffset submitted)
    {
        var bestOf5 = w.Chance(0.8);
        var aWins = SideAWins(w, players);
        var games = Games(w, bestOf5 ? 3 : 2, aWins);
        var result = new MatchResult
        {
            TenantId = w.TenantId,
            BookingId = game.Booking.Id,
            Format = bestOf5 ? MatchFormat.BestOf5 : MatchFormat.BestOf3,
            GamesJson = ResultGames.Write(games),
            GamesWonA = (short)games.Count(g => g.A > g.B),
            GamesWonB = (short)games.Count(g => g.B > g.A),
            WinnerSide = aWins ? MatchSide.A : MatchSide.B,
            SubmittedByUserId = game.Organiser.UserId,
            RecordedByUserId = game.Organiser.UserId,
            SubmittedAt = submitted,
            IdempotencyKey = Guid.NewGuid().ToString("N"),
            CreatedAt = submitted,
            UpdatedAt = submitted,
        };
        var half = players.Count / 2;
        for (var i = 0; i < players.Count; i++)
        {
            result.Players.Add(new MatchResultPlayer
            {
                TenantId = w.TenantId,
                ResultId = result.Id,
                Side = i < half ? MatchSide.A : MatchSide.B,
                Position = (short)(i % half + 1),
                UserId = players[i].UserId,
            });
        }
        return result;
    }

    /// <summary>The stronger appetite wins more often — the club's regulars are its better players.</summary>
    private static bool SideAWins(DemoWorld w, List<DemoPerson> players)
    {
        var half = players.Count / 2;
        var a = players.Take(half).Sum(p => p.Weight);
        var b = players.Skip(half).Sum(p => p.Weight);
        return w.Rng.NextDouble() < 0.5 + Math.Clamp((a - b) / 8, -0.25, 0.25);
    }

    /// <summary>A believable PAR-11 scoreline: the winner takes the last game, ties at ten go two clear.</summary>
    private static List<GameScore> Games(DemoWorld w, int toWin, bool aWins)
    {
        var lost = w.Rng.Next(0, toWin);
        var order = Enumerable.Repeat(true, toWin - 1).Concat(Enumerable.Repeat(false, lost)).OrderBy(_ => w.Rng.Next()).Append(true).ToList();
        var scores = new List<GameScore>();
        foreach (var winnerTook in order)
        {
            var close = w.Chance(0.15);
            var (won, other) = close ? (12 + w.Rng.Next(0, 3) * 1, 0) : (11, w.Rng.Next(2, 10));
            if (close) other = won - 2;
            var aTook = winnerTook == aWins;
            scores.Add(aTook ? new GameScore(won, other) : new GameScore(other, won));
        }
        return scores;
    }

    /// <summary>Confirmed by the other side, by silence, still waiting, or (rarely) disputed.</summary>
    private void Decide(DemoWorld w, MatchResult r, List<DemoPerson> players, TimeSpan autoConfirm)
    {
        var opponent = players[^1].UserId;
        r.ConfirmDueAt = r.SubmittedAt + autoConfirm;
        if (r.ConfirmDueAt > w.Now)
        {
            r.Status = MatchResultStatus.Pending;
            _pendingResults.Add(r);
            return;
        }
        if (w.Chance(0.03))
        {
            r.Status = MatchResultStatus.Disputed;
            r.DisputedAt = (r.SubmittedAt + w.Between(TimeSpan.FromHours(1), TimeSpan.FromHours(20))).Storable();
            r.DisputedByUserId = opponent;
            r.DisputeNote = "I think the third game was 11–9 to me.";
            return;
        }
        r.Status = MatchResultStatus.Confirmed;
        var bySilence = w.Chance(0.3);
        r.AutoConfirmed = bySilence;
        r.ConfirmedByUserId = bySilence ? null : opponent;
        r.ConfirmedAt = (bySilence ? r.ConfirmDueAt.Value : r.SubmittedAt + w.Between(TimeSpan.FromMinutes(10), TimeSpan.FromHours(30))).Storable();
    }
}
