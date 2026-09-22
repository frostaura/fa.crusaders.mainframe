using System.Globalization;

namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// Every message the product sends, as blocks rather than as markup.
/// </summary>
/// <remarks>
/// <para>
/// Not one template here writes HTML. Each says what the message is <i>about</i> — a heading,
/// some sentences, the figures, the one thing that must not be skimmed past, the action — and
/// <see cref="EmailChrome"/> renders that twice, as the club's HTML and as text. Three
/// properties fall out of it that were not true of the markup these replaced: the two bodies
/// cannot disagree, every interpolated value is escaped exactly once, and a template cannot
/// forget the club's identity because it never had the chance to write a footer.
/// </para>
/// <para>
/// Templates take primitives and small records only, never domain types, so they stay
/// trivially testable; and every one of them takes a <see cref="ClubIdentity"/> first, because
/// a message with no club is a message signed by a piece of software.
/// </para>
/// </remarks>
public sealed record BookingConfirmationDetails(
    string CourtName,
    string StartsAtLocal,
    string Duration,
    decimal AmountCredits,
    decimal BalanceAfterCredits,
    int PenaltyWindowMinutes,
    decimal PenaltyPct,
    bool IsWalkUp = false);

/// <summary>
/// The two things a member needs when the <b>club</b> cancelled their booking rather than they
/// themselves — who did it and why.
/// </summary>
/// <remarks>
/// An admin cancellation used to reach the member as a mail indistinguishable from one they
/// sent themselves. No actor, no reason, and no mention that the penalty had been waived on
/// their behalf — while the audit row beside it carried all three. Email is the only channel
/// the member has; the schedule grid just shows the slot free again.
/// </remarks>
/// <param name="Reason">The reason the admin typed, or null when they gave none.</param>
/// <param name="PenaltyWaived">True when the club waived a penalty this cancellation would otherwise have carried.</param>
public sealed record ClubCancellation(string? Reason, bool PenaltyWaived);

/// <summary>
/// What a top-up confirmation states. A record rather than five more parameters: with the club
/// and the recipient it would be seven, past the complexity gate's six, and every one of the
/// five is a decimal or a string that would transpose silently.
/// </summary>
public sealed record TopUpReceipt(
    decimal AmountZar,
    decimal CreditsAdded,
    decimal ConversionRate,
    decimal BalanceAfterCredits,
    string Reference);

/// <summary>
/// A court box, for the two alerts about one. The club is no longer a field here: it arrives
/// as the <see cref="ClubIdentity"/> every template takes, and two places to read a club's name
/// from is how one of them ends up stale.
/// </summary>
/// <param name="Minutes">Silent-for, on the alert; outage length, on the all-clear.</param>
public sealed record PeripheralAlert(
    string DeviceName,
    string DeviceCode,
    IReadOnlyList<int> CourtNumbers,
    int Minutes,
    string ConsoleUrl);

/// <summary>
/// The same incident on a door gate, which is a different message rather than the same one with
/// a word changed.
/// </summary>
/// <remarks>
/// It carries <see cref="GateKey"/> — the door's own name — and no court list, because a gate
/// drives none. Everything the court-box alert says about attendance, refunds and no-show
/// penalties is false about a door, so the two templates share no sentences and this record
/// deliberately cannot be passed to the court box's.
/// </remarks>
public sealed record GateAlert(
    string DeviceName,
    string DeviceCode,
    string? GateKey,
    int Minutes,
    string ConsoleUrl);

public static class EmailTemplates
{
    // ---- units ----

    /// <summary>
    /// Credits, for an email.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Every money email once printed a rand sign over a credit figure — "Charged R50,00" for a
    /// court that cost the member R31.25 at the club's own 1.6 rate — which is the unit lie
    /// <c>CLAUDE.md</c> forbids, on the one artifact a member reconciles a bank statement
    /// against. Credits are the unit of account; rand appears in exactly two templates, the two
    /// about a top-up, because that is the only place a member actually paid rand.
    /// </para>
    /// <para>
    /// Invariant culture, so the separator is a dot on every host. It was the server process's
    /// ambient culture, which is how "−15.00 cr" and "penalty 30,0%" ended up in the same row
    /// of one member's ledger.
    /// </para>
    /// </remarks>
    internal static string Cr(decimal value) => value.ToString("0.00", CultureInfo.InvariantCulture) + " credits";

    /// <summary>Rand. Only for amounts that really are rand — what the member paid the gateway.</summary>
    internal static string Zar(decimal value) => "R" + value.ToString("0.00", CultureInfo.InvariantCulture);

    /// <summary>A number with no trailing-zero noise, for percentages and rates. Invariant, as above.</summary>
    internal static string Num(decimal value) => value.ToString("0.####", CultureInfo.InvariantCulture);

    // ---- the reasons a person is holding one of these ----
    //
    // Every message carries one. A transactional mail that explains nothing about itself is
    // indistinguishable from a phishing attempt, which is the failure that matters on the
    // three that carry a sign-in link or a password. There is no unsubscribe: a club cannot
    // stop telling a member their money moved, and a link pretending otherwise would be a lie.

    private const string WhyAccount =
        "You are getting this because somebody asked for it on your account at the club. "
        + "If that was not you, tell the club straight away.";

    private const string WhyMembership =
        "You are getting this because you have a membership application or a membership at the club.";

    private const string WhyMoney =
        "You are getting this because it is the record of money moving in your club wallet. "
        + "The club emails you every time that happens, so you always have the paper trail.";

    private const string WhyBooking =
        "You are getting this because it is the record of a court booking in your name at the club.";

