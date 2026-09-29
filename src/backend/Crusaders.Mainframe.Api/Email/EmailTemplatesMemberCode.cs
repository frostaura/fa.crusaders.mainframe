namespace Crusaders.Mainframe.Api.Email;

/// <summary>The desk's code reset, told to the member it happened to (review round 1, B6).</summary>
public static partial class EmailTemplates
{
    /// <summary>
    /// The club reset the member's code: every code their phone could show is dead, every session
    /// they had open has ended, and (unless the desk kept them) their passkeys are gone. Sent
    /// because it is the member's access that changed — and if they did not ask for it, this mail
    /// is how they find out somebody did.
    /// </summary>
    public static EmailMessage MemberCodeReset(ClubIdentity club, string to, string fullName, string reason, bool passkeysRemoved) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "The club reset your member code",
            Preheader: "Sign in again on your phone to get your new code.",
            Heading: "Your member code was reset",
            Blocks:
            [
                new Paragraph($"Hello {fullName}. The desk at {club.Name} reset your member code. The code your phone showed before no longer opens anything, and you have been signed out everywhere."),
                new Facts([new FactRow("Reason the club gave", reason)]),
                new Paragraph(passkeysRemoved
                    ? "Your passkeys were removed too. Sign in again with your password, then set up a passkey on the phone you use now."
                    : "Sign in again on your phone and it will show your new code."),
                new Callout(CalloutTone.Danger, "If you did not ask the club for this, contact the club committee straight away."),
            ],
            WhyThis: WhyAccount));
}
