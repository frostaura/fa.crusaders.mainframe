using System.Globalization;

namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// Minimal inline templates. Will graduate to Razor / MJML files once the count grows past a handful.
/// All templates take primitives only — no domain types — so they remain trivially testable.
/// </summary>
/// <summary>
/// Everything a booking confirmation states, as named members.
/// </summary>
/// <remarks>
/// Every figure here is <b>credits</b>. Credits are this system's unit of account and rand
/// exists only on the top-up row for reconciliation; a field that mixes the two is a
/// money-correctness bug by the repo's own invariants. <c>PenaltyWindowMinutes</c> and
/// <c>PenaltyPct</c> travel with them because the template used to hardcode "15 minutes / 30%"
/// and went on saying so after an admin moved the club to 30 minutes at 50%.
/// </remarks>
/// <param name="IsWalkUp">
/// Court time bought at the box rather than a reservation made ahead of it.
///
/// <para>
/// It changes what the mail is allowed to promise. A walk-up starts the instant it is bought —
/// <c>StartsAt = now</c>, and the same request activates the court — so the confirmation used to
/// tell a member standing under lit lights that cancelling would cost them 30% and return the
/// rest. It returns nothing: <c>settlement-model.md</c> S4 gives nothing back once someone has
/// checked in, and the server's own cancellation quote for these bookings answers
/// <c>refundCredits 0</c>. Defaulted to <c>false</c> so an ordinary booking keeps the penalty
/// heads-up it is entitled to.
/// </para>
/// </param>
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
/// The two things a member needs to know when the <b>club</b> cancelled their booking rather
/// than they themselves — who did it and why.
/// </summary>
/// <remarks>
/// <para>
/// An admin cancellation used to reach the member as a mail indistinguishable from one they
/// sent themselves: "Your booking on Court 4 has been cancelled. Refunded 50.00 credits." No
/// actor, no reason, and no mention that the penalty had been waived on their behalf — while
/// the audit row beside it carried all three. Email is the only channel the member has; the
/// schedule grid just shows the slot free again.
/// </para>
/// <para>
/// Its own record rather than three more positional parameters: <see cref="EmailTemplates.BookingCancellation"/>
/// would otherwise take seven, past the complexity gate's six, and every one of them a bool,
/// a string or a decimal that would transpose silently.
/// </para>
/// </remarks>
/// <param name="Reason">The waiver reason the admin typed, or null when they gave none.</param>
/// <param name="PenaltyWaived">
/// True when the club waived a penalty this cancellation would otherwise have carried — the
/// same <c>waived</c> flag the audit row records.
/// </param>
public sealed record ClubCancellation(string? Reason, bool PenaltyWaived);

/// <summary>
/// Everything the two peripheral alerts state, as named members — the same shape, and the same
/// reason, as <see cref="BookingConfirmationDetails"/>: seven loose parameters is past the
/// complexity gate's six, and a named member cannot be passed in the wrong position.
/// </summary>
/// <param name="Minutes">Silent-for, on the alert; outage length, on the all-clear.</param>
public sealed record PeripheralAlert(
    string DeviceName,
    string DeviceCode,
    IReadOnlyList<int> CourtNumbers,
    int Minutes,
    string ClubName,
    string ConsoleUrl);

/// <summary>
/// The same incident on a door gate, which is a different message rather than the same one
/// with a word changed.
///
/// <para>
/// It carries <see cref="GateKey"/> — the door's own name — and no court list, because a gate
/// drives none. Everything the court-box alert says about attendance, refunds and no-show
/// penalties is false about a door, so the two templates share no sentences and this record
/// deliberately cannot be passed to the court box's.
/// </para>
/// </summary>
public sealed record GateAlert(
    string DeviceName,
    string DeviceCode,
    string? GateKey,
    int Minutes,
    string ClubName,
    string ConsoleUrl);

public static class EmailTemplates
{
    /// <summary>
    /// Credits, for an email.
    ///
    /// <para>
    /// Every money email printed a rand sign over a credit figure — "Charged R50,00" for a
    /// court that cost the member R31.25 at the club's own 1.6 rate — which is the unit lie
    /// <c>CLAUDE.md</c> forbids, on the one artifact a member reconciles a bank statement
    /// against. Credits are the unit of account; rand appears in exactly one template, the
    /// top-up confirmation, because that is the only place a member actually paid rand.
    /// </para>
    ///
    /// <para>
    /// Invariant culture, so the separator is a dot on every host. It was the server
    /// process's ambient culture, which is how "−15.00 cr" and "penalty 30,0%" ended up in
    /// the same row of one member's ledger.
    /// </para>
    /// </summary>
    internal static string Cr(decimal value) => value.ToString("0.00", CultureInfo.InvariantCulture) + " credits";

    /// <summary>Rand. Only for amounts that really are rand — what the member paid the gateway.</summary>
    internal static string Zar(decimal value) => "R" + value.ToString("0.00", CultureInfo.InvariantCulture);

    /// <summary>A number with no trailing-zero noise, for percentages and rates. Invariant, as above.</summary>
    internal static string Num(decimal value) => value.ToString("0.####", CultureInfo.InvariantCulture);

