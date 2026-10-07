using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Workers;

/// <summary>
/// Drives the email outbox: sends what is due whenever a row is queued (<see cref="EmailOutboxSignal"/>)
/// and at least every <see cref="PollInterval"/>, which is what picks up retries that have come due and
/// rows another process queued.
///
/// <para>
/// Deliberately thin — everything it does is <see cref="EmailOutboxDispatcher"/>, which tests drive at a
/// stated instant. A crashed <c>BackgroundService</c> is silently gone for the life of the process, so
/// every pass is caught and logged rather than allowed to end the loop.
/// </para>
/// </summary>
public sealed class EmailOutboxWorker : BackgroundService
{
    public static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);

    private readonly EmailOutboxDispatcher _dispatcher;
    private readonly EmailOutboxSignal _signal;
    private readonly ILogger<EmailOutboxWorker> _logger;

    public EmailOutboxWorker(EmailOutboxDispatcher dispatcher, EmailOutboxSignal signal, ILogger<EmailOutboxWorker> logger)
    {
        _dispatcher = dispatcher; _signal = signal; _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // The first pass runs at once: rows queued before a restart are waiting.
        do
        {
            try
            {
                // A full batch means there may be more; go again without waiting.
                while (await _dispatcher.DeliverDueAsync(DateTimeOffset.UtcNow, stoppingToken) >= EmailOutboxDispatcher.BatchSize) { }
            }
            catch (OperationCanceledException)
            {
                // Shutting down; the next process picks up whatever is still pending.
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Email outbox pass failed");
            }
        }
        while (!stoppingToken.IsCancellationRequested && await WaitAsync(stoppingToken));
    }

    private async Task<bool> WaitAsync(CancellationToken ct)
    {
        await _signal.WaitAsync(PollInterval, ct);
        return !ct.IsCancellationRequested;
    }
}