    private const string WhyAdmin =
        "You are getting this because you are listed as an administrator at the club. "
        + "Only administrators get these.";

    // ---- getting in ----

    /// <summary>
    /// <b>The one email a new applicant gets, and it used to be two.</b>
    /// </summary>
    /// <remarks>
    /// <para>
    /// Registration sent a "Your membership is pending review" mail and a "Verify your email"
    /// mail in the same second, so the applicant's inbox held two messages while the screen in
    /// front of them said, in step 1, that they had been sent <i>a</i> link, and in step 3 that
    /// the next one would come when they were approved. The approval mail was therefore the
    /// third, the screen's promise was wrong, and for a reader who is not confident with
    /// software a count that does not match is not a detail — it is evidence that something has
    /// gone wrong, and the club hears about it at the desk.
    /// </para>
    /// <para>
    /// <b>The fix is one email, not a corrected screen.</b> The screen was right about what
    /// should happen: one thing to do now, one message later when a human has looked. Two mails
    /// arriving together also split the one instruction that matters — the pending notice had
    /// no link in it at all, so an applicant who opened that one first was told to wait by the
    /// message whose whole job was to tell them to press something. And the sends are not free:
    /// <see cref="SmtpEmailService"/> bounds each at fifteen seconds precisely because a club's
    /// mail provider having a bad day was able to hold a registration request open long enough
    /// for the browser to give up on an account that had already been created.
    /// </para>
    /// <para>
    /// So this message does what the screen says: confirm the address, then the wait, then what
    /// ends it. <c>MembershipPending</c> is gone rather than left unused.
    /// </para>
    /// </remarks>
    public static EmailMessage VerifyEmail(ClubIdentity club, string to, string verifyUrl) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "Verify your email address",
            Preheader: "One thing to do now, then the club checks your membership number by hand.",
            Heading: "Confirm your email address",
            Blocks:
            [
                new Paragraph($"Thanks for applying to join {club.Name}. Confirm this is your address and the club can get on with the rest."),
                new CallToAction("Confirm my email address", verifyUrl),
                new Callout(CalloutTone.Warning, "The link works once, and it stops working after 24 hours."),
                new Paragraph("After that, somebody at the club checks your membership number against their records. That is a person opening a list, so it usually takes a day or two."),
                new Paragraph("You will get one more email when they have done it, and you can book a court from then on. Nothing else is needed from you in the meantime."),
            ],
            WhyThis: "You are getting this because somebody used this address to apply for membership at the club. "
                   + "If that was not you, ignore this email and the application expires on its own."));

    /// <summary>The applicant is in, and the mail is the way in.</summary>
    public static EmailMessage MembershipApproved(ClubIdentity club, string to, string magicLinkUrl) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Welcome to {club.Name} — you can book a court",
            Preheader: "Your membership is approved. The sign-in link below lasts 15 minutes.",
            Heading: "You're in",
            Blocks:
            [
                new Paragraph($"Somebody at {club.Name} has checked your membership number and approved you. You can book a court from now on."),
                new CallToAction("Sign in to the club", magicLinkUrl),
                new Callout(CalloutTone.Warning, "This sign-in link lasts 15 minutes. If it has expired by the time you open it, sign in with your email address and password instead."),
                new Paragraph("Top up your wallet first — court time is bought with credits, and the club converts your rand at your member rate."),
            ],
            WhyThis: WhyMembership));

    /// <summary>The application was refused. The reason is the admin's own words.</summary>
    public static EmailMessage MembershipRejected(ClubIdentity club, string to, string reason) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "Your membership application was not approved",
            Preheader: "The club has given a reason, and there is somebody to talk to about it.",
            Heading: "The club could not approve your application",
            Blocks:
            [
                new Paragraph($"Somebody at {club.Name} has looked at your application and has not approved it."),
                new Callout(CalloutTone.Danger, reason),
                new Paragraph("If that looks like a mistake — a mistyped membership number is the usual one — speak to the club committee and they can sort it out. Your details have not been deleted."),
            ],
            WhyThis: WhyMembership));

    /// <summary>
    /// A membership put on hold. It states what stops working, and what does not.
    /// </summary>
    public static EmailMessage MembershipSuspended(ClubIdentity club, string to, string fullName, string reason) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "Your membership is suspended",
            Preheader: "You cannot book or get on court for now. Your credits are untouched.",
            Heading: $"Hello {fullName}",
            Blocks:
            [
                new Paragraph($"Your membership at {club.Name} has been suspended. You cannot sign in, book a court, or open a court with your fingerprint, PIN or code while it is."),
                new Callout(CalloutTone.Danger, reason),
                new Paragraph("Your credit balance and any bookings you already have are untouched. Speak to the club office to have the suspension lifted."),
            ],
            WhyThis: WhyMembership));

    /// <summary>The hold is off.</summary>
    public static EmailMessage MembershipReactivated(ClubIdentity club, string to, string fullName) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "Your membership is active again",
            Preheader: "You can book and get on court again. Your credits are where you left them.",
            Heading: $"Hello {fullName}",
            Blocks:
            [
                new Paragraph($"Your membership at {club.Name} is active again. You can sign in, book courts, and open a court at the box."),
                new Callout(CalloutTone.Success, "Your credit balance is exactly as you left it. Nothing was taken while you were suspended."),
            ],
            WhyThis: WhyMembership));

    // ---- the desk's own mail ----

    /// <summary>
    /// The club desk's copy of a new registration. Sent to each admin of the tenant, not to the
    /// applicant — the applicant gets <see cref="VerifyEmail"/>.
    /// </summary>
    public static EmailMessage AdminNewRegistration(
        ClubIdentity club, string to, string fullName, string applicantEmail, string membershipNumber, string consoleUrl) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"New membership application — {fullName}",
            Preheader: $"{fullName} has applied and is waiting for somebody to check their number.",
            Heading: "Somebody has applied to join",
            Blocks:
            [
                new Paragraph($"A new application is waiting for approval at {club.Name}. Nobody can book a court until an administrator has looked at it."),
                new Facts(
                [
                    new FactRow("Name", fullName),
                    new FactRow("Email", applicantEmail),
                    new FactRow("Membership number", membershipNumber),
                ]),
                new Paragraph("Check the membership number against the club's own records before approving. The applicant has been told this takes a day or two."),
                new CallToAction("Review the applications", consoleUrl),
            ],
            WhyThis: WhyAdmin));

    // ---- passwords ----

    public static EmailMessage PasswordReset(ClubIdentity club, string to, string resetUrl) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "Reset your password",
            Preheader: "The link below lasts an hour. If you did not ask for it, nothing has changed.",
            Heading: "Set a new password",
            Blocks:
            [
                new Paragraph($"Somebody asked to reset the password on your {club.Name} account. Open the link below and choose a new one."),
                new CallToAction("Choose a new password", resetUrl),
                new Callout(CalloutTone.Warning, "The link lasts one hour and works once."),
                new Paragraph("If you did not ask for this, you do not need to do anything. Your password has not changed and nobody can use this link without opening this email."),
            ],
            WhyThis: WhyAccount));

    /// <summary>
    /// A password an admin reset on a member's behalf. The temporary one is in the message, so
    /// the message says plainly how long it lasts.
    /// </summary>
    public static EmailMessage AdminPasswordReset(ClubIdentity club, string to, string fullName, string tempPassword) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "An administrator has reset your password",
            Preheader: "Sign in with the temporary password in this email, then choose your own.",
            Heading: $"Hello {fullName}",
            Blocks:
            [
                new Paragraph($"An administrator at {club.Name} has reset your password. Sign in with the temporary one below."),
                new Facts([new FactRow("Temporary password", tempPassword)]),
                new Paragraph("You will be asked to choose your own straight away, and this one stops working the moment you do."),
                new Callout(CalloutTone.Warning, "Until you have chosen your own, anybody holding this email can sign in as you. Do it now rather than later, and do not forward this message."),
                new Paragraph("If you did not ask for this, contact the club committee."),
            ],
            WhyThis: WhyAccount));

    /// <summary>
    /// Confirms a password change. The one signal a member has that somebody else changed it —
    /// which is why it goes out even though the member usually just did it themselves.
    /// </summary>
    public static EmailMessage PasswordChanged(ClubIdentity club, string to) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "Your password was changed",
            Preheader: "If that was you, there is nothing to do.",
            Heading: "Your password was changed",
            Blocks:
            [
                new Paragraph($"The password on your {club.Name} account was changed a moment ago. If that was you, there is nothing to do and you can ignore this."),
                new Callout(CalloutTone.Danger, "If it was not you, somebody else has access to your account. Contact the club committee straight away."),
            ],
            WhyThis: WhyAccount));

    // ---- a court ----

    /// <summary>
    /// A booking, confirmed, with its receipt attached.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>AmountCredits</c> and <c>BalanceAfterCredits</c> are <b>credits</b>, and the penalty
    /// policy is the tenant's rather than a literal: the template this replaced hardcoded
    /// "within 15 minutes … 30%" and went on saying it after an admin had moved the club to 30
    /// minutes at 50%.
    /// </para>
    /// <para>
    /// The receipt is an <b>attachment</b> and not a link, deliberately: a link to a receipt is
    /// a link that needs a session, and the member who most wants one is forwarding the mail to
    /// somebody who has not got one. It is optional, so a missing receipt is a message with no
    /// attachment rather than a failed send.
    /// </para>
    /// </remarks>
    public static EmailMessage BookingConfirmation(
        ClubIdentity club, string to, BookingConfirmationDetails d, EmailAttachment? receipt = null)
    {
        var blocks = new List<EmailBlock>
        {
            new Paragraph(d.IsWalkUp
                ? $"You bought court time at the box and the court is yours now."
                : $"Your court is booked. Bring your phone — you open the court with your code, your PIN or your fingerprint when you get there."),
            new Facts(
            [
                new FactRow("Court", d.CourtName),
                new FactRow(d.IsWalkUp ? "Started" : "Starts", d.StartsAtLocal),
                new FactRow("Court time", d.Duration),
                new FactRow("Charged", Cr(d.AmountCredits)),
                new FactRow("Balance after", Cr(d.BalanceAfterCredits)),
            ]),
        };
        if (d.BalanceAfterCredits < 0) blocks.Add(OverdrawnNotice(d.BalanceAfterCredits));
        blocks.Add(CancellationTerms(d));
        if (receipt is not null) blocks.Add(new Footnote("Your receipt is attached to this email as a PDF."));

        return EmailChrome.Compose(club, to, new EmailContent(
            Subject: d.IsWalkUp
                ? $"Court time started — {d.CourtName}, {d.Duration}"
                : $"Booking confirmed — {d.CourtName}, {d.StartsAtLocal}",
            Preheader: d.IsWalkUp
                ? $"{d.Duration} on {d.CourtName}. {Cr(d.AmountCredits)} charged."
                : $"{d.StartsAtLocal} on {d.CourtName}. {Cr(d.AmountCredits)} charged.",
            Heading: d.IsWalkUp ? "You're on court" : "You're booked",
            Blocks: blocks,
            WhyThis: WhyBooking), receipt);
    }

    /// <summary>
    /// The one sentence a member needs when the club desk has booked for them under the
    /// override and their balance is now below zero.
    /// </summary>
    /// <remarks>
    /// Without it the confirmation states a balance of "−40.00 credits" and nothing else — a
    /// negative number with no account of itself, on the artifact a member reconciles against.
    /// The club took the booking deliberately and the member is owed the reason, not just the
    /// figure.
    /// </remarks>
    private static EmailBlock OverdrawnNotice(decimal balanceAfterCredits) =>
        new Callout(CalloutTone.Danger,
            $"The club made this booking for you, and it takes your balance to {Cr(balanceAfterCredits)}. "
            + "Top up to clear it — what you owe comes off your next top-up before anything else.");

    /// <summary>
    /// What this particular booking can still be cancelled for — the one part of the
    /// confirmation that is a promise about money.
    /// </summary>
    /// <remarks>
    /// A walk-up gets the other sentence. It is bought at the box, starts immediately and
    /// activates the court in the same request, so the penalty line offered a member already
    /// under the lights 70% of their money back for cancelling; the server refunds nothing.
    /// Neither half of the old sentence was true for one: the lights are on, and the 30% figure
    /// describes a refund that does not happen.
    /// </remarks>
    private static EmailBlock CancellationTerms(BookingConfirmationDetails d)
    {
        if (d.IsWalkUp)
        {
            return new Callout(CalloutTone.Info,
                "This is court time bought at the box, so it has already started. There is nothing to cancel, "
                + "and court time is not refunded once the lights have been on.");
        }

        return new Callout(CalloutTone.Warning,
            $"Cancel more than {d.PenaltyWindowMinutes} minutes before the start and you get everything back. "
            + $"Cancel inside that window — or leave the lights off and not turn up — and it costs you {Num(d.PenaltyPct)}% of the price.");
    }

    /// <summary>
    /// A walk-up the court would not open, and the money already back.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Its own message rather than the cancellation one, because nobody cancelled anything: the
    /// member pressed a button, the API took the credits, the activation refused, and the API
    /// put them back inside the same request. "The club cancelled your booking. You did not do
    /// this." would be three untrue sentences about an event that lasted a second.
    /// </para>
    /// <para>
    /// The figure is the <b>gross</b> refund, which is also the whole price — there is no
    /// penalty leg on a court that was never lit. A court priced at zero has no figure to print
    /// and gets the shorter sentence: no zero ledger row is written, so quoting "0.00 credits"
    /// here would name a movement that is not on the statement.
    /// </para>
    /// </remarks>
    public static EmailMessage WalkUpNotStarted(ClubIdentity club, string to, string courtName, decimal refundedCredits)
    {
        var blocks = new List<EmailBlock>
        {
            new Paragraph($"The box could not start {courtName} for you, so the court time you pressed for was not sold."),
        };
        blocks.Add(refundedCredits > 0
            ? new Callout(CalloutTone.Success, $"{Cr(refundedCredits)} has gone straight back onto your balance. You are exactly where you were before you pressed.")
            : new Callout(CalloutTone.Success, "Nothing was taken off your balance."));
        blocks.Add(new Paragraph("Try again at the box, or ask at the desk."));

        return EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Court time not started — {courtName}",
            Preheader: "Nothing was bought and nothing was charged.",
            Heading: "Nothing was bought",
            Blocks: blocks,
            WhyThis: WhyBooking));
    }

    /// <summary>
    /// A cancelled booking. Both figures are <b>credits</b>.
    /// </summary>
    /// <remarks>
    /// <paramref name="refundedCredits"/> is the <b>gross</b> refund — the
    /// <c>CancellationRefund</c> row exactly as the ledger holds it, never that row less the
    /// penalty. Netting is forbidden, so a mail quoting a net figure names a number the member
    /// cannot find on their wallet, and read as English beside the penalty line it double-counts
    /// the deduction. <paramref name="byClub"/> is null when the member cancelled it themselves.
    /// </remarks>
    public static EmailMessage BookingCancellation(
        ClubIdentity club, string to, string courtName, decimal refundedCredits, decimal? penaltyCredits,
        ClubCancellation? byClub = null)
    {
        var rows = new List<FactRow> { new("Court", courtName), new("Refunded to your balance", Cr(refundedCredits)) };
        if (penaltyCredits is > 0) rows.Add(new FactRow("Late-cancellation penalty", Cr(penaltyCredits.Value)));

        var blocks = new List<EmailBlock>
        {
            new Paragraph(byClub is null
                ? $"Your booking on {courtName} has been cancelled and the slot is free again."
                : $"The club cancelled your booking on {courtName} on your behalf. You did not do this."),
        };
        if (byClub?.Reason?.Trim() is { Length: > 0 } reason) blocks.Add(new Callout(CalloutTone.Info, $"The club's reason: {reason}"));
        blocks.Add(new Facts(rows));
        if (byClub is { PenaltyWaived: true }) blocks.Add(new Callout(CalloutTone.Success, "The late-cancellation penalty was waived, so nothing was deducted for it."));
        blocks.Add(new Footnote("Each of these is its own line in your wallet. The refund and any penalty are separate movements, not one figure."));

        return EmailChrome.Compose(club, to, new EmailContent(
            Subject: byClub is null ? $"Booking cancelled — {courtName}" : $"The club cancelled your booking — {courtName}",
            Preheader: $"{Cr(refundedCredits)} back on your balance.",
            Heading: byClub is null ? "Cancelled" : "Cancelled by the club",
            Blocks: blocks,
            WhyThis: WhyBooking));
    }

    /// <summary>
    /// A booking swept as a no-show — a required email in its own right, which had been
    /// borrowing the cancellation one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Borrowing it was wrong on four counts at once, all money-facing: the mail was headed
    /// "Cancelled" for something the member never cancelled, the court was renamed
    /// "Court 3 (no-show)", a no-show penalty was labelled a <b>late-cancellation</b> penalty,
    /// and the refund quoted was the penalty already subtracted — a figure appearing nowhere in
    /// the ledger, which holds the two legs and no netted row.
    /// </para>
    /// <para>
    /// <paramref name="refundedCredits"/> is therefore the gross leg, and the two figures are
    /// stated as the two movements they are. No netted total is printed either: that netted
    /// number is precisely what started this.
    /// </para>
    /// </remarks>
    public static EmailMessage BookingNoShow(
        ClubIdentity club, string to, string courtName, decimal refundedCredits, decimal penaltyCredits) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Missed booking — {courtName}",
            Preheader: penaltyCredits > 0
                ? $"Refunded {Cr(refundedCredits)}, less a no-show penalty of {Cr(penaltyCredits)}."
                : $"Refunded {Cr(refundedCredits)}, with no penalty.",
            Heading: "You missed this booking",
            Blocks:
            [
                new Paragraph($"Nobody was identified at {courtName} for your booking before the grace window closed, so the court was released for somebody else and the booking is marked as a no-show."),
                new Facts(
                [
                    new FactRow("Court", courtName),
                    new FactRow("Booking refunded", Cr(refundedCredits)),
                    new FactRow("No-show penalty", penaltyCredits > 0 ? Cr(penaltyCredits) : "None"),
                ]),
                new Footnote("Both of those are separate lines in your wallet — the refund and the penalty are two movements, not one."),
                new Callout(CalloutTone.Info, "If you were at the court and could not get the lights on, tell the club. They can reverse this."),
            ],
            WhyThis: WhyBooking));

    /// <summary>
    /// A booking sold on a court an earlier booking was in fact still using, because that
    /// booking's check-in reached the club late.
    /// </summary>
    public static EmailMessage BookingDisplaced(ClubIdentity club, string to, string courtName, string startsAtLocal) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Booking refunded — {courtName} was already in use",
            Preheader: "Refunded in full, with no penalty. We are sorry for the wasted trip.",
            Heading: "Your booking has been refunded",
            Blocks:
            [
                new Paragraph($"Your booking on {courtName} at {startsAtLocal} was sold while the court was still being used by an earlier booking. That booking's check-in reached the club late, so the slot looked free when it was not."),
                new Callout(CalloutTone.Success, "It has been cancelled and refunded in full, with no penalty."),
                new Paragraph("This is the club's fault rather than yours. We are sorry for the wasted trip — speak to the desk if you came down for it."),
            ],
            WhyThis: WhyBooking));

    /// <summary>
    /// A booking the member cancelled, whose code somebody then used to light the court.
    /// </summary>
    public static EmailMessage CancelledBookingLightsCharged(
        ClubIdentity club, string to, string courtName, int minutes, decimal amountCredits) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Lights charged — {courtName}",
            Preheader: $"{minutes} minutes of court time on a booking you had cancelled: {Cr(amountCredits)}.",
            Heading: "Your cancelled booking was used",
            Blocks:
            [
                new Paragraph($"The lights on {courtName} were switched on with the code from a booking you had cancelled and been refunded for."),
                new Facts(
                [
                    new FactRow("Court", courtName),
                    new FactRow("Lights were on for", $"{minutes} min"),
                    new FactRow("Charged", Cr(amountCredits)),
                ]),
                new Callout(CalloutTone.Warning, "Court time is not refunded once the lights have been on, so this charge stands."),
                new Paragraph("If that was not you, your access code has been used by somebody else — tell the club and they can look at who opened the court."),
            ],
            WhyThis: WhyMoney));

    /// <summary>A booking the club refunded on late evidence, which the court's own lights then contradicted.</summary>
    public static EmailMessage BookingReinstated(ClubIdentity club, string to, string courtName, string startsAtLocal) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Booking reinstated — {courtName}",
            Preheader: "The court was free after all, so your booking is back on and re-charged.",
            Heading: "Your booking is back on",
            Blocks:
            [
                new Paragraph($"The club refunded your booking on {courtName} at {startsAtLocal}, because an earlier booking looked as though it was still using the court."),
                new Paragraph("The court's own lights say otherwise — it went dark before your slot — so the booking has been put back and charged again at the original price. Nothing extra has been taken."),
                new Callout(CalloutTone.Success, "Your access code is in the app, as it was. Turn up as planned."),
            ],
            WhyThis: WhyBooking));

    /// <summary>A no-show the box's own record overturned.</summary>
    public static EmailMessage NoShowReversed(
        ClubIdentity club, string to, string courtName, decimal refunded, decimal penalised) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"No-show reversed — {courtName}",
            Preheader: "The court's check-in reached the club late. The booking now stands as played.",
            Heading: "You were there after all",
            Blocks:
            [
                new Paragraph($"Your booking on {courtName} was marked as a no-show, but the court's check-in reached the club afterwards. The booking now stands as attended."),
                new Facts(
                [
                    new FactRow("No-show refund reversed", Cr(refunded)),
                    new FactRow("No-show penalty returned", Cr(penalised)),
                ]),
                new Footnote("Both of those appear as their own lines in your wallet, so you can see exactly what moved and when."),
            ],
            WhyThis: WhyMoney));

    // ---- money ----

    /// <summary>
    /// Top-up confirmation — the one event where a member hands over real money, which for a
    /// long time produced no email at all.
    /// </summary>
    /// <remarks>
    /// This is the single template that legitimately shows both units: rand is what left their
    /// card, credits are what arrived in the wallet, and the rate between them is the number a
    /// dispute turns on.
    /// </remarks>
    public static EmailMessage TopUpConfirmation(ClubIdentity club, string to, TopUpReceipt r) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Top-up confirmed — {Cr(r.CreditsAdded)}",
            Preheader: $"{Zar(r.AmountZar)} paid. Your balance is now {Cr(r.BalanceAfterCredits)}.",
            Heading: "Your wallet has been topped up",
            Blocks:
            [
                new Paragraph($"Your payment has gone through and the credits are in your {club.Name} wallet. You can book a court now."),
                new Facts(
                [
                    new FactRow("You paid", Zar(r.AmountZar)),
                    new FactRow("Your rate", $"{Num(r.ConversionRate)} credits per R1"),
                    new FactRow("Credited", Cr(r.CreditsAdded)),
                    new FactRow("Balance after", Cr(r.BalanceAfterCredits)),
                    new FactRow("Reference", r.Reference),
                ]),
                new Footnote("Credits are what you book court time with. Rand is only the payment rail — keep the reference above if you ever need to ask about this payment."),
            ],
            WhyThis: WhyMoney));

    /// <summary>
    /// What a member is told when a top-up ended in anything but credits.
    /// </summary>
    /// <remarks>
    /// The sentences are the same ones the top-up status screen renders from the same stable
    /// codes, deliberately: a member who reads the screen and a member who reads the mail must
    /// not be told two different things about one payment. Codes never appear in the output —
    /// the column once held <c>amount_mismatch:reported=100,00:expected=500,00</c> and it was
    /// shown verbatim to a member as the explanation for a failed R500 payment.
    /// </remarks>
    private static string TopUpFailureSentence(string? failureReason)
    {
        switch (failureReason)
        {
            case "cancelled":
                return "You cancelled this payment at PayFast, so nothing was charged and no credits were added. "
                     + "You can start a new top-up whenever you like.";
            case "amount_mismatch":
                return "PayFast reported a different amount from the one this top-up was for, so nothing was credited. "
                     + "If money did leave your account, send the club the reference below and they will sort it out.";
            case "declined":
                return "Your bank declined the payment, so nothing was charged. Try again, or use a different card.";
            default:
                return "PayFast could not complete the payment and nothing was charged. Try again in a few minutes.";
        }
    }

    /// <summary>
    /// A top-up that ended without credits — declined, cancelled at the gateway, or settled for
    /// an amount other than the one it was registered for.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the only terminal outcome of a member handing over card details that once sent
    /// nothing at all: a member who closed the tab after PayFast learnt what happened to their
    /// money only by finding the status page again. The status screen promises this mail in as
    /// many words on the branch where it cannot reach the club — which is precisely the branch
    /// where the mail is the only channel left.
    /// </para>
    /// <para>
    /// It states the amount and says nothing was charged where that is true, because the fear a
    /// member has here is that the money left and the credits did not arrive. The one case
    /// where money may genuinely have moved — <c>amount_mismatch</c> — says so and tells them
    /// what to send the club.
    /// </para>
    /// </remarks>
    public static EmailMessage TopUpNotCompleted(
        ClubIdentity club, string to, decimal amountZar, string? failureReason, string reference) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: failureReason == "cancelled"
                ? $"Top-up cancelled — {Zar(amountZar)}"
                : $"Top-up didn't go through — {Zar(amountZar)}",
            Preheader: failureReason == "amount_mismatch"
                ? "No credits were added. Send the club the reference if money left your account."
                : "Nothing was charged and your balance has not changed.",
            Heading: failureReason == "cancelled" ? "Your top-up was cancelled" : "Your top-up didn't go through",
            Blocks:
            [
                new Paragraph(TopUpFailureSentence(failureReason)),
                new Facts(
                [
                    new FactRow("Amount", Zar(amountZar)),
                    new FactRow("Credited", Cr(0m)),
                    new FactRow("Reference", reference),
                ]),
                new Callout(CalloutTone.Info, "Your wallet balance has not changed."),
            ],
            WhyThis: WhyMoney));

    /// <summary>
    /// A manual credit adjustment by the desk. A member whose balance moves by somebody else's
    /// hand is told what moved and why.
    /// </summary>
    public static EmailMessage CreditAdjustment(
        ClubIdentity club, string to, decimal amountCredits, decimal balanceAfterCredits, string reason)
    {
        var added = amountCredits >= 0;
        var size = Cr(Math.Abs(amountCredits));
        return EmailChrome.Compose(club, to, new EmailContent(
            Subject: added ? $"Credit added — {size}" : $"Credit deducted — {size}",
            Preheader: $"Your balance is now {Cr(balanceAfterCredits)}.",
            Heading: added ? "Credits added to your wallet" : "Credits taken off your wallet",
            Blocks:
            [
                new Paragraph($"An administrator at {club.Name} has adjusted your balance by hand."),
                new Facts(
                [
                    new FactRow("Amount", (added ? "+" : "−") + size),
                    new FactRow("Balance after", Cr(balanceAfterCredits)),
                    new FactRow("Reason given", reason),
                ]),
                new Paragraph("If that does not look right, reply to this email or speak to the desk. The movement stays on your wallet either way — a correction is a second line, never a deleted one."),
            ],
            WhyThis: WhyMoney));
    }

    // ---- what the club's hardware is doing ----

    /// <summary>
    /// The club's admins, told a court box has gone quiet.
    /// </summary>
    /// <remarks>
    /// It names the courts rather than only the box, because that is what the admin has to
    /// decide about: a dark box on courts 1 and 2 means two courts nobody can light, and the
    /// desk needs to know which two before it can put a sign on a door.
    /// </remarks>
    public static EmailMessage AdminPeripheralUnhealthy(ClubIdentity club, string to, PeripheralAlert alert) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Court box not reporting — {alert.DeviceCode}",
            Preheader: $"Silent for {alert.Minutes} minutes on {Courts(alert.CourtNumbers)}. Do not power-cycle it yet.",
            Heading: "A court box has stopped reporting",
            Blocks:
            [
                new Paragraph($"{alert.DeviceName} at {club.Name} last called home {alert.Minutes} minutes ago."),
                new Facts(
                [
                    new FactRow("Box", alert.DeviceCode),
                    new FactRow("Courts", Courts(alert.CourtNumbers)),
                    new FactRow("Silent for", $"{alert.Minutes} min"),
                ]),
                new Callout(CalloutTone.Danger,
                    "Check its WiFi and its network first — do not power-cycle it yet. A box that has lost only its uplink "
                    + "keeps lighting courts from the list it already holds, and it holds those scans in memory until it can "
                    + "upload them. Cutting the power discards them, and every court it lit during the outage then settles as "
                    + "if nobody played."),
                new Paragraph("While it is dark, members on those courts may not be able to check in. Bookings that pass their grace window are refunded in full with no no-show penalty, and those members are told why."),
                new CallToAction("Open the Devices page", alert.ConsoleUrl),
            ],
            WhyThis: WhyAdmin), highPriority: true);

    /// <summary>The all-clear, so an admin who was sent to a cupboard knows to stop looking.</summary>
    public static EmailMessage AdminPeripheralRecovered(ClubIdentity club, string to, PeripheralAlert alert) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Court box back online — {alert.DeviceCode}",
            Preheader: $"Back after {alert.Minutes} minutes. What happens to the scans it was holding depends on its power.",
            Heading: "The court box is reporting again",
            Blocks:
            [
                new Paragraph($"{alert.DeviceName} ({alert.DeviceCode}) at {club.Name} is back after {alert.Minutes} minutes."),
                new Paragraph("Anything the box recorded while it was offline uploads on its next few calls if it stayed powered, and a member who did play during the outage then settles as attended."),
                new Callout(CalloutTone.Warning, "If it lost power or was restarted, those scans are gone. Courts it lit are refunded in full and the club carries them."),
                new CallToAction("Open the Devices page", alert.ConsoleUrl),
            ],
            WhyThis: WhyAdmin));

    /// <summary>
    /// A door gate has stopped reporting.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>It shares not one sentence with the court box's alert, and that is the point of it
    /// existing.</b> A silent gate used to send that one: "Court box not reporting", members on
    /// "those courts" may not be able to check in, bookings past their grace window refunded
    /// with no no-show penalty. Every clause is false about a door — a gate drives no courts,
    /// stamps no attendance, and is invisible to the settlement model, so nothing is refunded
    /// and no penalty is waived. An admin acting on it goes looking for a court box that is
    /// working, and the door stays shut.
    /// </para>
    /// <para>
    /// What IS true is the degraded mode, and it is worth stating because it has a deadline in
    /// it: a door that has lost the server still admits members with a booking on the list it
    /// already holds, and admits nobody at all once that list goes stale six hours after it was
    /// fetched. The club has that long before the door stops working entirely.
    /// </para>
    /// <para>
    /// The power-cycle warning the court box's alert leads with is deliberately absent: a gate
    /// queues door opens rather than attendance, so nothing a club can be charged for is lost by
    /// restarting one.
    /// </para>
    /// </remarks>
    public static EmailMessage AdminGateUnhealthy(ClubIdentity club, string to, GateAlert alert) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Door gate not reporting — {alert.DeviceCode}",
            Preheader: $"Silent for {alert.Minutes} minutes. It still opens for booked members, for about 6 hours.",
            Heading: "A door gate has stopped reporting",
            Blocks:
            [
                new Paragraph($"{alert.DeviceName} at {club.Name} last called home {alert.Minutes} minutes ago."),
                new Facts(
                [
                    new FactRow("Board", alert.DeviceCode),
                    new FactRow("Door", Door(alert.GateKey)),
                    new FactRow("Silent for", $"{alert.Minutes} min"),
                ]),
                new Callout(CalloutTone.Warning,
                    "The door has not stopped working, yet. While it cannot reach the club it falls back to the list it "
                    + "already holds, so it still opens for booked members and for nobody else. That list goes stale 6 hours "
                    + "after it was last received, and from then the door opens for nobody until it is back online."),
                new Footnote("Nothing about this affects money or play: a door gate records no attendance, and nothing is charged or credited because of one."),
                new Footnote("Getting out of the building never depends on this board, its power, or the club's system."),
                new CallToAction("Open the Devices page", alert.ConsoleUrl),
            ],
            WhyThis: WhyAdmin), highPriority: true);

    /// <summary>
    /// The door's all-clear. Separate from the court box's for the same reason as above: that
    /// one promises queued scans will upload and settle as attended, and that lit time is
    /// otherwise refunded. A door queues neither.
    /// </summary>
    public static EmailMessage AdminGateRecovered(ClubIdentity club, string to, GateAlert alert) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Door gate back online — {alert.DeviceCode}",
            Preheader: $"Back after {alert.Minutes} minutes, with a current list.",
            Heading: "The door gate is reporting again",
            Blocks:
            [
                new Paragraph($"{alert.DeviceName} ({alert.DeviceCode}) at {club.Name} is back after {alert.Minutes} minutes."),
                new Callout(CalloutTone.Success, "It has a current list again, so it opens for every member it should."),
                new Footnote("Any opens it decided on its own while it was away upload on its next few calls, for the record only."),
                new CallToAction("Open the Devices page", alert.ConsoleUrl),
            ],
            WhyThis: WhyAdmin));

    // ---- the club's hardware, from the member's side ----

    /// <summary>
    /// What a member is told when their booking was swept while the court's own box was
    /// unreachable.
    /// </summary>
    /// <remarks>
    /// A distinct template rather than the no-show notice with a softer sentence. The no-show
    /// notice says the member did not turn up and quotes a penalty; this member may well have
    /// been standing at a dark court, and telling them they were a no-show is the club blaming
    /// them for its own hardware.
    /// </remarks>
    public static EmailMessage BookingRefundedForOutage(
        ClubIdentity club, string to, string courtName, decimal refundedCredits) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Refunded — {courtName} was offline",
            Preheader: $"{Cr(refundedCredits)} back, no penalty. You have not been marked down for this.",
            Heading: "Your booking has been refunded in full",
            Blocks:
            [
                new Paragraph($"The court controller at {club.Name} was offline during your booking on {courtName}, so the lights could not be released against your name."),
                new Facts(
                [
                    new FactRow("Refunded", Cr(refundedCredits)),
                    new FactRow("Penalty", "None"),
                ]),
                new Callout(CalloutTone.Success, "You have not been marked down for missing it, and nothing has been deducted."),
                new Footnote("If you did get onto the court, the box uploads its record when it reconnects and the booking settles as played — the refund is reversed and you are charged the original price, with no penalty either way."),
            ],
            WhyThis: WhyBooking));

    /// <summary>
    /// The same waiver, for the branch where the court's hardware is switched off rather than
    /// merely quiet.
    /// </summary>
    /// <remarks>
    /// <para>
    /// It exists because of one sentence the outage notice makes and this one cannot: that the
    /// box uploads its record when it reconnects and the booking settles as attended. That
    /// reversal is real while the board is in service. A board an admin has taken out of service
    /// is refused on all five device routes, so nothing it is holding will ever be accepted and
    /// the settlement cannot be reversed by the box. Repeating the promise here would tell a
    /// member who did get onto the court to wait for a correction that is not coming, and send
    /// them to the desk a week later instead of today.
    /// </para>
    /// <para>
    /// <b>The opening sentence has been wrong twice, in two different ways.</b> It first said
    /// "No court box was answering on {court} during your booking", which recording the
    /// switch-off instant made false: a court is out of service from the click, not from the
    /// point the board's silence passed its threshold, so the board may have been answering
    /// perfectly a minute before the grace window closed and was simply switched off. Its
    /// replacement said that no check-in on that court could have reached the club, and that is
    /// false too: the three courtside terminal routes — PIN, QR and biometric — resolve a court
    /// number, never look at a device row, and still stamp attendance. Telling a member that
    /// nothing they did could have reached the club is telling them something untrue about
    /// their own evening.
    /// </para>
    /// <para>
    /// So the sentence now claims only what is true of the BOX, which is the thing the club
    /// actually switched off: it could not open the court, and it will never report anyone who
    /// played. Both halves are the same refusal on the device routes, and the second is what
    /// earns the "this refund is final" sentence below.
    /// </para>
    /// </remarks>
    public static EmailMessage BookingRefundedForOutOfServiceBox(
        ClubIdentity club, string to, string courtName, decimal refundedCredits) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Refunded — the box on {courtName} is out of service",
            Preheader: $"{Cr(refundedCredits)} back, no penalty. This refund is final.",
            Heading: "Your booking has been refunded in full",
            Blocks:
            [
                new Paragraph($"Nobody checked in on {courtName} at {club.Name} during your booking, and the box on that court is out of service — it could not open the court, and it will never send the club a record of anyone who played."),
                new Facts(
                [
                    new FactRow("Refunded", Cr(refundedCredits)),
                    new FactRow("Penalty", "None"),
                ]),
                new Callout(CalloutTone.Success, "You have not been marked down for missing it, and nothing has been deducted."),
                new Footnote("Because that box is out of service it will not send the club anything further, so this refund is final. If you did get onto the court, tell the desk rather than waiting for it to correct itself."),
            ],
            WhyThis: WhyBooking));

    // ---- small words ----

    /// <summary>Court numbers, for a sentence. "court 3" reads better than "[3]".</summary>
    private static string Courts(IReadOnlyList<int> courtNumbers)
    {
        if (courtNumbers.Count == 0) return "none recorded";
        var numbers = string.Join(", ", courtNumbers);
        return (courtNumbers.Count == 1 ? "court " : "courts ") + numbers;
    }

    /// <summary>
    /// The door's name for an admin, or an honest stand-in. A gate nobody has named yet has no
    /// offline fallback either, so "not named yet" is the actionable half of this alert rather
    /// than a blank cell.
    /// </summary>
    private static string Door(string? gateKey) =>
        string.IsNullOrWhiteSpace(gateKey) ? "not named yet" : gateKey;
}