    private const string FooterHtml =
        "<hr style='margin-top:24px;border:0;border-top:1px solid #E2E8F0' />" +
        "<p style='color:#94A3B8;font-size:12px;font-family:Figtree,sans-serif'>You received this because you registered for Crusaders Mainframe. " +
        "If this wasn't you, please ignore this email.</p>";

    public static EmailMessage VerifyEmail(string to, string verifyUrl) => new(
        To: to,
        Subject: "Verify your email — Crusaders Mainframe",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">One more step</h2>
              <p>Confirm your email address to finish your registration. The link expires in 24 hours.</p>
              <p style="margin:24px 0">
                <a href="{verifyUrl}"
                   style="display:inline-block;background:#0369A1;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
                  Verify email
                </a>
              </p>
              <p style="font-size:12px;color:#94A3B8">Or paste this into your browser: {verifyUrl}</p>
              {FooterHtml}
            </div>
            """);

    public static EmailMessage MembershipPending(string to) => new(
        To: to,
        Subject: "Your membership is pending review",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">Thanks — we've got your details</h2>
              <p>An admin will review your registration and get back to you. You'll get an email either way.</p>
              {FooterHtml}
            </div>
            """);

    public static EmailMessage MembershipApproved(string to, string magicLinkUrl, string clubName) => new(
        To: to,
        Subject: $"Welcome to {clubName}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">You're in</h2>
              <p>Your membership at {clubName} is approved. Tap below to sign in — the link expires in 15 minutes.</p>
              <p style="margin:24px 0">
                <a href="{magicLinkUrl}"
                   style="display:inline-block;background:#15803D;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
                  Sign in
                </a>
              </p>
              {FooterHtml}
            </div>
            """);

    public static EmailMessage MembershipRejected(string to, string reason, string clubName) => new(
        To: to,
        Subject: $"Your membership application — {clubName}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">We couldn't approve your application</h2>
              <p>{System.Net.WebUtility.HtmlEncode(reason)}</p>
              <p style="color:#475569;font-size:14px">If you think this is a mistake, please reach out to the club committee.</p>
              {FooterHtml}
            </div>
            """);

    public static EmailMessage MembershipSuspended(string to, string fullName, string reason, string clubName) => new(
        To: to,
        Subject: $"Your {clubName} membership is suspended",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">Hi {fullName},</h2>
              <p>Your membership at {clubName} has been suspended, so you can't sign in, book a court or open a court with your fingerprint, PIN or code for now.</p>
              <p style="background:#FEF3C7;border:1px solid #FDE68A;border-radius:8px;padding:12px 14px"><strong>Reason:</strong> {reason}</p>
              <p style="color:#475569">Your credit balance and your existing bookings are untouched. Speak to the club office to have the suspension lifted.</p>
              {FooterHtml}
            </div>
            """);

    public static EmailMessage MembershipReactivated(string to, string fullName, string clubName) => new(
        To: to,
        Subject: $"Your {clubName} membership is active again",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">Hi {fullName},</h2>
              <p>Your membership at {clubName} has been reactivated. You can sign in, book courts and open a court at the box again — your credit balance is exactly as you left it.</p>
              {FooterHtml}
            </div>
            """);

    /// <summary>
    /// The club desk's copy of a new registration (spec §2.3). Sent to each admin user of
    /// the tenant, not to the applicant — the applicant gets <see cref="MembershipPending"/>.
    /// </summary>
    public static EmailMessage AdminNewRegistration(string to, string fullName, string applicantEmail, string membershipNumber, string clubName, string consoleUrl) => new(
        To: to,
        Subject: $"New membership application — {fullName}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">A new application is waiting</h2>
              <p>Somebody has registered for {clubName} and is waiting for approval.</p>
              <table style="border-collapse:collapse;margin:16px 0;font-size:14px">
                <tr><td style="padding:4px 16px 4px 0;color:#64748B">Name</td><td style="padding:4px 0"><strong>{fullName}</strong></td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#64748B">Email</td><td style="padding:4px 0">{applicantEmail}</td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#64748B">Membership number</td><td style="padding:4px 0">{membershipNumber}</td></tr>
              </table>
              <p style="margin:24px 0">
                <a href="{consoleUrl}"
                   style="display:inline-block;background:#0369A1;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
                  Review applications
                </a>
              </p>
              <p style="font-size:12px;color:#94A3B8">Or paste this into your browser: {consoleUrl}</p>
            </div>
            """);

    public static EmailMessage PasswordReset(string to, string resetUrl) => new(
        To: to,
        Subject: "Reset your password — Crusaders Mainframe",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">Reset request</h2>
              <p>Tap below to set a new password. Link expires in 1 hour. If you didn't request this, ignore this email.</p>
              <p style="margin:24px 0">
                <a href="{resetUrl}"
                   style="display:inline-block;background:#0369A1;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
                  Reset password
                </a>
              </p>
              {FooterHtml}
            </div>
            """);

