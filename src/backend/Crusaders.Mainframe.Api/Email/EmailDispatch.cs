namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// Sends an email without making the caller wait for SMTP.
///
/// <para>
/// Two of these mails are raised on paths that must answer fast for reasons that have
/// nothing to do with mail: the PayFast ITN, which the gateway <b>retries</b> until it is
/// acknowledged — so a slow EHLO turns into a duplicate notification — and the desk's
/// credit adjustment, where an admin is waiting on a form. Neither can fail because the
/// mail server is down: the money has already moved and the ledger is the record.
/// </para>
///
/// <para>
/// <see cref="Services.BookingService"/> carries its own private copy of this shape;
/// consolidating the two is a tidy-up for whoever next touches that file, not a change to
/// make from here while another fixer is inside it.
/// </para>
/// </summary>
public static class EmailDispatch
{
    public static void InBackground(IEmailService email, ILogger logger, EmailMessage message, string context)
    {
        _ = Task.Run(async () =>
        {
            try { await email.SendAsync(message, CancellationToken.None); }
            catch (Exception ex) { logger.LogWarning(ex, "Background email send failed ({Context})", context); }
        });
    }
}
