using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;

namespace Crusaders.Mainframe.Api.Webhooks;

/// <summary>
/// Re-sends deliveries whose backoff has elapsed.
///
/// <para>
/// <b>Nothing did this.</b> <c>WebhookDeliveryWorker</c> has always written
/// <c>FinalState = "pending"</c> and a <c>NextRetryAt</c>, and no code anywhere read
/// either column. The documented 1m/5m/30m/2h/12h/24h schedule described a mechanism
/// that did not exist: a receiver that was down for thirty seconds lost the event
/// permanently, and the delivery row sat "pending" forever, looking like it was about
/// to be retried.
/// </para>
///
/// <para>
/// The invariant this protects is not convenience. <c>CLAUDE.md</c> requires that
/// webhooks are a programmatic mirror of the same event stream players receive by
/// email — a mirror that drops events on the first transient failure is not a mirror.
/// </para>
/// </summary>
public sealed class WebhookRetryWorker : BackgroundService
{
    /// <summary>
    /// Poll interval. The shortest backoff is a minute, so a 30-second sweep costs one
    /// indexed query and never delays a retry by more than half its own granularity.
    /// </summary>
    private static readonly TimeSpan SweepInterval = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Deliveries per sweep. A receiver that has been down for a day comes back to a
    /// backlog, and firing all of it at once is how a recovering service is knocked
    /// over a second time.
    /// </summary>
    private const int BatchSize = 50;

    private readonly IServiceProvider _services;
    private readonly WebhookSender _sender;
    private readonly ILogger<WebhookRetryWorker> _logger;

    public WebhookRetryWorker(IServiceProvider services, WebhookSender sender, ILogger<WebhookRetryWorker> logger)
    {
        _services = services;
        _sender = sender;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(SweepInterval);

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await SweepAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // Swallowed deliberately: a crashed BackgroundService is silently gone
                // for the process lifetime, and losing retries entirely is worse than
                // losing one sweep.
                _logger.LogError(ex, "webhook retry sweep failed");
            }
        }
    }

    internal async Task<int> SweepAsync(CancellationToken ct)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var now = DateTimeOffset.UtcNow;

        // IgnoreQueryFilters: the sweep spans every tenant, and the tenant is set
        // per delivery below before anything is written.
        var due = await db.WebhookDeliveries.IgnoreQueryFilters()
            .Where(d => d.FinalState == "pending" && d.NextRetryAt != null && d.NextRetryAt <= now)
            .OrderBy(d => d.NextRetryAt)
            .Take(BatchSize)
            .ToListAsync(ct);

        if (due.Count == 0) return 0;

        var sent = 0;

        foreach (var delivery in due)
        {
            var endpoint = await db.WebhookEndpoints.IgnoreQueryFilters()
                .FirstOrDefaultAsync(e => e.Id == delivery.EndpointId, ct);

            // The endpoint was deleted or auto-disabled while this sat in the queue.
            // Abandon rather than resurrect it: re-enabling an endpoint an admin turned
            // off, because a day-old delivery came due, is the wrong way round.
            if (endpoint is null || !endpoint.Enabled)
            {
                delivery.FinalState = "abandoned";
                delivery.NextRetryAt = null;
                continue;
            }

            await _sender.AttemptAsync(delivery, endpoint, delivery.RequestBody, ct);
            sent++;
        }

        await db.SaveChangesAsync(ct);

        _logger.LogInformation("webhook retry sweep: {Due} due, {Sent} re-sent", due.Count, sent);
        return sent;
    }
}