    public static EmailMessage AdminPasswordReset(string to, string fullName, string tempPassword) => new(
        To: to,
        Subject: "Your password was reset by an admin — Crusaders Mainframe",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">Hi {fullName},</h2>
              <p>An administrator has reset your password. Sign in with the temporary password below — you'll be asked to choose your own straight away, and this one stops working the moment you do.</p>
              <p style="margin:24px 0;font-size:18px;font-weight:600;letter-spacing:1px;
                        background:#F1F5F9;border:1px solid #E2E8F0;border-radius:8px;padding:14px 18px;display:inline-block">
                {tempPassword}
              </p>
              <p style="color:#475569">If you didn't ask for this, contact the club committee.</p>
              {FooterHtml}
            </div>
            """);

    /// <summary>
    /// Confirms a self-service password change. The one signal a member has that somebody else
    /// changed it — which is why it goes out even though the member just did it themselves.
    /// </summary>
    public static EmailMessage PasswordChanged(string to) => new(
        To: to,
        Subject: "Your password was changed — Crusaders Mainframe",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">Password changed</h2>
              <p>Your Crusaders Mainframe password was just changed. If that was you, there's nothing to do.</p>
              <p style="color:#475569">If it wasn't, contact the club committee straight away — someone else has access to your account.</p>
              {FooterHtml}
            </div>
            """);

    /// <summary>
    /// The one sentence a member needs when the club desk has booked for them under
    /// <c>feature-spec.md</c> §8's override and their balance is now below zero.
    ///
    /// <para>
    /// Without it the confirmation states "Balance after: −40,00 credits" and nothing
    /// else — a negative number with no account of itself, on the artifact a member
    /// reconciles against. The club took the booking deliberately and the member is owed
    /// the reason, not just the figure. Empty on every ordinary booking, so nothing that
    /// is not an overdraft acquires an explanation for one.
    /// </para>
    /// </summary>
    private static string OverdrawnNoticeHtml(decimal balanceAfterCredits) =>
        balanceAfterCredits >= 0 ? "" : $"""
            <p style="margin-top:16px;font-size:13px;color:#B91C1C">
              This booking was made for you at the club and takes your balance to
              <strong>{Cr(balanceAfterCredits)}</strong>. Top up to clear it — the amount owing comes
              off your next top-up.
            </p>
            """;

    /// <summary>
    /// <c>AmountCredits</c> and <c>BalanceAfterCredits</c> on <paramref name="d"/> are
    /// <b>credits</b>, and the penalty policy is the tenant's, not a literal: the previous
    /// template hardcoded "within 15 minutes … 30%" and went on saying it after an admin had
    /// moved the club to 30 minutes at 50%.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Takes a <see cref="BookingConfirmationDetails"/> rather than seven positional parameters.
    /// Seven was already over the complexity gate's argument limit, and every one of them is a
    /// decimal, an int or a string, so a transposed pair — the charge and the balance, the
    /// penalty window and the penalty percentage — would have compiled and shipped a wrong
    /// number to a member. Named members make that transposition a compile error.
    /// </para>
    /// <para>
    /// The receipt is an <b>attachment</b> and not a link, deliberately: a link to a receipt is a
    /// link that needs a session, and the member who most wants one is forwarding the mail to
    /// somebody who has not got one. It is optional so a missing receipt is a message with no
    /// attachment rather than a failed send.
    /// </para>
    /// </remarks>
    public static EmailMessage BookingConfirmation(
        string to, BookingConfirmationDetails d, EmailAttachment? receipt = null) => new(
        To: to,
        Subject: d.IsWalkUp
            ? $"Court time started — {d.CourtName} {d.StartsAtLocal}"
            : $"Booking confirmed — {d.CourtName} {d.StartsAtLocal}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">{(d.IsWalkUp ? "You're on court" : "You're booked")}</h2>
              <table style="border-collapse:collapse;font-size:14px">
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Court</td><td><strong>{d.CourtName}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">{(d.IsWalkUp ? "Started" : "Starts")}</td><td><strong>{d.StartsAtLocal}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Duration</td><td><strong>{d.Duration}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Charged</td><td><strong>{Cr(d.AmountCredits)}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Balance after</td><td><strong>{Cr(d.BalanceAfterCredits)}</strong></td></tr>
              </table>
              {OverdrawnNoticeHtml(d.BalanceAfterCredits)}
              {CancellationTermsHtml(d)}
              <p style="margin-top:16px;font-size:13px;color:#475569">Your receipt is attached.</p>
              {FooterHtml}
            </div>
            """,
        Attachments: receipt is null ? null : [receipt]);

    /// <summary>
    /// What this particular booking can still be cancelled for — the one paragraph of the
    /// confirmation that is a promise about money.
    /// </summary>
    /// <remarks>
    /// A walk-up gets the other sentence. It is bought at the box, starts immediately and
    /// activates the court in the same request, so the penalty line offered a member already
    /// under the lights 70% of their money back for cancelling; the server refunds nothing
    /// (<c>settlement-model.md</c> S4, and the cancellation quote's own <c>refundCredits 0</c>).
    /// Neither half of the old sentence was true for one: the lights are on, and the 30% figure
    /// describes a refund that does not happen.
    /// </remarks>
    private static string CancellationTermsHtml(BookingConfirmationDetails d)
    {
        if (d.IsWalkUp)
        {
            return """
                <p style="margin-top:16px;font-size:13px;color:#A16207">
                  This is court time bought at the box, so it has already started.
                  Court time is not refunded once the lights have been on, and there is nothing to cancel.
                </p>
                """;
        }

        return $"""
            <p style="margin-top:16px;font-size:13px;color:#A16207">
              Heads-up: cancelling within {d.PenaltyWindowMinutes} minutes of the start, or not turning the lights on, incurs a {Num(d.PenaltyPct)}% penalty.
            </p>
            """;
    }

    /// <summary>
    /// A walk-up the court would not open, and the money already back.
    ///
    /// <remarks>
    /// <para>
    /// Its own message rather than the cancellation one, because nobody cancelled anything:
    /// the member pressed a button, the API took the credits, the activation refused, and the
    /// API put them back inside the same request. "The club cancelled your booking. You did
    /// not do this." would be three untrue sentences about an event that lasted a second.
    /// </para>
    /// <para>
    /// It exists at all because of the invariant that every player-affecting event reaches the
    /// member: the alternative was a debit and a credit appearing on <c>/wallet</c> with no
    /// explanation between them, for a member who is standing at a box reading COURT NOT FREE.
    /// The figure is the <b>gross</b> refund, which is also the whole price — there is no
    /// penalty leg on a court that was never lit. A court priced at zero has no figure to
    /// print and gets the shorter sentence: I10 writes no zero ledger row, so quoting "0.00
    /// credits" here would name a movement that is not on the statement.
    /// </para>
    /// </remarks>
    public static EmailMessage WalkUpNotStarted(string to, string courtName, decimal refundedCredits) => new(
        To: to,
        Subject: $"Court time not started — {courtName}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">Nothing was bought</h2>
              <p>The box could not start {System.Net.WebUtility.HtmlEncode(courtName)} for you, so the court time you pressed for was not sold.</p>
              {(refundedCredits > 0
                  ? $"<p>Put back on your credit: <strong>{Cr(refundedCredits)}</strong>. Your balance is where it was before you pressed.</p>"
                  : "<p>Nothing was taken off your credit.</p>")}
              <p>Try again at the box, or ask at the desk.</p>
              {FooterHtml}
            </div>
            """);

