using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The words of a result-to-confirm ask — its mail facts and its inbox headline. Its own file:
/// beside the rest of <see cref="PlayNotices"/> lizard read the class as a file-long *global*
/// (memory/gotchas-gates.md: split the file).
/// </summary>
public static partial class PlayNotices
{
    /// <summary>
    /// The facts a <see cref="MemberEventCatalogue.ResultToConfirm"/> mail states, from the result as
    /// it is NOW — at staging, and again when a held mail is released (C8), so a mail never shows a
    /// score that was edited, withdrawn or re-recorded while it waited.
    /// </summary>
    public static ResultToConfirmPayload ToConfirmPayload(MatchResult r, ResultContext c)
    {
        var line = $"{SideNames(r, MatchSide.A, c)} {r.GamesWonA}–{r.GamesWonB} {SideNames(r, MatchSide.B, c)}";
        var due = Local(r.ConfirmDueAt ?? r.SubmittedAt, c.Settings);
        return new ResultToConfirmPayload(r.BookingId, c.NameOf(r.SubmittedByUserId), c.CourtName, c.When, $"{line} ({GamesText(r)})", due);
    }

    /// <summary>
    /// The ask, spoken TO the reader (review round 2, F2-5): "Sam says they won 3–0 — confirm or
    /// dispute", or "Sam says you won 3–1 — …" when the recorder's side lost. The reader is always
    /// "you", never their own name in the third person; their doubles partner rides with them
    /// ("you and Lee won"), the recorder's with the recorder ("Cara and Jo say they won"). The
    /// score is the winner's first. Round 1's "Cara recorded a 3–1 win over Bongani" read as a
    /// notice about somebody else to the very person it was asking.
    /// </summary>
    public static string ToConfirmHeadline(MatchResult r, ResultContext c, Guid reader)
    {
        var mine = SubmittingSide(r);
        var (won, lost) = mine == MatchSide.A ? (r.GamesWonA, r.GamesWonB) : (r.GamesWonB, r.GamesWonA);
        var recorder = r.Players.Where(p => p.UserId == r.SubmittedByUserId)
            .Concat(r.Players.Where(p => p.Side == mine && p.UserId != r.SubmittedByUserId).OrderBy(p => p.Position));
        var speakers = r.Players.Any(p => p.UserId == r.SubmittedByUserId) ? FirstNames(recorder, c) : FirstName(c.NameOf(r.SubmittedByUserId));
        var says = speakers.Contains(" and ", StringComparison.Ordinal) ? "say" : "says";
        var withReader = FirstNames(r.Players.Where(p => p.Side != mine && p.UserId != reader).OrderBy(p => p.Position), c);
        var you = withReader.Length > 0 ? $"you and {withReader}" : "you";
        var winners = won >= lost ? "they" : you;
        var (high, low) = won >= lost ? (won, lost) : (lost, won);
        return $"{speakers} {says} {winners} won {high}–{low} — confirm or dispute";
    }

    private static string FirstNames(IEnumerable<MatchResultPlayer> players, ResultContext c) =>
        string.Join(" and ", players.Select(p => p.UserId is { } u ? FirstName(c.NameOf(u)) : p.GuestName ?? "Guest"));

    private static string FirstName(string fullName)
    {
        var trimmed = fullName.Trim();
        var space = trimmed.IndexOf(' ');
        return space < 0 ? trimmed : trimmed[..space];
    }
}
