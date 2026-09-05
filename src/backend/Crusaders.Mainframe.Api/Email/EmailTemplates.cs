namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// Minimal inline templates. Will graduate to Razor / MJML files once the count grows past a handful.
/// All templates take primitives only — no domain types — so they remain trivially testable.
/// </summary>
public static class EmailTemplates
{
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

    public static EmailMessage BookingConfirmation(string to, string courtName, string startsAtLocal, string duration, decimal amountZar, decimal balanceAfter) => new(
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
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Charged</td><td><strong>R{amountZar:0.00}</strong></td></tr>
                <tr><td style="padding:6px 16px 6px 0;color:#475569">Balance after</td><td><strong>R{balanceAfter:0.00}</strong></td></tr>
              </table>
              <p style="margin-top:16px;font-size:13px;color:#A16207">
                Heads-up: cancelling within 15 minutes of the start, or not turning the lights on, incurs a 30% penalty.
              </p>
              {FooterHtml}
            </div>
            """);

    public static EmailMessage BookingCancellation(string to, string courtName, decimal refundedZar, decimal? penaltyZar) => new(
        To: to,
        Subject: $"Booking cancelled — {courtName}",
        HtmlBody:
            $"""
            <div style="font-family:Figtree,sans-serif;color:#0F172A;max-width:560px">
              <h2 style="margin:0 0 12px">Cancelled</h2>
              <p>Your booking on {courtName} has been cancelled.</p>
              <p>Refunded to your credit: <strong>R{refundedZar:0.00}</strong>.</p>
              {(penaltyZar is > 0 ? $"<p>Late-cancellation penalty applied: <strong>R{penaltyZar:0.00}</strong>.</p>" : "")}
              {FooterHtml}
            </div>
            """);
}