    /// <summary>
    /// A cancelled booking, in the member's mail. Both figures are <b>credits</b>; see <see cref="Cr"/>.
    /// </summary>
    /// <remarks>
    /// <paramref name="refundedCredits"/> is the <b>gross</b> refund — the <c>CancellationRefund</c>
    /// row exactly as the ledger holds it, never that row less the penalty. I11 forbids netting,
    /// so a mail quoting a net figure names a number the member cannot find on <c>/wallet</c>, and
    /// read as English beside the penalty line it double-counts the deduction.
    /// <paramref name="byClub"/> is null when the member cancelled it themselves.
    /// </remarks>
    public static EmailMessage BookingCancellation(
        string to, string courtName, decimal refundedCredits, decimal? penaltyCredits,
        ClubCancellation? byClub = null) => new(
        To: to,
        Subject: byClub is null ? $"Booking cancelled — {courtName}" : $"The club cancelled your booking — {courtName}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">{(byClub is null ? "Cancelled" : "Cancelled by the club")}</h2>
              <p>{(byClub is null
                  ? $"Your booking on {System.Net.WebUtility.HtmlEncode(courtName)} has been cancelled."
                  : $"The club cancelled your booking on {System.Net.WebUtility.HtmlEncode(courtName)} on your behalf. You did not do this.")}</p>
              {ClubReasonHtml(byClub)}
              <p>Refunded to your credit: <strong>{Cr(refundedCredits)}</strong>.</p>
              {(penaltyCredits is > 0 ? $"<p>Late-cancellation penalty applied: <strong>{Cr(penaltyCredits.Value)}</strong>.</p>" : "")}
              {(byClub is { PenaltyWaived: true } ? "<p>The late-cancellation penalty was waived, so nothing was deducted for it.</p>" : "")}
              {FooterHtml}
            </div>
            """);

    /// <summary>
    /// The reason an admin typed when cancelling on a member's behalf, or nothing when they gave
    /// none. Encoded, because it is free text an admin wrote into a mail sent to somebody else.
    /// </summary>
    private static string ClubReasonHtml(ClubCancellation? byClub)
    {
        var reason = byClub?.Reason?.Trim();
        if (string.IsNullOrEmpty(reason)) return "";
        return $"""<p>Reason given by the club: <strong>{System.Net.WebUtility.HtmlEncode(reason)}</strong>.</p>""";
    }

    /// <summary>
    /// A booking swept as a no-show — <c>feature-spec.md</c> §11's "No-show with penalty", which
    /// is a required email in its own right and had been borrowing the cancellation one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Borrowing it was wrong on four counts at once, all money-facing: the mail was headed
    /// "Cancelled" for something the member never cancelled, the court was renamed
    /// "Court 3 (no-show)", a <c>NoShowPenalty</c> was labelled a <b>late-cancellation</b>
    /// penalty, and the refund quoted was the penalty already subtracted — a figure that
    /// appears nowhere in the ledger, which holds the two legs I11 requires
    /// (<c>CancellationRefund +50.00</c> and <c>NoShowPenalty −15.00</c>) and no netted row.
    /// </para>
    /// <para>
    /// <paramref name="refundedCredits"/> is therefore the gross leg, and the two figures are
    /// stated as the two movements they are. No netted total is printed either: 35.00 is
    /// precisely the number that started this, and the balance the member is left with is on
    /// <c>/wallet</c>, computed the only way this system computes one — by summing the rows.
    /// </para>
    /// </remarks>
    public static EmailMessage BookingNoShow(string to, string courtName, decimal refundedCredits, decimal penaltyCredits) => new(
        To: to,
        Subject: $"Missed booking — {courtName}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">You missed this booking</h2>
              <p>Nobody was identified at the court for your booking on {System.Net.WebUtility.HtmlEncode(courtName)} before the grace window closed, so it was released and marked as a no-show.</p>
              <table style="border-collapse:collapse;margin:16px 0;font-size:14px">
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Booking refunded</td><td><strong>{Cr(refundedCredits)}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">No-show penalty</td><td><strong>{(penaltyCredits > 0 ? Cr(-penaltyCredits) : "None")}</strong></td></tr>
              </table>
              <p style="font-size:13px;color:#475569">Both movements appear separately in your wallet — the refund and the penalty are two rows, not one. If you were at the court and could not get the lights on, tell the club and they can reverse this.</p>
              {FooterHtml}
            </div>
            """);

