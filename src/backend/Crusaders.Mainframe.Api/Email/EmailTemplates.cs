using System.Globalization;

namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// Minimal inline templates. Will graduate to Razor / MJML files once the count grows past a handful.
/// All templates take primitives only — no domain types — so they remain trivially testable.
/// </summary>
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

    /// <summary>
    /// Tells a tenant admin that an application is waiting. Spec §2.3 has always required it and
    /// nothing sent it — both registration mails went to the applicant.
    /// </summary>
    public static EmailMessage MembershipPendingAdminNotice(string to, string fullName, string applicantEmail, string membershipNumber, string clubName, string reviewUrl) => new(
        To: to,
        Subject: $"New membership application — {clubName}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">Someone's waiting on you</h2>
              <p>A new application needs review at {System.Net.WebUtility.HtmlEncode(clubName)}.</p>
              <p style="margin:16px 0;background:#F1F5F9;border:1px solid #E2E8F0;border-radius:8px;padding:14px 18px">
                <b>{System.Net.WebUtility.HtmlEncode(fullName)}</b><br />
                {System.Net.WebUtility.HtmlEncode(applicantEmail)}<br />
                Membership number {System.Net.WebUtility.HtmlEncode(membershipNumber)}
              </p>
              <p style="margin:24px 0">
                <a href="{reviewUrl}"
                   style="display:inline-block;background:#0369A1;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
                  Review applications
                </a>
              </p>
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
    public static EmailMessage BookingConfirmation(
        string to, string courtName, string startsAtLocal, string duration,
        decimal amountCredits, decimal balanceAfterCredits,
        int penaltyWindowMinutes, decimal penaltyPct) => new(
        To: to,
        Subject: $"Booking confirmed — {courtName} {startsAtLocal}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">You're booked</h2>
              <table style="border-collapse:collapse;font-size:14px">
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Court</td><td><strong>{courtName}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Starts</td><td><strong>{startsAtLocal}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Duration</td><td><strong>{duration}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Charged</td><td><strong>{Cr(amountCredits)}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Balance after</td><td><strong>{Cr(balanceAfterCredits)}</strong></td></tr>
              </table>
              <p style="margin-top:16px;font-size:13px;color:#A16207">
                Heads-up: cancelling within {penaltyWindowMinutes} minutes of the start, or not turning the lights on, incurs a {Num(penaltyPct)}% penalty.
              </p>
              {FooterHtml}
            </div>
            """);

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
}
