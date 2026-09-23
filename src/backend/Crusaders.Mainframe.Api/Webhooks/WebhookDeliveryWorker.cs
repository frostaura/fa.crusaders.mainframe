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
/// <see cref="WebhookEndpoint"/>s with URL-templating + HMAC signing + per-endpoint exponential backoff.
/// </summary>
public sealed class WebhookDeliveryWorker : BackgroundService
{
    private readonly IEventBus _bus;
    private readonly IServiceProvider _services;
    private readonly WebhookSender _sender;
    private readonly ILogger<WebhookDeliveryWorker> _logger;

    public WebhookDeliveryWorker(IEventBus bus, IServiceProvider services, WebhookSender sender, ILogger<WebhookDeliveryWorker> logger)
    { _bus = bus; _services = services; _sender = sender; _logger = logger; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var evt in _bus.Reader.ReadAllAsync(stoppingToken))
        {
            try { await DispatchAsync(evt, stoppingToken); }
            catch (Exception ex) { _logger.LogError(ex, "webhook dispatch crashed for event {Id}/{Type}", evt.Id, evt.Type); }
        }
    }

    private async Task DispatchAsync(DomainEvent evt, CancellationToken ct)
    {
        using var scope = _services.CreateScope();
        var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        tenant.Set(evt.TenantId, evt.TenantSlug);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var endpoints = await db.WebhookEndpoints
            .Where(e => e.Enabled)
            .Where(e => e.OwnerKind == WebhookOwnerKind.Tenant
                || (e.OwnerKind == WebhookOwnerKind.User && (e.OwnerUserId == evt.SubjectUserId || e.OwnerUserId == evt.ActorUserId)))
            .ToListAsync(ct);

        if (endpoints.Count == 0) return;

        var envelopeJson = evt.ToEnvelopeJson();
        using var doc = JsonDocument.Parse(envelopeJson);

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
            };
            db.WebhookDeliveries.Add(delivery);

            var outcome = await _sender.AttemptAsync(delivery, endpoint, envelopeJson, ct);
            WebhookSender.StageDisabledNotice(db, delivery, endpoint, outcome);
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
