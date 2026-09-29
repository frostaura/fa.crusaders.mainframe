namespace Crusaders.Mainframe.Api.Email;

/// <summary>A match result the reader's side is asked to confirm (D14, <c>docs/specs/play.md</c> §8).</summary>
/// <param name="ScoreLine">The lineup and score, games in brackets — <c>Jo Botha 3–1 Sam Naidoo (11–7, 9–11, 11–5, 11–8)</c>.</param>
/// <param name="ResultUrl">The booking, opened on its confirm sheet. Signed in; no token in the mail.</param>
public sealed record ResultToConfirmNotice(
    string SubmitterName, string CourtName, string WhenLocal, string ScoreLine, string ConfirmDueLocal, string ResultUrl);

/// <summary>
/// The one mail play sends (D14): a result to confirm. The only play event that asks the member to
/// do something by a deadline — everything else about a result is an inbox line, because a result
/// moves no money and no access, and a mail per answer is how a member learns to ignore the club.
/// </summary>
/// <remarks>
/// A partial of <see cref="EmailTemplates"/> for the length reason the players partial gives. No
/// figure here is money and none may become one.
/// </remarks>
public static partial class EmailTemplates
{
    private const string WhyResult =
        "You're getting this because a member of the club recorded a match you played in.";

    /// <summary>A result recorded by the other side, waiting for the reader's side to confirm or dispute it.</summary>
    public static EmailMessage ResultToConfirm(ClubIdentity club, string to, ResultToConfirmNotice n) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Is this result right? {n.WhenLocal} on {n.CourtName}",
            Preheader: n.ScoreLine,
            Heading: "Is this result right?",
            Blocks:
            [
                new Paragraph($"{n.SubmitterName} recorded your match on {n.CourtName}, {n.WhenLocal}:"),
                new Paragraph(n.ScoreLine),
                new Paragraph("If it's right, confirm it. If it isn't, say so and the club will look at it."),
                new CallToAction("Check the result", n.ResultUrl),
                new Footnote($"It will be confirmed automatically on {n.ConfirmDueLocal} if nobody answers."),
            ],
            WhyThis: WhyResult));
}