    /// <summary>
    /// Top-up confirmation — <c>feature-spec.md</c> §11 has required this since the spec was
    /// written and nothing sent it, so the one event where a member hands over real money
    /// produced no email at all. This is the single template that legitimately shows both
    /// units: rand is what left their card, credits are what arrived in the wallet, and the
    /// rate between them is the number a dispute turns on.
    /// </summary>
    public static EmailMessage TopUpConfirmation(
        string to, decimal amountZar, decimal creditsAdded, decimal conversionRate, decimal balanceAfterCredits, string reference) => new(
        To: to,
        Subject: $"Top-up confirmed — {Cr(creditsAdded)}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">Your wallet has been topped up</h2>
              <table style="border-collapse:collapse;font-size:14px">
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Paid</td><td><strong>{Zar(amountZar)}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Rate</td><td><strong>{Num(conversionRate)} credits per R1</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Credited</td><td><strong>{Cr(creditsAdded)}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Balance after</td><td><strong>{Cr(balanceAfterCredits)}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Reference</td><td>{System.Net.WebUtility.HtmlEncode(reference)}</td></tr>
              </table>
              <p style="margin-top:16px;font-size:13px;color:#475569">
                Credits are what you book court time with. Rand is only the payment rail.
              </p>
              {FooterHtml}
            </div>
            """);

    /// <summary>
    /// What a member is told when a top-up ended in anything but credits.
    ///
    /// <para>
    /// The sentences are the same ones <c>TopUpStatus.tsx</c> renders from the same stable
    /// codes, deliberately: a member who reads the screen and a member who reads the mail must
    /// not be told two different things about one payment. Codes never appear in the output —
    /// the column once held <c>amount_mismatch:reported=100,00:expected=500,00</c> and it was
    /// shown verbatim to a member as the explanation for a failed R500 payment.
    /// </para>
    /// </summary>
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
                return "PayFast couldn't complete the payment and nothing was charged. Try again in a few minutes.";
        }
    }

    /// <summary>
    /// A top-up that ended without credits — declined, cancelled at the gateway, or settled
    /// for an amount other than the one it was registered for.
    ///
    /// <para>
    /// <c>feature-spec.md</c> §11's governing sentence is that every player-affecting event
    /// sends an email, and this is the only terminal outcome of a member handing over card
    /// details that sent nothing at all: a member who closed the tab after PayFast learnt
    /// what happened to their money only by finding the status page again. The status screen
    /// promises this mail in as many words ("we'll email you either way") on the branch where
    /// it cannot reach the club — which is precisely the branch where the mail is the only
    /// channel left.
    /// </para>
    ///
    /// <para>
    /// It states the amount and says nothing was charged where that is true, because the fear
    /// a member has here is that the money left and the credits did not arrive. The one case
    /// where money may genuinely have moved — <c>amount_mismatch</c> — says so and tells them
    /// what to send the club.
    /// </para>
    /// </summary>
    public static EmailMessage TopUpNotCompleted(
        string to, decimal amountZar, string? failureReason, string reference) => new(
        To: to,
        Subject: failureReason == "cancelled"
            ? $"Top-up cancelled — {Zar(amountZar)}"
            : $"Top-up didn't go through — {Zar(amountZar)}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">{(failureReason == "cancelled" ? "Your top-up was cancelled" : "Your top-up didn't go through")}</h2>
              <table style="border-collapse:collapse;font-size:14px">
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Amount</td><td><strong>{Zar(amountZar)}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Credited</td><td><strong>{Cr(0m)}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Reference</td><td>{System.Net.WebUtility.HtmlEncode(reference)}</td></tr>
              </table>
              <p style="margin-top:16px">{System.Net.WebUtility.HtmlEncode(TopUpFailureSentence(failureReason))}</p>
              <p style="margin-top:16px;font-size:13px;color:#475569">
                Your wallet balance has not changed.
              </p>
              {FooterHtml}
            </div>
            """);

