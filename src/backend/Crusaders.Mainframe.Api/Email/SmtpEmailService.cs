using System.Net;
using System.Net.Mail;

namespace Crusaders.Mainframe.Api.Email;

public sealed class SmtpEmailService : IEmailService
{
    private readonly IConfiguration _config;
    private readonly ILogger<SmtpEmailService> _logger;

    public SmtpEmailService(IConfiguration config, ILogger<SmtpEmailService> logger)
    {
        _config = config;
        _logger = logger;
    }

    public async Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        // Env vars take precedence over appsettings.json so docker-compose can override safely.
        var host = NonEmpty(_config["SMTP_HOST"]) ?? NonEmpty(_config["Smtp:Host"]) ?? "localhost";
        var port = int.TryParse(_config["SMTP_PORT"], out var p) ? p : _config.GetValue("Smtp:Port", 587);
        var user = NonEmpty(_config["SMTP_USER"]) ?? NonEmpty(_config["Smtp:User"]);
        var pass = NonEmpty(_config["SMTP_PASSWORD"]) ?? NonEmpty(_config["Smtp:Password"]);
        var from = NonEmpty(_config["SMTP_FROM"]) ?? NonEmpty(_config["Smtp:From"]) ?? "noreply@crusadersmainframe.local";
        var fromName = NonEmpty(_config["SMTP_FROM_NAME"]) ?? NonEmpty(_config["Smtp:FromName"]) ?? "Crusaders Mainframe";

        static string? NonEmpty(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;

        using var smtp = new SmtpClient(host, port)
        {
            EnableSsl = port == 587 || port == 465,
            DeliveryMethod = SmtpDeliveryMethod.Network,
            UseDefaultCredentials = false,
            Credentials = string.IsNullOrEmpty(user) ? null : new NetworkCredential(user, pass),
            // SmtpClient defaults to 100 SECONDS, and that default was in force here.
            //
            // A club's mail provider that stops answering therefore held a request open for a
            // minute and a half per message. Registration sends three, so a single bad SMTP day
            // could pin a request for four and a half minutes — while the browser gives up at
            // twenty seconds (REQUEST_TIMEOUT_MS) and tells the member their application failed.
            // It had not: the account was already committed before the first send. They try
            // again and are told their membership number belongs to somebody else, which is
            // their own invisible account.
            //
            // Observed, not theorised: a registration against a real SMTP host timed out in the
            // browser while the row landed in the database.
            //
            // Fifteen seconds is generous for an EHLO plus a small message, and bounds the
            // damage even where a send is still awaited.
            Timeout = (int)TimeSpan.FromSeconds(15).TotalMilliseconds,
        };

        using var mail = new MailMessage
        {
            From = new MailAddress(from, fromName),
            Subject = message.Subject,
            Body = message.HtmlBody,
            IsBodyHtml = true,
            // A real header, not a loud subject. See EmailMessage.HighPriority.
            Priority = message.HighPriority ? MailPriority.High : MailPriority.Normal,
        };
        mail.To.Add(message.To);
        if (!string.IsNullOrWhiteSpace(message.PlainBody))
        {
            mail.AlternateViews.Add(System.Net.Mail.AlternateView.CreateAlternateViewFromString(
                message.PlainBody, null, "text/plain"));
            mail.AlternateViews.Add(System.Net.Mail.AlternateView.CreateAlternateViewFromString(
                message.HtmlBody, null, "text/html"));
        }

        // Attachments last: a MailMessage's parts are disposed with the message, and building the
        // streams after the alternate views keeps the multipart/mixed wrapper around the whole
        // multipart/alternative body rather than around only the HTML half.
        var streams = new List<MemoryStream>();
        foreach (var attachment in message.Attachments ?? Array.Empty<EmailAttachment>())
        {
            var stream = new MemoryStream(attachment.Content);
            streams.Add(stream);
            mail.Attachments.Add(new Attachment(stream, attachment.FileName, attachment.ContentType));
        }

        try
        {
            await smtp.SendMailAsync(mail, ct);
            _logger.LogInformation("Sent email to {To} subject='{Subject}'", message.To, message.Subject);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to send email to {To} subject='{Subject}'", message.To, message.Subject);
            throw;
        }
        finally
        {
            foreach (var stream in streams) await stream.DisposeAsync();
        }
    }
}
