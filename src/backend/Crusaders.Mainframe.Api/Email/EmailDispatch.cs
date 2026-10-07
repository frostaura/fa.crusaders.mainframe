namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// Queues an email on a path where a failed mail must not unwind the caller.
///
/// <para>
/// Some of these mails are raised on paths that must answer fast and cannot fail because of mail:
/// the PayFast ITN, which the gateway <b>retries</b> until it is acknowledged, and the desk's
/// minutes adjustment or package sale, where an admin is waiting on a form. The money has already
/// moved and the ledger is the record. <see cref="IEmailService.SendAsync"/> now only queues into
/// the email outbox, so awaiting it costs one small insert rather than an SMTP round trip; what is
/// left to guard is the insert itself failing, which is logged and never thrown.
/// </para>
/// </summary>
public static class EmailDispatch
{
    /// <summary>Queues <paramref name="message"/>. Answers whether it was queued; never throws.</summary>
    public static async Task<bool> QueueAsync(IEmailService email, ILogger logger, EmailMessage message, string context)
    {
        try
        {
            // Not the request's token: a request that is over must not cancel a mail it already promised.
            await email.SendAsync(message, CancellationToken.None);
            return true;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Email could not be queued ({Context})", context);
            return false;
        }
    }
}
