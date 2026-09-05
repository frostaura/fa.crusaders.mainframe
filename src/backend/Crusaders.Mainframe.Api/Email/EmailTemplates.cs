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
public sealed record BookingConfirmationDetails(
    string CourtName,
    string StartsAtLocal,
    string Duration,
    decimal AmountCredits,
    decimal BalanceAfterCredits,
    int PenaltyWindowMinutes,
    decimal PenaltyPct);

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
    /// <paramref name="amountCredits"/> and <paramref name="balanceAfterCredits"/> are
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
        Subject: $"Booking confirmed — {d.CourtName} {d.StartsAtLocal}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">You're booked</h2>
              <table style="border-collapse:collapse;font-size:14px">
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Court</td><td><strong>{d.CourtName}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Starts</td><td><strong>{d.StartsAtLocal}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Duration</td><td><strong>{d.Duration}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Charged</td><td><strong>{Cr(d.AmountCredits)}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Balance after</td><td><strong>{Cr(d.BalanceAfterCredits)}</strong></td></tr>
              </table>
              <p style="margin-top:16px;font-size:13px;color:#A16207">
                Heads-up: cancelling within {d.PenaltyWindowMinutes} minutes of the start, or not turning the lights on, incurs a {Num(d.PenaltyPct)}% penalty.
              </p>
              <p style="margin-top:16px;font-size:13px;color:#475569">Your receipt is attached.</p>
              {FooterHtml}
            </div>
            """,
        Attachments: receipt is null ? null : [receipt]);

    /// <summary>Both figures are <b>credits</b>. See <see cref="Cr"/>.</summary>
    public static EmailMessage BookingCancellation(string to, string courtName, decimal refundedCredits, decimal? penaltyCredits) => new(
        To: to,
        Subject: $"Booking cancelled — {courtName}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">Cancelled</h2>
              <p>Your booking on {courtName} has been cancelled.</p>
              <p>Refunded to your credit: <strong>{Cr(refundedCredits)}</strong>.</p>
              {(penaltyCredits is > 0 ? $"<p>Late-cancellation penalty applied: <strong>{Cr(penaltyCredits.Value)}</strong>.</p>" : "")}
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
              <p>Check its power and its WiFi. While it is dark, members on those courts cannot check in — bookings that pass their grace window are refunded in full with <strong>no no-show penalty</strong>, and the members are told why.</p>
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

    /// <summary>The all-clear, so an admin who was sent to a cupboard knows to stop looking.</summary>
    public static EmailMessage AdminPeripheralRecovered(string to, PeripheralAlert alert) => new(
        To: to,
        Subject: $"Court box back online — {alert.DeviceCode}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">The court box is reporting again</h2>
              <p><strong>{System.Net.WebUtility.HtmlEncode(alert.DeviceName)}</strong> ({System.Net.WebUtility.HtmlEncode(alert.DeviceCode)}) at {System.Net.WebUtility.HtmlEncode(alert.ClubName)} is back after {alert.Minutes} minutes.</p>
              <p style="font-size:13px;color:#475569">Anything the box recorded while it was offline uploads on its next few calls, so a member who did play during the outage still settles as attended.</p>
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

    /// <summary>Court numbers, for a sentence. "court 3" reads better than "[3]".</summary>
    private static string Courts(IReadOnlyList<int> courtNumbers)
    {
        if (courtNumbers.Count == 0) return "none recorded";
        var numbers = string.Join(", ", courtNumbers);
        return (courtNumbers.Count == 1 ? "court " : "courts ") + numbers;
    }
}