    /// <summary>
    /// A manual credit adjustment by the desk — the other half of <c>feature-spec.md</c>
    /// §11's "Refund / credit adjustment", which also sent nothing. A member whose balance
    /// moves by someone else's hand is told what moved and why.
    /// </summary>
    public static EmailMessage CreditAdjustment(
        string to, decimal amountCredits, decimal balanceAfterCredits, string reason) => new(
        To: to,
        Subject: amountCredits >= 0
            ? $"Credit added — {Cr(amountCredits)}"
            : $"Credit deducted — {Cr(Math.Abs(amountCredits))}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">{(amountCredits >= 0 ? "Credits added to your wallet" : "Credits deducted from your wallet")}</h2>
              <table style="border-collapse:collapse;font-size:14px">
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Amount</td><td><strong>{(amountCredits >= 0 ? "+" : "−")}{Cr(Math.Abs(amountCredits))}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Balance after</td><td><strong>{Cr(balanceAfterCredits)}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Reason</td><td>{System.Net.WebUtility.HtmlEncode(reason)}</td></tr>
              </table>
              <p style="margin-top:16px;font-size:13px;color:#475569">
                A club administrator made this adjustment. If it doesn't look right, reply to this email or speak to the desk.
              </p>
              {FooterHtml}
            </div>
            """);

    /// <summary>
    /// The club's admins, told a court box has gone quiet — <c>feature-spec.md</c> §6a's
    /// "admin gets a high-priority alert".
    ///
    /// <para>
    /// It names the courts rather than only the box, because that is what the admin has to
    /// decide about: a dark box on courts 1 and 2 means two courts nobody can light, and the
    /// desk needs to know which two before it can put a sign on a door.
    /// </para>
    /// </summary>
    public static EmailMessage AdminPeripheralUnhealthy(string to, PeripheralAlert alert) => new(
        To: to,
        Subject: $"Court box not reporting — {alert.DeviceCode}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">A court box has stopped reporting</h2>
              <p><strong>{System.Net.WebUtility.HtmlEncode(alert.DeviceName)}</strong> at {System.Net.WebUtility.HtmlEncode(alert.ClubName)} last called home {alert.Minutes} minutes ago.</p>
              <table style="border-collapse:collapse;margin:16px 0;font-size:14px">
                <tr><td style="padding:4px 16px 4px 0;color:#64748B">Box</td><td style="padding:4px 0"><strong>{System.Net.WebUtility.HtmlEncode(alert.DeviceCode)}</strong></td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#64748B">Courts</td><td style="padding:4px 0">{Courts(alert.CourtNumbers)}</td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#64748B">Silent for</td><td style="padding:4px 0">{alert.Minutes} minutes</td></tr>
              </table>
              <p><strong>Check its WiFi and its network first — do not power-cycle it yet.</strong> A box that has lost only its uplink keeps lighting courts from the roster it already holds, and it holds those scans in memory until it can upload them. Cutting the power discards them, and every court it lit during the outage then settles as if nobody played.</p>
              <p>While it is dark, members on those courts may not be able to check in — bookings that pass their grace window are refunded in full with <strong>no no-show penalty</strong>, and the members are told why.</p>
              <p style="margin:24px 0">
                <a href="{alert.ConsoleUrl}"
                   style="display:inline-block;background:#B91C1C;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
                  Open the Devices page
                </a>
              </p>
              <p style="font-size:12px;color:#94A3B8">Or paste this into your browser: {alert.ConsoleUrl}</p>
            </div>
            """,
        HighPriority: true);

