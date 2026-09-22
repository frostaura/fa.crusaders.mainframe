using System.Net;
using System.Net.Sockets;
using System.Text;
using Crusaders.Mainframe.Api.Email;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// What actually goes down the wire, read off the wire.
///
/// <para>
/// <b>Every other email test in this suite reads an <see cref="EmailMessage"/>, and an
/// <c>EmailMessage</c> is not a message.</b> The gap between the two is where this defect
/// lived: <see cref="SmtpEmailService"/> set <c>MailMessage.Body</c> to the HTML <i>and</i>
/// added a plain-text alternate view, and <c>SmtpClient</c> emits the body as a part of its own
/// beside the views — so the message that left the process carried three parts, the first of
/// which was the raw HTML labelled <c>text/plain</c>. A text-only client was handed markup by
/// the very part written to stop that. Nothing in the suite could see it, because every
/// assertion stopped at the record.
/// </para>
///
/// <para>
/// The sink below is an in-process <see cref="TcpListener"/> on the loopback interface that
/// speaks just enough SMTP to accept one message and hand back its bytes. It reaches no
/// network and delivers nothing.
/// </para>
/// </summary>
public class EmailTransportTests
{
    private static readonly ClubIdentity Club =
        new("Riverside Racquet Club", "+27 31 555 0188", "desk@riverside.review.test");

    /// <summary>
    /// The shape a mail client actually has to read: exactly two alternatives, the plain text
    /// first, and the HTML labelled as HTML.
    /// </summary>
    [Fact]
    public async Task A_message_leaves_as_two_alternatives_with_the_text_part_labelled_text_plain()
    {
        var raw = await SendAndCaptureAsync(EmailTemplates.PasswordReset(
            Club, "member@riverside.review.test", "https://riverside.review.test/reset/abc"));

        Assert.Contains("Content-Type: multipart/alternative", raw, StringComparison.OrdinalIgnoreCase);

        var plainParts = CountParts(raw, "text/plain");
        var htmlParts = CountParts(raw, "text/html");
        Assert.True(plainParts == 1,
            $"expected one text/plain part, got {plainParts} — a second one is the HTML mislabelled");
        Assert.True(htmlParts == 1, $"expected one text/html part, got {htmlParts}");

        // The plain part must be prose. The failure this pins put a DOCTYPE here.
        var plain = PartBody(raw, "text/plain");
        Assert.DoesNotContain("<!DOCTYPE", plain, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<table", plain, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Set a new password", plain, StringComparison.Ordinal);

        // Least capable first, which is the order RFC 2046 asks for and the order a client
        // uses to pick the richest part it understands.
        Assert.True(
            raw.IndexOf("text/plain", StringComparison.OrdinalIgnoreCase)
            < raw.IndexOf("text/html", StringComparison.OrdinalIgnoreCase),
            "the HTML alternative precedes the plain one, so a client picking the last it "
            + "understands may take the wrong part");
    }

    /// <summary>
    /// The club's name is the largest thing a member sees in an inbox list, and it was a
    /// process-wide constant: <c>SMTP_FROM_NAME</c> is one value for the whole deployment, so
    /// every club's mail arrived from the same sender — and that sender was the software's own
    /// name rather than any club's.
    /// </summary>
    [Fact]
    public async Task The_sender_a_member_sees_is_the_club_and_not_the_configured_default()
    {
        var raw = await SendAndCaptureAsync(EmailTemplates.PasswordChanged(Club, "member@riverside.review.test"));

        Assert.Contains("Riverside Racquet Club", raw, StringComparison.Ordinal);
        Assert.DoesNotContain("Configured Default Name", raw, StringComparison.Ordinal);
    }

    /// <summary>
    /// A message with no club behind it — nothing sends one today — falls back to the
    /// configured name rather than to an empty sender.
    /// </summary>
    [Fact]
    public async Task A_message_with_no_club_falls_back_to_the_configured_sender_name()
    {
        var raw = await SendAndCaptureAsync(new EmailMessage(
            To: "ops@riverside.review.test", Subject: "Operational", HtmlBody: "<p>Hello</p>"));

        Assert.Contains("Configured Default Name", raw, StringComparison.Ordinal);
    }

    // ---- the sink ----

    private static async Task<string> SendAndCaptureAsync(EmailMessage message)
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var captured = AcceptOneAsync(listener);

        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["SMTP_HOST"] = "127.0.0.1",
            ["SMTP_PORT"] = port.ToString(),
            ["SMTP_FROM"] = "noreply@riverside.review.test",
            ["SMTP_FROM_NAME"] = "Configured Default Name",
        }).Build();

        var service = new SmtpEmailService(config, NullLogger<SmtpEmailService>.Instance);
        await service.SendAsync(message, CancellationToken.None);

        var raw = await captured;
        listener.Stop();
        return raw;
    }

    /// <summary>Enough SMTP to accept one message and keep its bytes. Loopback only.</summary>
    private static async Task<string> AcceptOneAsync(TcpListener listener)
    {
        using var client = await listener.AcceptTcpClientAsync();
        using var stream = client.GetStream();
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\r\n" };

        await writer.WriteLineAsync("220 test-sink ESMTP");
        var body = new StringBuilder();
        var inData = false;

        while (await reader.ReadLineAsync() is { } line)
        {
            if (inData)
            {
                if (line == ".") { inData = false; await writer.WriteLineAsync("250 OK"); continue; }
                body.AppendLine(line);
                continue;
            }

            var verb = line.ToUpperInvariant();
            if (verb.StartsWith("EHLO", StringComparison.Ordinal) || verb.StartsWith("HELO", StringComparison.Ordinal))
            {
                await writer.WriteLineAsync("250-test-sink");
                await writer.WriteLineAsync("250 8BITMIME");
            }
            else if (verb == "DATA") { inData = true; await writer.WriteLineAsync("354 go ahead"); }
            else if (verb == "QUIT") { await writer.WriteLineAsync("221 bye"); break; }
            else await writer.WriteLineAsync("250 OK");
        }

        return body.ToString();
    }

    private static int CountParts(string raw, string contentType) => raw
        .Split('\n')
        .Count(line => line.TrimStart().StartsWith("Content-Type: " + contentType, StringComparison.OrdinalIgnoreCase));

    /// <summary>The decoded body of the first part with this content type.</summary>
    private static string PartBody(string raw, string contentType)
    {
        var lines = raw.Split('\n').Select(l => l.TrimEnd('\r')).ToList();
        var header = lines.FindIndex(l =>
            l.TrimStart().StartsWith("Content-Type: " + contentType, StringComparison.OrdinalIgnoreCase));
        Assert.True(header >= 0, $"no {contentType} part");

        var blank = lines.FindIndex(header, string.IsNullOrEmpty);
        Assert.True(blank > header, $"no body after the {contentType} header");

        var end = lines.FindIndex(blank + 1, l => l.StartsWith("--", StringComparison.Ordinal));
        if (end < 0) end = lines.Count;

        // quoted-printable soft line breaks, which is how SmtpClient encodes a long line.
        return string.Join("\n", lines.GetRange(blank + 1, end - blank - 1)).Replace("=\n", "");
    }
}
