using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// PAR-11 scoring (<c>docs/specs/play.md</c> §4) against the shared corpus
/// <c>src/contracts/play/squash-scores.json</c> — the file the PWA's <c>playScore.test.ts</c> reads
/// too, so the sheet's live validation and the server agree to the reason — plus a generated sweep
/// of every game 0–30 against an oracle written separately from <see cref="SquashScore"/>.
/// </summary>
public sealed class SquashScoreTests
{
    private static JsonElement Corpus()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "src", "contracts", "play", "squash-scores.json");
            if (File.Exists(candidate)) return JsonDocument.Parse(File.ReadAllText(candidate)).RootElement.Clone();
            dir = dir.Parent;
        }
        throw new InvalidOperationException("src/contracts/play/squash-scores.json was not found above the test binary.");
    }

    public static IEnumerable<object[]> Cases() =>
        Corpus().GetProperty("vectors").EnumerateArray().Select(c => new object[] { c.GetProperty("id").GetInt32() });

    [Fact]
    public void The_corpus_carries_the_twenty_two_vectors_of_the_spec()
    {
        var ids = Corpus().GetProperty("vectors").EnumerateArray().Select(c => c.GetProperty("id").GetInt32()).ToList();
        Assert.Equal(Enumerable.Range(1, 22), ids);
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Every_vector_in_the_shared_corpus_agrees_to_the_reason(int id)
    {
        var c = Corpus().GetProperty("vectors").EnumerateArray().Single(x => x.GetProperty("id").GetInt32() == id);
        var games = c.GetProperty("games").EnumerateArray()
            .Select(g => new GameScore(g.GetProperty("a").GetInt32(), g.GetProperty("b").GetInt32())).ToList();
        var verdict = SquashScore.Validate(c.GetProperty("format").GetString(), games);
        var expected = c.GetProperty("expected");

        Assert.Equal(expected.GetProperty("ok").GetBoolean(), verdict.Ok);
        if (verdict.Ok)
        {
            Assert.Equal(expected.GetProperty("winner").GetString(), verdict.Winner);
            Assert.Equal(expected.GetProperty("games_won").GetProperty("a").GetInt32(), verdict.WonA);
            Assert.Equal(expected.GetProperty("games_won").GetProperty("b").GetInt32(), verdict.WonB);
            return;
        }
        Assert.Equal(expected.GetProperty("error").GetString(), verdict.Error);
        Assert.Equal(Optional(expected, "game_index"), verdict.GameIndex);
        Assert.Equal(expected.TryGetProperty("reason", out var r) ? r.GetString() : null, verdict.Reason);
        Assert.Equal(Optional(expected, "games_needed"), verdict.GamesNeeded);
    }

    private static int? Optional(JsonElement e, string name) => e.TryGetProperty(name, out var v) ? v.GetInt32() : null;

    /// <summary>
    /// An independent statement of PAR-11, sharing no arithmetic with the rule table it checks: a
    /// game ends the first moment one side has 11 or more and leads by two, so a final score is
    /// legal exactly when it is decided and the score one point earlier (the winner's last point
    /// taken back) was not.
    /// </summary>
    private static bool OracleLegal(int a, int b)
    {
        if (a < 0 || b < 0 || Math.Max(a, b) > SquashScore.MaxPoints) return false;
        var (w, l) = (Math.Max(a, b), Math.Min(a, b));
        return Decided(w, l) && !Decided(w - 1, l);
    }

    private static bool Decided(int x, int y) => (x >= 11 || y >= 11) && Math.Abs(x - y) >= 2;

    [Fact]
    public void Every_game_from_nil_nil_to_thirty_thirty_agrees_with_an_independent_oracle()
    {
        for (var a = 0; a <= 30; a++)
        {
            for (var b = 0; b <= 30; b++)
            {
                var legal = SquashScore.GameReason(new GameScore(a, b)) is null;
                Assert.True(OracleLegal(a, b) == legal, $"{a}–{b}: oracle {OracleLegal(a, b)}, SquashScore {legal}");
            }
        }
    }

    [Fact]
    public void A_best_of_five_needs_three_and_a_best_of_three_two()
    {
        Assert.Equal(3, SquashScore.GamesNeeded(MatchFormat.BestOf5));
        Assert.Equal(2, SquashScore.GamesNeeded(MatchFormat.BestOf3));
        Assert.Null(SquashScore.GamesNeeded("best_of_7"));
        Assert.Null(SquashScore.GamesNeeded(null));
    }
}
