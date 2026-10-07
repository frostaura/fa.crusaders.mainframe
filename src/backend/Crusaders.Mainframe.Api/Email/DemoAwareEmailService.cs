using Crusaders.Mainframe.Api.Services.Demo;

namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// The one door every message leaves by, with demo mode's lock on it: nothing is sent while the
/// flow acts for a demo club (<see cref="DemoTenants.Active"/>), and nothing is ever sent to a
/// made-up address (<c>.invalid</c>), whoever asks.
///
/// <para>
/// <b>Both checks, because each covers the other's gap.</b> The ambient flag is what stops a
/// demo admin who typed a REAL address onto a made-up member from mailing that person — the
/// address alone cannot tell. The address check is what still holds if a path ever sends without
/// a tenant having been chosen. A dropped message is logged at information level with its
/// subject, never its body.
/// </para>
/// </summary>
public sealed class DemoAwareEmailService : IEmailTransport
{
    private readonly IEmailService _inner;
    private readonly ILogger<DemoAwareEmailService> _logger;

    public DemoAwareEmailService(IEmailService inner, ILogger<DemoAwareEmailService> logger)
    {
        _inner = inner;
        _logger = logger;
    }

    public Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        if (DemoTenants.Active || DemoTenants.IsDemoAddress(message.To))
        {
            _logger.LogInformation("Demo mode: not sending '{Subject}'", message.Subject);
            return Task.CompletedTask;
        }
        return _inner.SendAsync(message, ct);
    }
}
