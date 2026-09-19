namespace Crusaders.Mainframe.Api.Email;

public interface IEmailService
{
    Task SendAsync(EmailMessage message, CancellationToken ct = default);
}

/// <summary>
/// A file that travels with the message.
/// </summary>
/// <remarks>
/// Content is held in memory because everything this system attaches is a receipt: one page,
/// a couple of kilobytes, generated in the request that sends it. A stream would only buy the
/// ability to attach something large, which nothing here does and nothing here should.
/// </remarks>
public sealed record EmailAttachment(string FileName, string ContentType, byte[] Content);

public sealed record EmailMessage(
    string To,
    string Subject,
    string HtmlBody,
    string? PlainBody = null,
    /// <summary>
    /// Files to attach. Spec §11 requires the booking confirmation to carry a receipt PDF, and
    /// the message had nowhere to put one — so the confirmation shipped single-part with no
    /// attachment, and a member had nothing to forward to a treasurer or keep against a
    /// disputed charge.
    /// </summary>
    IReadOnlyList<EmailAttachment>? Attachments = null,
    /// <summary>
    /// True for a message a club must act on now — today, only the peripheral alert
    /// (<c>feature-spec.md</c> §6a's "admin gets a high-priority alert"). The transport turns
    /// it into a real <c>X-Priority: 1</c> / <c>Importance: high</c> mail rather than an
    /// urgent-sounding subject line, because a mail client sorts on the header and a member
    /// of staff sorts on what their client shows them.
    /// </summary>
    bool HighPriority = false);
