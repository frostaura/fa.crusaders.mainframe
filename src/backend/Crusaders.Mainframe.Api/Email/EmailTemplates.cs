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
    int AmountMinutes,
    int BalanceAfterMinutes,
    int PenaltyWindowMinutes,
    decimal PenaltyPct,
    bool IsWalkUp = false,
    bool MadeByClub = true);

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
/// Which court time a cancellation mail is about: the court and, since review round 2 (B-7), the
/// club-local start — "Court 1 · Thu 1 Oct, 10:15". A member with two bookings on one court
/// could not tell which one had gone. A bare court name converts implicitly (older call sites).
/// </summary>
public sealed record CancelledSlot(string CourtName, string? WhenLocal = null)
{
    public static implicit operator CancelledSlot(string courtName) => new(courtName);

    /// <summary>The court, then the time when there is one: <c>Court 1 · Thu 1 Oct, 10:15</c>.</summary>
    public string Label => WhenLocal is { Length: > 0 } when ? $"{CourtName} · {when}" : CourtName;
}

/// <summary>
/// What a package purchase confirmation states (contract §6). A record rather than nine more
/// parameters: with the club and the recipient it would be eleven, past the complexity gate's
/// six, and most of them are decimals or strings that would transpose silently.
/// </summary>
/// <remarks>
/// <b><see cref="CurrencySymbol"/> denominates <see cref="ListPriceZar"/> and
/// <see cref="AmountZar"/> and nothing else on this record.</b> <see cref="Minutes"/> and
/// <see cref="BalanceAfterMinutes"/> are minutes, and a minutes figure never wears a currency
/// sign. Every figure is the one LOCKED on the purchase row at checkout, never the live package.
/// </remarks>
/// <param name="DiscountBps">The group discount applied, in basis points; 0 when none, and then no discount line is shown.</param>
/// <param name="DiscountGroupName">The group the discount came from, named on the discount line.</param>
/// <param name="Reference">The PayFast payment id the member can quote.</param>
public sealed record PackagePurchaseReceipt(
    string PackageName,
    int Minutes,
    decimal ListPriceZar,
    int DiscountBps,
    string? DiscountGroupName,
    decimal AmountZar,
    int BalanceAfterMinutes,
    string Reference,
    string CurrencySymbol);

/// <summary>
/// A package purchase that ended without minutes, for <see cref="EmailTemplates.PurchaseNotCompleted(ClubIdentity, string, PackagePurchaseAttempt)"/>.
/// A record for the reason <see cref="PackagePurchaseReceipt"/> is one: the complexity gate's six
/// parameters. <see cref="CurrencySymbol"/> denominates <see cref="AmountZar"/> only.
/// </summary>
/// <param name="FailureReason">The stored failure code (<c>cancelled</c>, <c>declined</c>, <c>amount_mismatch</c>, …); never shown.</param>
public sealed record PackagePurchaseAttempt(
    string PackageName,
    int Minutes,
    decimal AmountZar,
    string? FailureReason,
    string Reference,
    string CurrencySymbol);

/// <summary>
/// A package the desk sold, for <see cref="EmailTemplates.PackageSoldAtDesk(ClubIdentity, string, DeskPackageSale)"/>.
/// <see cref="CurrencySymbol"/> denominates <see cref="ZarReceived"/> only.
/// </summary>
/// <param name="ZarReceived">What the desk took — which may differ from the shelf price (contract §3.7).</param>
public sealed record DeskPackageSale(
    string PackageName,
    int Minutes,
    decimal ZarReceived,
    int BalanceAfterMinutes,
    string CurrencySymbol)
{
    /// <summary>Given at no charge (<c>package_free</c>, review round 7 J7-10): the mail says so instead of "Amount received".</summary>
    public bool NoCharge { get; init; }
}

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

public static partial class EmailTemplates
{
    // ---- units ----