    /// <summary>
    /// A door gate has stopped reporting.
    ///
    /// <para>
    /// <b>It shares not one sentence with the court box's alert, and that is the point of it
    /// existing.</b> A silent gate used to send that one: "Court box not reporting", members
    /// on "those courts" may not be able to check in, bookings past their grace window
    /// refunded with no no-show penalty. Every clause is false about a door — a gate drives no
    /// courts, stamps no attendance, and is invisible to the settlement model, so nothing is
    /// refunded and no penalty is waived. An admin acting on it goes looking for a court box
    /// that is working, and the door stays shut.
    /// </para>
    ///
    /// <para>
    /// What IS true is the degraded mode, and it is worth stating because it has a deadline in
    /// it: a door that has lost the server still admits members with a booking on the roster
    /// it already holds, and admits nobody at all once that roster goes stale six hours after
    /// it was fetched. The club has that long before the door stops working entirely.
    /// </para>
    ///
    /// <para>
    /// The power-cycle warning the court box's alert leads with is deliberately absent: a gate
    /// queues door opens rather than attendance, so nothing a club can be charged for is lost
    /// by restarting one.
    /// </para>
    /// </summary>
    public static EmailMessage AdminGateUnhealthy(string to, GateAlert alert) => new(
        To: to,
        Subject: $"Door gate not reporting — {alert.DeviceCode}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">A door gate has stopped reporting</h2>
              <p><strong>{System.Net.WebUtility.HtmlEncode(alert.DeviceName)}</strong> at {System.Net.WebUtility.HtmlEncode(alert.ClubName)} last called home {alert.Minutes} minutes ago.</p>
              <table style="border-collapse:collapse;margin:16px 0;font-size:14px">
                <tr><td style="padding:4px 16px 4px 0;color:#64748B">Board</td><td style="padding:4px 0"><strong>{System.Net.WebUtility.HtmlEncode(alert.DeviceCode)}</strong></td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#64748B">Door</td><td style="padding:4px 0">{Door(alert.GateKey)}</td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#64748B">Silent for</td><td style="padding:4px 0">{alert.Minutes} minutes</td></tr>
              </table>
              <p><strong>The door has not stopped working, yet.</strong> While it cannot reach us it falls back to the list it already holds, so it still opens for booked members — and for nobody else. That list goes stale <strong>6 hours</strong> after it was last received, and from then the door opens for nobody until it is back online.</p>
              <p style="font-size:13px;color:#475569">Nothing about this affects money or play: a door gate records no attendance and nothing is charged or credited because of one.</p>
              <p style="font-size:13px;color:#475569">Getting <em>out</em> of the building never depends on this board, its power, or us.</p>
              <p style="margin:24px 0">
                <a href="{alert.ConsoleUrl}"
                   style="display:inline-block;background:#B91C1C;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
                  Open the Devices page
                </a>
              </p>
              <p style="font-size:12px;color:#94A3B8">Or paste this into your browser: {alert.ConsoleUrl}</p>
            </div>
            """,
        HighPriority: true);

    /// <summary>
    /// The door's all-clear. Separate from the court box's for the same reason as above: that
    /// one promises queued scans will upload and settle as attended, and that lit time is
    /// otherwise refunded. A door queues neither.
    /// </summary>
    public static EmailMessage AdminGateRecovered(string to, GateAlert alert) => new(
        To: to,
        Subject: $"Door gate back online — {alert.DeviceCode}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">The door gate is reporting again</h2>
              <p><strong>{System.Net.WebUtility.HtmlEncode(alert.DeviceName)}</strong> ({System.Net.WebUtility.HtmlEncode(alert.DeviceCode)}) at {System.Net.WebUtility.HtmlEncode(alert.ClubName)} is back after {alert.Minutes} minutes.</p>
              <p style="font-size:13px;color:#475569">It has a current list again, so it is open to every member it should be. Any opens it decided on its own while it was away upload on its next few calls, for the record only.</p>
              <p style="margin:24px 0">
                <a href="{alert.ConsoleUrl}"
                   style="display:inline-block;background:#0369A1;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
                  Open the Devices page
                </a>
              </p>
            </div>
            """);

    /// <summary>
    /// The door's name for an admin, or an honest stand-in. A gate nobody has named yet has no
    /// offline fallback either, so "not named yet" is the actionable half of this alert rather
    /// than a blank cell.
    /// </summary>
    private static string Door(string? gateKey) =>
        string.IsNullOrWhiteSpace(gateKey)
            ? "<em>not named yet</em>"
            : $"<strong>{System.Net.WebUtility.HtmlEncode(gateKey)}</strong>";

    /// <summary>The all-clear, so an admin who was sent to a cupboard knows to stop looking.</summary>
    public static EmailMessage AdminPeripheralRecovered(string to, PeripheralAlert alert) => new(
        To: to,
        Subject: $"Court box back online — {alert.DeviceCode}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">The court box is reporting again</h2>
              <p><strong>{System.Net.WebUtility.HtmlEncode(alert.DeviceName)}</strong> ({System.Net.WebUtility.HtmlEncode(alert.DeviceCode)}) at {System.Net.WebUtility.HtmlEncode(alert.ClubName)} is back after {alert.Minutes} minutes.</p>
              <p style="font-size:13px;color:#475569">Anything the box recorded while it was offline uploads on its next few calls <strong>if it stayed powered</strong>, and a member who did play during the outage then settles as attended. If it lost power or was restarted, those scans are gone: courts it lit are refunded in full and the club carries them.</p>
              <p style="margin:24px 0">
                <a href="{alert.ConsoleUrl}"
                   style="display:inline-block;background:#0369A1;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
                  Open the Devices page
                </a>
              </p>
            </div>
            """);

    /// <summary>
    /// What a member is told when their booking was swept while the court's own box was
    /// unreachable — <c>feature-spec.md</c> §6a, <c>settlement-model.md</c> S5a.
    ///
    /// <para>
    /// A distinct template rather than the no-show notice with a softer sentence. The
    /// no-show notice says the member did not turn up and quotes a penalty; this member may
    /// well have been standing at a dark court, and telling them they were a no-show is the
    /// club blaming them for its own hardware.
    /// </para>
    /// </summary>
    public static EmailMessage BookingRefundedForOutage(
        string to, string courtName, decimal refundedCredits, string clubName) => new(
        To: to,
        Subject: $"Refunded — {courtName} was offline",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">Your booking has been refunded in full</h2>
              <p>The court controller at {System.Net.WebUtility.HtmlEncode(clubName)} was offline during your booking on <strong>{System.Net.WebUtility.HtmlEncode(courtName)}</strong>, so the lights could not be released against your name.</p>
              <table style="border-collapse:collapse;margin:16px 0;font-size:14px">
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Refunded</td><td><strong>{Cr(refundedCredits)}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Penalty</td><td><strong>None</strong></td></tr>
              </table>
              <p style="font-size:13px;color:#475569">You have not been marked down for missing it, and nothing has been deducted. If you did get onto the court, the box uploads its record when it reconnects and the booking settles as attended — the refund is reversed and you are charged the original price, with no penalty either way.</p>
              {FooterHtml}
            </div>
            """);

