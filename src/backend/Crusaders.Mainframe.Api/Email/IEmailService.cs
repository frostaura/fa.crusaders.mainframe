namespace Crusaders.Mainframe.Api.Email;

public interface IEmailService
{
    Task SendAsync(EmailMessage message, CancellationToken ct = default);
}

public sealed record EmailMessage(string To, string Subject, string HtmlBody, string? PlainBody = null);