    /// <summary>
    /// Minutes, for an email: "45 minutes", "1 hour 30 minutes", "1 day 6 hours" (contract §6, §7.2).
    /// </summary>
    /// <remarks>
    /// <para>
    /// Every money email once printed a rand sign over a unit-of-account figure — "Charged R50,00"
    /// for a court the member had not paid R50 for — which is the unit lie <c>CLAUDE.md</c>
    /// forbids, on the one artifact a member reconciles a bank statement against. Minutes are the
    /// unit of account; rand appears only where a member actually paid rand (a package bought
    /// online or at the desk), and a minutes figure never carries a currency symbol.
    /// </para>
    /// <para>
    /// Whole minutes only, in prose, never a decimal. <b>The rendering itself lives in
    /// <see cref="Services.MoneyFormat"/></b>, because a ledger reason needs the same figure and
    /// a ledger reason is not email chrome — the one place that kept its own copy of a format
    /// string is the one place that drifted.
    /// </para>
    /// </remarks>
    internal static string Min(int value) => Services.MoneyFormat.Minutes(value);

    /// <summary>
    /// Real money, in the club's own symbol. Only for amounts that really are money — what the
    /// member paid the gateway.
    ///
    /// <para>
    /// <b>The symbol is a parameter rather than a constant, and it is required rather than
    /// defaulted.</b> A default would let a new money surface be written that silently prints
    /// a rand sign to a club that does not take rand, and nothing would fail; required, the
    /// compiler asks the author where the club's symbol comes from. There are three call sites
    /// and the answer is <see cref="Services.CurrencySymbol.For"/> at all three.
    /// </para>
    ///
    /// <para>
    /// The symbol PRECEDES the amount, which forces a choice a trailing unit never did: the
    /// sign goes OUTSIDE it. "-R50.00" is how a negative amount of money is written;
    /// "R-50.00" reads as a symbol followed by a malformed number.
    /// </para>
    ///
    /// <para>
    /// Invariant culture, for the reason <see cref="Min"/> gives — and here it is load-bearing
    /// twice over, because PayFast rejects the club's own <c>en-ZA</c> comma decimal.
    /// </para>
    /// </summary>
    internal static string Zar(decimal value, string symbol) => Services.MoneyFormat.Money(value, symbol);

    /// <summary>A number with no trailing-zero noise, for percentages and rates. Invariant, as above.</summary>
    internal static string Num(decimal value) => Services.MoneyFormat.Number(value);

    // ---- the reasons a person is holding one of these ----
    //
    // Every message carries one. A transactional mail that explains nothing about itself is
    // indistinguishable from a phishing attempt, which is the failure that matters on the
    // three that carry a sign-in link or a password. There is no unsubscribe: a club cannot
    // stop telling a member their money moved, and a link pretending otherwise would be a lie.

    private const string WhyAccount =
        "You're getting this because somebody asked for it on your account at the club. "
        + "If that wasn't you, tell the club straight away.";

    private const string WhyMembership =
        "You're getting this because you have a membership application or a membership at the club.";

    private const string WhyMoney =
        "You're getting this because it is the record of money moving in your club wallet. "
        + "The club emails you every time that happens, so the trail is yours to keep.";

    private const string WhyBooking =
        "You're getting this because it is the record of a court booking in your name at the club.";

