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
        };

        using var mail = new MailMessage
        {
            From = new MailAddress(from, fromName),
            Subject = message.Subject,
            Body = message.HtmlBody,
            IsBodyHtml = true,
        };
        mail.To.Add(message.To);
        if (!string.IsNullOrWhiteSpace(message.PlainBody))
        {
            mail.AlternateViews.Add(System.Net.Mail.AlternateView.CreateAlternateViewFromString(
                message.PlainBody, null, "text/plain"));
            mail.AlternateViews.Add(System.Net.Mail.AlternateView.CreateAlternateViewFromString(
                message.HtmlBody, null, "text/html"));
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
    }
}