    /// <summary>
    /// The same waiver, for the branch where the court's hardware is switched off rather than
    /// merely quiet — <c>DeviceOutageIndex.CourtDarkness.OutOfService</c>.
    ///
    /// <para>
    /// It exists because of one sentence the outage notice makes and this one cannot: "the box
    /// uploads its record when it reconnects and the booking settles as attended". That is the
    /// S6 reversal, and it is real while the board is in service. A board an admin has taken out
    /// of service is refused 403 on all five <c>/api/v1/device/*</c> routes, <c>/events</c> among
    /// them, so nothing it is holding will ever be accepted and the settlement cannot be reversed by
    /// the box. Repeating the promise here would tell a member who did get onto the court to
    /// wait for a correction that is not coming, and send them to the desk a week later instead
    /// of today.
    /// </para>
    ///
    /// <para>
    /// What the two mails share is the part that is true either way: the court could not be
    /// released against their name, the charge is fully back, and no penalty was taken.
    /// </para>
    ///
    /// <para>
    /// <b>The opening sentence has now been wrong twice, in two different ways, and this is the
    /// second correction.</b> It first said "No court box was answering on {court} during your
    /// booking", which recording the switch-off instant made false: a court is out of service from
    /// the click, not from the point the board's silence passed <c>offline_after_seconds</c>, so
    /// the board this mail is sent about may have been answering perfectly a minute before the
    /// grace window closed and was simply switched off. Its replacement said that <i>no check-in
    /// on that court could have reached the club</i>, and that is false too: the three
    /// <c>/api/v1/court/{n}/…</c> routes — PIN, QR and biometric at the shared courtside terminal
    /// — resolve a <c>Courts.CourtNumber</c>, never look at a device row, and still set
    /// <c>CheckedInAt</c>. Telling a member that nothing they did could have reached the club is
    /// telling them something untrue about their own evening.
    /// </para>
    ///
    /// <para>
    /// So the sentence now claims only what is true of the BOX, which is the thing the club
    /// actually switched off: it could not open the court, and it will never report anyone who
    /// played. Both halves are the same 403 on the four <c>/api/v1/device/*</c> routes, and the
    /// second is what earns the "this refund is final" sentence below. Why the waiver is right
    /// even though the terminal stayed open is argued in <c>settlement-model.md</c> S5a, not here.
    /// See <c>DeviceOutageIndex.DoorWasShutFor</c>, and
    /// <c>Every_sentence_of_the_out_of_service_waiver_mail</c>, which pins each sentence here.
    /// </para>
    /// </summary>
    public static EmailMessage BookingRefundedForOutOfServiceBox(
        string to, string courtName, decimal refundedCredits, string clubName) => new(
        To: to,
        Subject: $"Refunded — the box on {courtName} is out of service",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">Your booking has been refunded in full</h2>
              <p>Nobody checked in on <strong>{System.Net.WebUtility.HtmlEncode(courtName)}</strong> at {System.Net.WebUtility.HtmlEncode(clubName)} during your booking, and the box on that court is out of service — it could not open the court, and it will never send the club a record of anyone who played.</p>
              <table style="border-collapse:collapse;margin:16px 0;font-size:14px">
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Refunded</td><td><strong>{Cr(refundedCredits)}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Penalty</td><td><strong>None</strong></td></tr>
              </table>
              <p style="font-size:13px;color:#475569">You have not been marked down for missing it, and nothing has been deducted. Because that box is out of service it will not send the club anything further, so this refund is final — if you did get onto the court, please tell the desk rather than waiting for it to correct itself.</p>
              {FooterHtml}
            </div>
            """);

    /// <summary>Court numbers, for a sentence. "court 3" reads better than "[3]".</summary>
    private static string Courts(IReadOnlyList<int> courtNumbers)
    {
        if (courtNumbers.Count == 0) return "none recorded";
        var numbers = string.Join(", ", courtNumbers);
        return (courtNumbers.Count == 1 ? "court " : "courts ") + numbers;
    }
}
