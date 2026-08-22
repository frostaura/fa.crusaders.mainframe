using System.Net.Http.Headers;
using System.Security.Cryptography;
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
    private static readonly TimeSpan[] Backoffs =
    {
        TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(30),
        TimeSpan.FromHours(2),   TimeSpan.FromHours(12),  TimeSpan.FromHours(24),
    };

    private readonly IEventBus _bus;
    private readonly IServiceProvider _services;
    private readonly IHttpClientFactory _http;
    private readonly ILogger<WebhookDeliveryWorker> _logger;

    public WebhookDeliveryWorker(IEventBus bus, IServiceProvider services, IHttpClientFactory http, ILogger<WebhookDeliveryWorker> logger)
    { _bus = bus; _services = services; _http = http; _logger = logger; }

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

            var (status, latency, excerpt) = await PostAsync(rendered.Url!, envelopeJson, endpoint.Secret, ct);
            delivery.ResponseStatus = status;
            delivery.LatencyMs = latency;
            delivery.ResponseBodyExcerpt = excerpt;

            if (status is >= 200 and < 300)
            {
                delivery.FinalState = "delivered";
                endpoint.FailureCount = 0;
                endpoint.LastSuccessAt = DateTimeOffset.UtcNow;
            }
            else
            {
                endpoint.FailureCount++;
                endpoint.LastFailureAt = DateTimeOffset.UtcNow;
                if (endpoint.FailureCount >= Backoffs.Length)
                {
                    delivery.FinalState = "abandoned";
                    endpoint.Enabled = false;
                    _logger.LogWarning("webhook {EndpointId} auto-disabled after {N} failures", endpoint.Id, endpoint.FailureCount);
                }
                else
                {
                    delivery.FinalState = "pending";
                    delivery.NextRetryAt = DateTimeOffset.UtcNow.Add(Backoffs[Math.Min(endpoint.FailureCount - 1, Backoffs.Length - 1)]);
                }
            }
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

    private async Task<(int? status, int latencyMs, string? excerpt)> PostAsync(string url, string body, string secret, CancellationToken ct)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var client = _http.CreateClient("webhooks");
            client.Timeout = TimeSpan.FromSeconds(10);

            var hmac = SignPayload(body, secret);
            var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
            using var req = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = new StringContent(body, Encoding.UTF8) { Headers = { ContentType = new MediaTypeHeaderValue("application/json") } },
            };
            req.Headers.TryAddWithoutValidation("X-Crusaders-Signature", $"sha256={hmac}");
            req.Headers.TryAddWithoutValidation("X-Crusaders-Timestamp", ts);

            using var res = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            var resBody = await res.Content.ReadAsStringAsync(ct);
            sw.Stop();
            return ((int)res.StatusCode, (int)sw.ElapsedMilliseconds, resBody.Length > 512 ? resBody[..512] : resBody);
        }
        catch (Exception ex)
        {
            sw.Stop();
            return (null, (int)sw.ElapsedMilliseconds, $"exception:{ex.GetType().Name}:{ex.Message}");
        }
    }

    private static string SignPayload(string body, string secret)
    {
        using var h = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return Convert.ToHexString(h.ComputeHash(Encoding.UTF8.GetBytes(body))).ToLowerInvariant();
    }
}
