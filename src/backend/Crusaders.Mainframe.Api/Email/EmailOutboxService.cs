using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Demo;

namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// The application's <see cref="IEmailService"/>: stores the message in the email outbox and
/// returns. Nothing here waits on a mail server.
///
/// <para>
/// <b>Demo suppression is applied BEFORE storing</b> — nothing is queued while the flow acts for a
/// demo club (<see cref="DemoTenants.Active"/>), and nothing is ever queued to a made-up address
/// (<c>.invalid</c>), whoever asks. Both checks, because each covers the other's gap: the ambient
/// flag stops a demo admin who typed a REAL address onto a made-up member from mailing that
/// person, and the address check still holds if a path queues without a tenant having been chosen.
/// A dropped message is logged at information level with its subject, never its body.
/// </para>
///
/// <para>
/// <b>A singleton with its own scope per call.</b> The row is saved in a unit of work of its own,
/// not the caller's: a caller that rolls back its transaction must not take a mail that was already
/// promised with it, and a caller with no <c>DbContext</c> (a worker, an endpoint's service
/// locator) still gets the same behaviour. The cost is one small insert.
/// </para>
/// </summary>
public sealed class EmailOutboxService : IEmailService
{
    /// <summary>How the message is written into <see cref="EmailOutboxMessage.PayloadJson"/>. Attachments travel as base64.</summary>
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly IServiceScopeFactory _scopes;
    private readonly EmailOutboxSignal _signal;
    private readonly ILogger<EmailOutboxService> _logger;

    public EmailOutboxService(IServiceScopeFactory scopes, EmailOutboxSignal signal, ILogger<EmailOutboxService> logger)
    {
        _scopes = scopes; _signal = signal; _logger = logger;
    }

    public async Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        if (DemoTenants.Active || DemoTenants.IsDemoAddress(message.To))
        {
            _logger.LogInformation("Demo mode: not sending '{Subject}'", message.Subject);
            return;
        }

        var now = DateTimeOffset.UtcNow.Storable();
        await using var scope = _scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        db.EmailOutbox.Add(new EmailOutboxMessage
        {
            TenantId = AmbientTenant.Id,
            ToAddress = Clip(message.To, EmailOutboxMessage.AddressMaxLength),
            Subject = Clip(message.Subject, EmailOutboxMessage.SubjectMaxLength),
            PayloadJson = JsonSerializer.Serialize(message, Json),
            CreatedAt = now,
            DueAt = now,
        });
        await db.SaveChangesAsync(ct);
        _signal.Raise();
    }

    private static string Clip(string s, int max) => s.Length <= max ? s : s[..max];
}
