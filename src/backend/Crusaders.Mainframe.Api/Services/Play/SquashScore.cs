using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>One game as recorded: side a's points, side b's points.</summary>
public readonly record struct GameScore(int A, int B);

/// <summary>
/// The verdict on a recorded match: either a complete, legal match (<see cref="Ok"/> with the games
/// each side won and the winner) or the first rule it breaks, with the figures the wire carries.
/// </summary>
public sealed record MatchVerdict(
    bool Ok, string? Error = null, int? GameIndex = null, string? Reason = null, int? GamesNeeded = null,
    int WonA = 0, int WonB = 0)
{
    public string? Winner => !Ok ? null : WonA > WonB ? MatchSide.A : MatchSide.B;
}

/// <summary>
/// Point-a-rally to 11 (PAR-11), best of 3 or best of 5 — <c>docs/specs/play.md</c> §4, and the
/// vectors in <c>src/contracts/play/squash-scores.json</c>, which the PWA's live validation reads
/// too, so the two agree to the reason.
/// </summary>
public static class SquashScore
{
    public const string FormatInvalid = "format_invalid";
    public const string ScoreInvalid = "score_invalid";
    public const string MatchIncomplete = "match_incomplete";
    public const string GamesAfterDecided = "games_after_decided";

    public const string Negative = "negative";
    public const string TooHigh = "too_high";
    public const string Tied = "tied";
    public const string BelowEleven = "below_eleven";
    public const string NotTwoClear = "not_two_clear";
    public const string Overrun = "overrun";

    /// <summary>A sanity bound on a game's winning score; a real tie-break never approaches it.</summary>
    public const int MaxPoints = 99;

    /// <summary>Games a side needs to win the match, or null for a format that is not one of ours.</summary>
    public static int? GamesNeeded(string? format)
    {
        // Block body: lizard mis-scopes an expression-bodied switch (memory/gotchas-build.md).
        return format switch
        {
            MatchFormat.BestOf3 => 2,
            MatchFormat.BestOf5 => 3,
            _ => null,
        };
    }

    /// <summary>
    /// The first rule of §4.1 a game breaks, in the table's order, or null for a legal game.
    /// Past 11 a game ends the moment the lead is two, so 13–10 is an overrun, not a win.
    /// </summary>
    public static string? GameReason(GameScore game)
    {
        if (game.A < 0 || game.B < 0) return Negative;
        var w = Math.Max(game.A, game.B);
        var l = Math.Min(game.A, game.B);
        if (w > MaxPoints) return TooHigh;
        if (w == l) return Tied;
        if (w < 11) return BelowEleven;
        if (w - l < 2) return NotTwoClear;
        if (w != 11 && w - l != 2) return Overrun;
        return null;
    }

    /// <summary>
    /// Walks the games in order (§4.2): the format first; then, for each game, whether the match was
    /// already decided and only then its score; and at the end whether it was decided at all.
    /// </summary>
    public static MatchVerdict Validate(string? format, IReadOnlyList<GameScore> games)
    {
        if (GamesNeeded(format) is not { } needed) return new MatchVerdict(false, FormatInvalid);

        int wonA = 0, wonB = 0;
        for (var i = 0; i < games.Count; i++)
        {
            if (wonA == needed || wonB == needed) return new MatchVerdict(false, GamesAfterDecided, GameIndex: i);
            if (GameReason(games[i]) is { } reason) return new MatchVerdict(false, ScoreInvalid, GameIndex: i, Reason: reason);
            if (games[i].A > games[i].B) wonA++;
            else wonB++;
        }

        return wonA == needed || wonB == needed
            ? new MatchVerdict(true, WonA: wonA, WonB: wonB)
            : new MatchVerdict(false, MatchIncomplete, GamesNeeded: needed);
    }
}
