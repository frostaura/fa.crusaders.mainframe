namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// Account mail added in the backend-platform pass (2026-11-13): the answers registration now
/// gives by mail instead of on the screen (BP-14), a passkey added or removed (BP-10), a PIN the
/// desk set (BP-11), and a new club's first administrator (BP-07).
/// </summary>
public static partial class EmailTemplates
{
    private const string WhyApplication =
        "You're getting this because somebody used this address to apply for membership at the club. "
        + "If that wasn't you, there's nothing to do and no account was changed.";

    /// <summary>
    /// Somebody applied with an address that already holds an account here (BP-14). The screen
    /// they saw said what it says to everybody — check your email — so whether an address is
    /// registered is told only to whoever reads its mailbox.
    /// </summary>
    public static EmailMessage RegistrationForExistingAccount(ClubIdentity club, string to, string forgotPasswordUrl) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "You already have an account",
            Preheader: "Sign in instead, or choose a new password if you have forgotten it.",
            Heading: "You already have an account",
            Blocks:
            [
                new Paragraph($"Somebody just tried to join {club.Name} with this email address, and this address already has an account at the club. Nothing about the account has changed."),
                new Paragraph("If it was you, sign in with your email address and password. If you have forgotten the password, choose a new one here:"),
                new CallToAction("Choose a new password", forgotPasswordUrl),
                new Callout(CalloutTone.Warning, "If it wasn't you, you don't need to do anything, but choosing a new password is the safe thing to do if you think somebody knows yours."),
            ],
            WhyThis: WhyApplication));

    /// <summary>
    /// The membership number on an application is already registered to somebody else (BP-14).
    /// Told to the applicant's own mailbox rather than on the screen: an answer on the screen told
    /// any stranger which numbers the club has issued.
    /// </summary>
    public static EmailMessage RegistrationNumberTaken(ClubIdentity club, string to, string membershipNumber) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "We couldn't take your application",
            Preheader: "That membership number is already registered at the club.",
            Heading: "That membership number is already registered",
            Blocks:
            [
                new Paragraph($"Thanks for applying to join {club.Name}. The membership number you gave is already registered to another account, so no application was made."),
                new Facts([new FactRow("Membership number you gave", membershipNumber)]),
                new Paragraph("Check the number on your membership card and apply again. If it is right, speak to the club: they can tell you which account holds it."),
            ],
            WhyThis: WhyApplication));

    /// <summary>A passkey was added to the account (BP-10). The signal a hijacked account's owner needs.</summary>
    public static EmailMessage PasskeyAdded(ClubIdentity club, string to, string label) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "A passkey was added to your account",
            Preheader: "If that was you, there is nothing to do.",
            Heading: "A passkey was added",
            Blocks:
            [
                new Paragraph($"A passkey was added to your {club.Name} account a moment ago. It signs in without your password."),
                new Facts([new FactRow("Passkey name", label)]),
                new Callout(CalloutTone.Danger, "If it wasn't you, somebody else can sign in as you. Remove the passkey from your profile, choose a new password, and contact the club committee straight away."),
            ],
            WhyThis: WhyAccount));

    /// <summary>A passkey was removed from the account (BP-10).</summary>
    public static EmailMessage PasskeyRemoved(ClubIdentity club, string to, string label) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "A passkey was removed from your account",
            Preheader: "If that was you, there is nothing to do.",
            Heading: "A passkey was removed",
            Blocks:
            [
                new Paragraph($"A passkey was removed from your {club.Name} account a moment ago, so it no longer signs in."),
                new Facts([new FactRow("Passkey name", label)]),
                new Callout(CalloutTone.Danger, "If it wasn't you, somebody else is signed in as you. Choose a new password and contact the club committee straight away."),
            ],
            WhyThis: WhyAccount));

    /// <summary>
    /// The desk set the member's court PIN (BP-11). The PIN itself is never in the mail: the member
    /// was given it in person, and a mailbox is not where a credential that spends minutes belongs.
    /// </summary>
    public static EmailMessage PinSetByClub(ClubIdentity club, string to, string fullName) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "The club set your court PIN",
            Preheader: "Your PIN at the court was changed by the club.",
            Heading: "Your court PIN was set",
            Blocks:
            [
                new Paragraph($"Hello {fullName}. Somebody at {club.Name} set the PIN you can use at the court instead of your phone. Any PIN you had before no longer works."),
                new Paragraph("You can change it yourself at any time from your profile in the app."),
                new Callout(CalloutTone.Danger, "If you didn't ask the club for this, contact the club committee straight away: a PIN can start a court on your minutes."),
            ],
            WhyThis: WhyAccount));

    /// <summary>
    /// A new club's first administrator, created by the operator (BP-07). The link sets their
    /// password and proves the address in one step; nobody else ever knew a password for it.
    /// </summary>
    public static EmailMessage ClubReady(ClubIdentity club, string to, string setPasswordUrl, int linkHours) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"{club.Name} is ready for you",
            Preheader: "Choose your password to open the club's admin console.",
            Heading: "Your club is ready",
            Blocks:
            [
                new Paragraph($"{club.Name} has been set up and you are its first administrator. Choose a password to sign in and finish setting the club up: its courts, opening hours, minute packages and payments."),
                new CallToAction("Choose my password", setPasswordUrl),
                new Callout(CalloutTone.Warning, $"The link works once and lasts {linkHours} hours. If it has expired, use \"Forgot password\" on the sign-in page with this address."),
            ],
            WhyThis: "You're getting this because the operator of this booking service set this address up as the club's first administrator."));
}