    private const string WhyAdmin =
        "You're getting this because you're listed as an administrator at the club. "
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
                new Paragraph("You'll get one more email once they have, and you can book a court from then on. Nothing else is needed from you in the meantime."),
            ],
            WhyThis: "You're getting this because somebody used this address to apply for membership at the club. "
                   + "If that wasn't you, ignore this email and the application expires on its own."));

    /// <summary>The applicant is in, and the mail is the way in.</summary>
    public static EmailMessage MembershipApproved(ClubIdentity club, string to, string magicLinkUrl) =>
        EmailChrome.Compose(club, to, new EmailContent(
            // The club's name is the only variable in this subject, and it leads with the two
            // words that carry it. Everything else a subject could say here is in the
            // preheader, which is where a long club name pushes text off a phone's list.
            Subject: $"Welcome to {club.Name}",
            Preheader: "You're approved and can book a court. The sign-in link below lasts 15 minutes.",
            Heading: "You're in",
            Blocks:
            [
                new Paragraph($"Somebody at {club.Name} has checked your membership number and approved you. You can book a court from now on."),
                new CallToAction("Sign in to the club", magicLinkUrl),
                new Callout(CalloutTone.Warning, "This sign-in link lasts 15 minutes. If it has expired by the time you open it, sign in with your email address and password instead."),
                new Paragraph("Buy minutes first — court time is booked in minutes, and the club's packages are in the app under Buy minutes."),
            ],
            WhyThis: WhyMembership));

    /// <summary>The application was refused. The reason is the admin's own words.</summary>
    public static EmailMessage MembershipRejected(ClubIdentity club, string to, string reason) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "Your membership application wasn't approved",
            Preheader: "The club has given a reason, and there is somebody to talk to about it.",
            Heading: "The club couldn't approve your application",
            Blocks:
            [
                new Paragraph($"Somebody at {club.Name} has looked at your application and hasn't approved it."),
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
            Preheader: "You can't book or get on court for now. Your minutes are untouched.",
            Heading: "Your membership is suspended",
            Blocks:
            [
                new Paragraph($"Hello {fullName}. Your membership at {club.Name} has been suspended, so you can't sign in, book a court, or open a court or the door with your member code while it is."),
                new Callout(CalloutTone.Danger, reason),
                new Paragraph("Your minutes and any bookings you already have are untouched. Speak to the club office to have the suspension lifted."),
            ],
            WhyThis: WhyMembership));

    /// <summary>The hold is off.</summary>
    public static EmailMessage MembershipReactivated(ClubIdentity club, string to, string fullName) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: "Your membership is active again",
            Preheader: "You can book and get on court again. Your minutes are where you left them.",
            Heading: "Your membership is active again",
            Blocks:
            [
                new Paragraph($"Hello {fullName}. Your membership at {club.Name} is active again, so you can sign in, book courts, and open a court at the box."),
                new Callout(CalloutTone.Success, "Your minutes balance is exactly as you left it. Nothing was taken while you were suspended."),
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
            Preheader: "The link below lasts an hour. If you didn't ask for it, nothing has changed.",
            Heading: "Set a new password",
            Blocks:
            [
                new Paragraph($"Somebody asked to reset the password on your {club.Name} account. Open the link below and choose a new one."),
                new CallToAction("Choose a new password", resetUrl),
                new Callout(CalloutTone.Warning, "The link lasts one hour and works once."),
                new Paragraph("If you didn't ask for this, there's nothing to do. Your password hasn't changed, and nobody can use this link without opening this email."),
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
            Heading: "An administrator has reset your password",
            Blocks:
            [
                new Paragraph($"Hello {fullName}. An administrator at {club.Name} has reset your password, so sign in with the temporary one below."),
                new Facts([new FactRow("Temporary password", tempPassword)]),
                new Paragraph("You'll be asked to choose your own straight away, and this one stops working the moment you do."),
                new Callout(CalloutTone.Warning, "Until you have chosen your own, anybody holding this email can sign in as you. Do it now rather than later, and do not forward this message."),
                new Paragraph("If you didn't ask for this, contact the club committee."),
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
                new Paragraph($"The password on your {club.Name} account was changed a moment ago. If that was you, there's nothing to do and you can ignore this."),
                new Callout(CalloutTone.Danger, "If it wasn't you, somebody else has access to your account. Contact the club committee straight away."),
            ],
            WhyThis: WhyAccount));

    // ---- a court ----

    /// <summary>
    /// A booking, confirmed, with its receipt attached.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>AmountMinutes</c> and <c>BalanceAfterMinutes</c> are <b>minutes</b>, and the penalty
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
                : $"Your court is booked. Bring your phone — you open the door and the court with the member code on it when you get there."),
            new Facts(
            [
                new FactRow("Court", d.CourtName),
                new FactRow(d.IsWalkUp ? "Started" : "Starts", d.StartsAtLocal),
                new FactRow("Court time", d.Duration),
                new FactRow("Charged", Min(d.AmountMinutes)),
                new FactRow("Balance after", Min(d.BalanceAfterMinutes)),
            ]),
        };
        if (d.BalanceAfterMinutes < 0) blocks.Add(OverdrawnNotice(d.BalanceAfterMinutes, d.MadeByClub));
        blocks.Add(CancellationTerms(d));
        if (receipt is not null) blocks.Add(new Footnote("Your receipt is attached to this email as a PDF."));

        return EmailChrome.Compose(club, to, new EmailContent(
            Subject: d.IsWalkUp
                ? $"Court time started — {d.CourtName}, {d.Duration}"
                : $"Booking confirmed — {d.CourtName}, {d.StartsAtLocal}",
            Preheader: d.IsWalkUp
                ? $"{d.Duration} on {d.CourtName}. {Min(d.AmountMinutes)} charged."
                : $"{d.StartsAtLocal} on {d.CourtName}. {Min(d.AmountMinutes)} charged.",
            Heading: d.IsWalkUp ? "You're on court" : "You're booked",
            Blocks: blocks,
            WhyThis: WhyBooking), receipt);
    }

    /// <summary>
    /// The one sentence a member needs when the club desk has booked for them under the
    /// override and their balance is now below zero.
    /// </summary>
    /// <remarks>
    /// Without it the confirmation states a balance of "−40 minutes" and nothing else — a
    /// negative number with no account of itself, on the artifact a member reconciles against.
    /// The club took the booking deliberately and the member is owed the reason, not just the
    /// figure.
    /// <para>
    /// <paramref name="madeByClub"/> is false when an admin booked their OWN court into the red
    /// (decision R19); the opening clause is then about the booking, not about the club.
    /// </para>
    /// </remarks>
    private static EmailBlock OverdrawnNotice(int balanceAfterMinutes, bool madeByClub)
    {
        var opening = madeByClub
            ? "The club made this booking for you, and it takes"
            : "This booking takes";
        return new Callout(CalloutTone.Danger,
            $"{opening} your balance to {Min(balanceAfterMinutes)}. "
            + "Buy minutes to clear it — what you owe comes off your next package before anything else.");
    }

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
            + $"Cancel inside that window — or leave the lights off and not turn up — and it costs you "
            + $"{Num(d.PenaltyPct)}% of the booking's minutes ({Min(PenaltyOf(d.AmountMinutes, d.PenaltyPct))}).");
    }

    /// <summary>
    /// The penalty a booking would carry, as the server settles it: rounded DOWN to a whole minute,
    /// in favour of the member (contract §1.2). Quoting a figure the server would not charge is the
    /// same promise-breaking this sentence was rewritten to stop.
    /// </summary>
    internal static int PenaltyOf(int chargedMinutes, decimal penaltyPct)
    {
        if (chargedMinutes <= 0 || penaltyPct <= 0) return 0;
        return (int)Math.Floor(chargedMinutes * penaltyPct / 100m);
    }

    /// <summary>
    /// A walk-up the court would not open, and the money already back.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Its own message rather than the cancellation one, because nobody cancelled anything: the
    /// member pressed a button, the API took the minutes, the activation refused, and the API
    /// put them back inside the same request. "The club cancelled your booking. You did not do
    /// this." would be three untrue sentences about an event that lasted a second.
    /// </para>
    /// <para>
    /// The figure is the <b>gross</b> refund, which is also the whole price — there is no
    /// penalty leg on a court that was never lit. A court priced at zero has no figure to print
    /// and gets the shorter sentence: no zero ledger row is written, so quoting "0 minutes"
    /// here would name a movement that is not on the statement.
    /// </para>
    /// </remarks>
    public static EmailMessage WalkUpNotStarted(ClubIdentity club, string to, string courtName, int refundedMinutes)
    {
        var blocks = new List<EmailBlock>
        {
            new Paragraph($"The box couldn't start {courtName} for you, so the court time you pressed for wasn't sold."),
        };
        blocks.Add(refundedMinutes > 0
            ? new Callout(CalloutTone.Success, $"{Min(refundedMinutes)} has gone straight back onto your balance. You are exactly where you were before you pressed.")
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
    /// A cancelled booking. Both figures are <b>minutes</b>.
    /// </summary>
    /// <remarks>
    /// <paramref name="refundedMinutes"/> is the <b>gross</b> refund — the
    /// <c>CancellationRefund</c> row exactly as the ledger holds it, never that row less the
    /// penalty. Netting is forbidden, so a mail quoting a net figure names a number the member
    /// cannot find on their wallet, and read as English beside the penalty line it double-counts
    /// the deduction. <paramref name="byClub"/> is null when the member cancelled it themselves.
    /// </remarks>
    public static EmailMessage BookingCancellation(
        ClubIdentity club, string to, CancelledSlot slot, int refundedMinutes, int? penaltyMinutes,
        ClubCancellation? byClub = null)
    {
        var rows = new List<FactRow> { new("Court", slot.CourtName) };
        if (slot.WhenLocal is { Length: > 0 } when) rows.Add(new FactRow("When", when));
        rows.Add(new FactRow("Refunded to your balance", Min(refundedMinutes)));
        if (penaltyMinutes is > 0) rows.Add(new FactRow("Late-cancellation penalty", Min(penaltyMinutes.Value)));

        var blocks = new List<EmailBlock>
        {
            new Paragraph(byClub is null
                ? $"Your booking on {slot.Label} has been cancelled and the slot is free again."
                : $"The club cancelled your booking on {slot.Label} on your behalf. You did not do this."),
        };
        if (byClub?.Reason?.Trim() is { Length: > 0 } reason) blocks.Add(new Callout(CalloutTone.Info, $"Reason given by the club: {reason}"));
        blocks.Add(new Facts(rows));
        if (byClub is { PenaltyWaived: true }) blocks.Add(new Callout(CalloutTone.Success, "The late-cancellation penalty was waived, so nothing was deducted for it."));
        blocks.Add(new Footnote("Each of these is its own line in your wallet. The refund and any penalty are separate movements, not one figure."));

        return EmailChrome.Compose(club, to, new EmailContent(
            Subject: byClub is null ? $"Booking cancelled — {slot.Label}" : $"The club cancelled your booking — {slot.Label}",
            // Both legs when there is a penalty (review round 6, J6-6): the preview alone said
            // "15 minutes back" to a member 11 better off. Still the two ledger figures, never a net.
            Preheader: penaltyMinutes is > 0
                ? $"Refunded {Min(refundedMinutes)}, less a late-cancellation penalty of {Min(penaltyMinutes.Value)}."
                : $"{Min(refundedMinutes)} back on your balance.",
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
    /// <paramref name="refundedMinutes"/> is therefore the gross leg, and the two figures are
    /// stated as the two movements they are. No netted total is printed either: that netted
    /// number is precisely what started this.
    /// </para>
    /// </remarks>
    public static EmailMessage BookingNoShow(
        ClubIdentity club, string to, string courtName, int refundedMinutes, int penaltyMinutes) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Missed booking — {courtName}",
            Preheader: penaltyMinutes > 0
                ? $"Refunded {Min(refundedMinutes)}, less a no-show penalty of {Min(penaltyMinutes)}."
                : $"Refunded {Min(refundedMinutes)}, with no penalty.",
            Heading: "You missed this booking",
            Blocks:
            [
                new Paragraph($"Nobody was identified at {courtName} for your booking before the grace window closed, so the court was released for somebody else and the booking is marked as a no-show."),
                new Facts(
                [
                    new FactRow("Court", courtName),
                    new FactRow("Booking refunded", Min(refundedMinutes)),
                    new FactRow("No-show penalty", penaltyMinutes > 0 ? Min(penaltyMinutes) : "None"),
                ]),
                new Footnote("Both of those are separate lines in your wallet — the refund and the penalty are two movements, not one."),
                new Callout(CalloutTone.Info, "If you were at the court and couldn't get the lights on, tell the club. They can reverse this."),
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
        ClubIdentity club, string to, string courtName, int minutes, int amountMinutes) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Lights charged — {courtName}",
            Preheader: $"{minutes} minutes of court time on a booking you had cancelled: {Min(amountMinutes)}.",
            Heading: "Your cancelled booking was used",
            Blocks:
            [
                new Paragraph($"The lights on {courtName} were switched on with the code from a booking you had cancelled and been refunded for."),
                new Facts(
                [
                    new FactRow("Court", courtName),
                    new FactRow("Lights were on for", Min(minutes)),
                    new FactRow("Charged", Min(amountMinutes)),
                ]),
                new Callout(CalloutTone.Warning, "Court time is not refunded once the lights have been on, so this charge stands."),
                new Paragraph("If that wasn't you, your access code has been used by somebody else — tell the club and they can look at who opened the court."),
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
        ClubIdentity club, string to, string courtName, int refunded, int penalised) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"No-show reversed — {courtName}",
            Preheader: "The court's check-in reached the club late. The booking now stands as played.",
            Heading: "You were there after all",
            Blocks:
            [
                new Paragraph($"Your booking on {courtName} was marked as a no-show, but the court's check-in reached the club afterwards. The booking now stands as attended."),
                new Facts(
                [
                    new FactRow("No-show refund reversed", Min(refunded)),
                    new FactRow("No-show penalty returned", Min(penalised)),
                ]),
                new Footnote("Both of those appear as their own lines in your wallet, so you can see exactly what moved and when."),
            ],
            WhyThis: WhyMoney));

    /// <summary>
    /// A booking refunded in full because its court box was offline, which the box's own late
    /// check-in then showed was played (review round 9, E9-2). Never a no-show: the sweep did not
    /// call it one, and there was no penalty to return.
    /// </summary>
    public static EmailMessage OutageRefundReversed(ClubIdentity club, string to, string courtName, int refunded) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Outage refund reversed — {courtName}",
            Preheader: "The court's check-in reached the club late. The booking now stands as played.",
            Heading: "You were checked in after all",
            Blocks:
            [
                new Paragraph($"Your booking on {courtName} was refunded in full because the court's box was offline and could not tell the club you had arrived. Its check-in has since come through, so the booking stands as played and the refund has been taken back."),
                new Facts(
                [
                    new FactRow("Refund taken back", Min(refunded)),
                ]),
                new Footnote("It appears as its own line in your wallet, so you can see exactly what moved and when."),
            ],
            WhyThis: WhyMoney));

    // ---- money ----

    /// <summary>
    /// A package bought through PayFast, complete — the one event where a member hands over real
    /// money (contract §6).
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the template that legitimately shows both quantities: rand is what left their
    /// card, minutes are what arrived in the wallet. <b>The club's symbol reaches the rand rows
    /// and stops there</b> — a minutes figure never wears a currency sign, so "R550.00" and
    /// "5 hours" can sit in adjacent rows without one being read as the other.
    /// </para>
    /// <para>
    /// The discount line appears only when one was applied, and names the group it came from,
    /// because a member who pays R495 for a package listed at R550 is owed the reason on the
    /// receipt rather than at the desk. The figures are the LOCKED ones from the purchase row,
    /// never the live package: an admin who edits the package between checkout and callback
    /// does not change what this member bought.
    /// </para>
    /// </remarks>
    public static EmailMessage PurchaseConfirmation(ClubIdentity club, string to, PackagePurchaseReceipt r)
    {
        var rows = new List<FactRow>
        {
            new("Package", r.PackageName),
            new("Minutes added", Min(r.Minutes)),
            new("Package price", Zar(r.ListPriceZar, r.CurrencySymbol)),
        };
        if (r.DiscountBps > 0) rows.Add(new FactRow("Discount", DiscountLine(r.DiscountBps, r.DiscountGroupName)));
        rows.Add(new FactRow("You paid", Zar(r.AmountZar, r.CurrencySymbol)));
        rows.Add(new FactRow("Reference", r.Reference));
        rows.Add(new FactRow("Balance after", Min(r.BalanceAfterMinutes)));

        return EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Minutes bought — {r.PackageName}",
            Preheader: $"{Min(r.Minutes)} added for {Zar(r.AmountZar, r.CurrencySymbol)}. Your balance is now {Min(r.BalanceAfterMinutes)}.",
            Heading: "Your minutes are in",
            Blocks:
            [
                new Paragraph($"Your payment has gone through and the minutes are in your {club.Name} wallet. You can book a court now."),
                new Facts(rows),
                new Footnote($"Minutes are what you book court time with, and they do not expire. {r.CurrencySymbol} is only how you paid — keep the reference above if you ever need to ask about this payment."),
            ],
            WhyThis: WhyMoney));
    }

    /// <summary>"10% off — League": the percentage in whole or decimal points, never trailing zeros.</summary>
    private static string DiscountLine(int discountBps, string? groupName)
    {
        var pct = Num(discountBps / 100m) + "% off";
        return string.IsNullOrWhiteSpace(groupName) ? pct : $"{pct} — {groupName}";
    }

    /// <summary>
    /// What a member is told when a purchase ended without minutes.
    /// </summary>
    /// <remarks>
    /// The sentences are the same ones the purchase status screen renders from the same stable
    /// codes, deliberately: a member who reads the screen and a member who reads the mail must
    /// not be told two different things about one payment. Codes never appear in the output —
    /// the column once held <c>amount_mismatch:reported=100,00:expected=500,00</c> and it was
    /// shown verbatim to a member as the explanation for a failed R500 payment.
    /// </remarks>
    private static string PurchaseFailureSentence(string? failureReason)
    {
        switch (failureReason)
        {
            case "cancelled":
                return "You cancelled this payment at PayFast, so nothing was charged and no minutes were added. "
                     + "You can buy a package again whenever you like.";
            case "amount_mismatch":
                return "PayFast reported a different amount from the one this purchase was for, so no minutes were added. "
                     + "If money did leave your account, send the club the reference below and they will sort it out.";
            case "declined":
                return "Your bank declined the payment, so nothing was charged. Try again, or use a different card.";
            default:
                return "PayFast could not complete the payment and nothing was charged. Try again in a few minutes.";
        }
    }

    /// <summary>
    /// A package purchase that ended without minutes — declined, cancelled at the gateway, or
    /// settled for an amount other than the one it was registered for.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the only terminal outcome of a member handing over card details that once sent
    /// nothing at all: a member who closed the tab after PayFast learnt what happened to their
    /// money only by finding the status page again.
    /// </para>
    /// <para>
    /// It states the package and the amount, and says nothing was charged where that is true,
    /// because the fear a member has here is that the money left and the minutes did not arrive.
    /// The one case where money may genuinely have moved — <c>amount_mismatch</c> — says so and
    /// tells them what to send the club.
    /// </para>
    /// </remarks>
    /// <param name="currencySymbol">
    /// The club's own, from <see cref="Services.CurrencySymbol.For"/>. The only figure it
    /// denominates is the amount; "Minutes added: 0 minutes" takes no symbol.
    /// </param>
    public static EmailMessage PurchaseNotCompleted(ClubIdentity club, string to, PackagePurchaseAttempt a) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: a.FailureReason == "cancelled"
                ? $"Purchase cancelled — {a.PackageName}"
                : $"Purchase didn't go through — {a.PackageName}",
            Preheader: a.FailureReason == "amount_mismatch"
                ? "No minutes were added. Send the club the reference if money left your account."
                : "Nothing was charged and your balance has not changed.",
            Heading: a.FailureReason == "cancelled" ? "Your purchase was cancelled" : "Your purchase didn't go through",
            Blocks:
            [
                new Paragraph(PurchaseFailureSentence(a.FailureReason)),
                new Facts(
                [
                    new FactRow("Package", $"{a.PackageName} ({Min(a.Minutes)})"),
                    new FactRow("Amount", Zar(a.AmountZar, a.CurrencySymbol)),
                    new FactRow("Minutes added", Min(0)),
                    new FactRow("Reference", a.Reference),
                ]),
                new Callout(CalloutTone.Info, "Your wallet balance has not changed."),
            ],
            WhyThis: WhyMoney));

    /// <summary>
    /// Minutes the desk moved by hand — goodwill, a correction, a refund made outside the system.
    /// A member whose balance moves by somebody else's hand is told what moved and why.
    /// </summary>
    /// <remarks>
    /// The signed figure is written with a real sign on the whole value — "+1 hour",
    /// "−45 minutes" — the same convention every screen uses. A package sold at the desk is
    /// <see cref="PackageSoldAtDesk"/>, not this: that member handed over money.
    /// </remarks>
    public static EmailMessage MinutesAdjusted(
        ClubIdentity club, string to, int amountMinutes, int balanceAfterMinutes, string reason)
    {
        var added = amountMinutes >= 0;
        var size = Min(Math.Abs(amountMinutes));
        return EmailChrome.Compose(club, to, new EmailContent(
            Subject: added ? $"Minutes added — {size}" : $"Minutes taken off — {size}",
            Preheader: $"Your balance is now {Min(balanceAfterMinutes)}.",
            Heading: added ? "Minutes added to your wallet" : "Minutes taken off your wallet",
            Blocks:
            [
                new Paragraph($"An administrator at {club.Name} has adjusted your balance by hand."),
                new Facts(
                [
                    new FactRow("Amount", (added ? "+" : "−") + size),
                    new FactRow("Balance after", Min(balanceAfterMinutes)),
                    new FactRow("Reason given", reason),
                ]),
                new Paragraph("If that doesn't look right, reply to this email or speak to the desk. The movement stays on your wallet either way — a correction is a second line, never a deleted one."),
            ],
            WhyThis: WhyMoney));
    }

    /// <summary>
    /// A package the desk sold a member — cash, EFT or a card machine at the club. The member
    /// handed over money, so the amount received is stated in the club's own currency beside
    /// the minutes it bought.
    /// </summary>
    /// <remarks>
    /// The amount received is what the desk typed, which may differ from the package's price
    /// (contract §3.7) — this mail states what was received, not what the shelf says, because
    /// the member's own memory of the counter is what they will check it against.
    /// </remarks>
    public static EmailMessage PackageSoldAtDesk(ClubIdentity club, string to, DeskPackageSale sale) =>
        sale.NoCharge ? PackageGivenAtDesk(club, to, sale) : EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Minutes bought at the desk — {sale.PackageName}",
            Preheader: $"{Min(sale.Minutes)} added. Your balance is now {Min(sale.BalanceAfterMinutes)}.",
            Heading: "Your minutes are in",
            Blocks:
            [
                new Paragraph($"The desk at {club.Name} has sold you a package and the minutes are in your wallet. You can book a court now."),
                new Facts(
                [
                    new FactRow("Package", sale.PackageName),
                    new FactRow("Minutes added", Min(sale.Minutes)),
                    new FactRow("Amount received", Zar(sale.ZarReceived, sale.CurrencySymbol)),
                    new FactRow("Balance after", Min(sale.BalanceAfterMinutes)),
                ]),
                new Paragraph("If that doesn't match what you paid at the club, reply to this email or speak to the desk."),
            ],
            WhyThis: WhyMoney));

    /// <summary>
    /// A R0.00 package the desk handed over at no charge (review round 7, J7-10). Nothing was
    /// paid, so nothing here says it was — no "Amount received", no "what you paid".
    /// </summary>
    private static EmailMessage PackageGivenAtDesk(ClubIdentity club, string to, DeskPackageSale sale) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Minutes given at the desk — {sale.PackageName}",
            Preheader: $"{Min(sale.Minutes)} added at no charge. Your balance is now {Min(sale.BalanceAfterMinutes)}.",
            Heading: "Your minutes are in",
            Blocks:
            [
                new Paragraph($"The desk at {club.Name} has given you a package at no charge and the minutes are in your wallet. You can book a court now."),
                new Facts(
                [
                    new FactRow("Package", sale.PackageName),
                    new FactRow("Minutes added", Min(sale.Minutes)),
                    new FactRow("Charged", "Nothing — given at no charge"),
                    new FactRow("Balance after", Min(sale.BalanceAfterMinutes)),
                ]),
                new Paragraph("If that doesn't look right, reply to this email or speak to the desk."),
            ],
            WhyThis: WhyMoney));

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
                    new FactRow("Silent for", Min(alert.Minutes)),
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
                    new FactRow("Silent for", Min(alert.Minutes)),
                ]),
                new Callout(CalloutTone.Warning,
                    "The door has not stopped working, yet. While it cannot reach the club it falls back to the list it "
                    + "already holds, so it still opens for booked members and for nobody else. That list goes stale 6 hours "
                    + "after it was last received, and from then the door opens for nobody until it is back online."),
                new Footnote("Nothing about this affects money or play: a door gate records no attendance, and nothing is charged or given back because of one."),
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
        ClubIdentity club, string to, string courtName, int refundedMinutes) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Refunded — {courtName} was offline",
            Preheader: $"{Min(refundedMinutes)} back, no penalty. You have not been marked down for this.",
            Heading: "Your booking has been refunded in full",
            Blocks:
            [
                new Paragraph($"The court controller at {club.Name} was offline during your booking on {courtName}, so the lights could not be released against your name."),
                new Facts(
                [
                    new FactRow("Refunded", Min(refundedMinutes)),
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
        ClubIdentity club, string to, string courtName, int refundedMinutes) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Refunded — the box on {courtName} is out of service",
            Preheader: $"{Min(refundedMinutes)} back, no penalty. This refund is final.",
            Heading: "Your booking has been refunded in full",
            Blocks:
            [
                new Paragraph($"Nobody checked in on {courtName} at {club.Name} during your booking, and the box on that court is out of service — it could not open the court, and it will never send the club a record of anyone who played."),
                new Facts(
                [
                    new FactRow("Refunded", Min(refundedMinutes)),
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
