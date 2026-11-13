using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;

namespace Crusaders.Mainframe.Api.Webhooks;

/// <summary>
/// Reads <see cref="DomainEvent"/>s from <see cref="IEventBus"/>, fans them out to all matching
/// club <see cref="WebhookEndpoint"/>s with URL-templating + HMAC signing + per-endpoint exponential backoff.
///
/// <para>
/// <b>Durable before the first attempt, and never one endpoint behind another (BP-08).</b> It used
/// to await every endpoint in turn (ten seconds each at worst) and save the delivery rows only after
/// the loop, all on one serial reader for every club: one slow receiver held every club's stream,
/// and a deploy or a crash mid-loop lost the event outright, because no row existed to retry. Now
/// every delivery is saved <c>pending</c> — due for the retry sweep after
/// <see cref="FirstAttemptGrace"/> — before anything is sent, the attempts for one event run at
/// once, and up to <see cref="ConcurrentEvents"/> events are in flight together. A process that
/// dies after that first save loses nothing: <see cref="WebhookRetryWorker"/> sends what was not
/// sent. The remaining window is the event's own time in the in-memory channel, between its emit
/// and that save — milliseconds, not the whole fan-out.
/// </para>
///
/// <para>
/// Consumers order by <c>occurred_at</c>, never by arrival (<c>docs/specs/webhooks.md</c>), which
/// is what makes concurrent events safe to deliver.
/// </para>
/// </summary>
public sealed class WebhookDeliveryWorker : BackgroundService
{
    /// <summary>
    /// How long a just-saved delivery waits before the retry sweep may take it. Longer than one
    /// attempt can take (the sender's ten-second timeout), so a first attempt in flight is never
    /// sent twice; short enough that an event a crash interrupted goes out within minutes.
    /// </summary>
    public static readonly TimeSpan FirstAttemptGrace = TimeSpan.FromMinutes(2);

    /// <summary>Events fanned out at once. Each holds one database scope.</summary>
    public const int ConcurrentEvents = 4;

    private readonly IEventBus _bus;
    private readonly IServiceProvider _services;
    private readonly WebhookSender _sender;
    private readonly ILogger<WebhookDeliveryWorker> _logger;

    public WebhookDeliveryWorker(IEventBus bus, IServiceProvider services, WebhookSender sender, ILogger<WebhookDeliveryWorker> logger)
    { _bus = bus; _services = services; _sender = sender; _logger = logger; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var slots = new SemaphoreSlim(ConcurrentEvents);
        var inFlight = new List<Task>();
        try
        {
            await foreach (var evt in _bus.Reader.ReadAllAsync(stoppingToken))
            {
                await slots.WaitAsync(stoppingToken);
                inFlight.RemoveAll(t => t.IsCompleted);
                inFlight.Add(Task.Run(async () =>
                {
                    try { await DispatchAsync(evt, stoppingToken); }
                    catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
                    catch (Exception ex) { _logger.LogError(ex, "webhook dispatch crashed for event {Id}/{Type}", evt.Id, evt.Type); }
                    finally { slots.Release(); }
                }, CancellationToken.None));
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Shutting down. Whatever was saved pending is the retry sweep's.
        }

        await Task.WhenAll(inFlight);
    }

    /// <summary>One event's fan-out: rows first, then every attempt at once, then one save.</summary>
    internal async Task DispatchAsync(DomainEvent evt, CancellationToken ct)
    {
        using var scope = _services.CreateScope();
        var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        tenant.Set(evt.TenantId, evt.TenantSlug);

        // Demo mode: a demo club's events go nowhere. Its admin may add a webhook while showing the
        // app off, and a made-up booking must never reach a real URL.
        if (Services.Demo.DemoTenants.IsDemo(evt.TenantId)) return;

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        // The club's own endpoints only. Member-registered endpoints are gone (BP-08): the route
        // that made them had no caller and no cap, and the migration removed the rows.
        var endpoints = await db.WebhookEndpoints
            .Where(e => e.Enabled && e.OwnerKind == WebhookOwnerKind.Tenant)
            .ToListAsync(ct);

        if (endpoints.Count == 0) return;

        var envelopeJson = evt.ToEnvelopeJson();
        using var doc = JsonDocument.Parse(envelopeJson);
        var due = DateTimeOffset.UtcNow.Add(FirstAttemptGrace);

        var attempts = new List<(WebhookDelivery Delivery, WebhookEndpoint Endpoint)>();
        foreach (var endpoint in endpoints)
        {
            if (!FilterMatches(endpoint.EventFilter, evt.Type)) continue;

            var rendered = UrlTemplate.Render(endpoint.UrlTemplate, doc.RootElement);
            if (!rendered.Ok)
            {
                _logger.LogWarning("webhook {EndpointId} skipped: missing template variable {Var}", endpoint.Id, rendered.MissingVariable);
                db.WebhookDeliveries.Add(new WebhookDelivery
                {
                    TenantId = evt.TenantId,
                    EndpointId = endpoint.Id,
                    EventId = evt.Id,
                    EventType = evt.Type,
                    Url = endpoint.UrlTemplate,
                    RequestBody = envelopeJson,
                    FinalState = "failed",
                    Attempt = 1,
                    ResponseBodyExcerpt = $"missing-variable:{rendered.MissingVariable}",
                });
                continue;
            }

            var delivery = new WebhookDelivery
            {
                TenantId = evt.TenantId,
                EndpointId = endpoint.Id,
                EventId = evt.Id,
                EventType = evt.Type,
                Url = rendered.Url!,
                RequestBody = envelopeJson,
                Attempt = 1,
                FinalState = "pending",
                NextRetryAt = due,
            };
            db.WebhookDeliveries.Add(delivery);
            attempts.Add((delivery, endpoint));
        }

        // Durable first: from here a crash leaves pending rows the retry sweep finishes.
        await db.SaveChangesAsync(ct);
        if (attempts.Count == 0) return;

        // The attempts touch only their own delivery and endpoint objects, so they may run at
        // once; staging a notice touches the context, so that is done after, one at a time.
        var outcomes = await Task.WhenAll(attempts.Select(a => _sender.AttemptAsync(a.Delivery, a.Endpoint, envelopeJson, ct)));
        for (var i = 0; i < attempts.Count; i++)
        {
            WebhookSender.StageDisabledNotice(db, attempts[i].Delivery, attempts[i].Endpoint, outcomes[i]);
        }

        await db.SaveChangesAsync(ct);
    }

    private static bool FilterMatches(string filter, string type)
    {
        if (filter == "*" || string.IsNullOrWhiteSpace(filter)) return true;
        foreach (var part in filter.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (string.Equals(part, type, StringComparison.OrdinalIgnoreCase)) return true;
            if (part.EndsWith(".*") && type.StartsWith(part[..^2] + ".", StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }
}
