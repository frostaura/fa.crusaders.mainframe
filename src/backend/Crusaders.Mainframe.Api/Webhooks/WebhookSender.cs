using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Security.Outbound;

namespace Crusaders.Mainframe.Api.Webhooks;

/// <summary>
/// One delivery attempt and the bookkeeping that follows it.
///
/// <para>
/// Extracted from <see cref="WebhookDeliveryWorker"/> so the first attempt and every
/// retry run the same code. A separate retry implementation would eventually disagree
/// with the original about what counts as success, what counts as permanent, and when
/// an endpoint gets disabled — and the disagreement would only show up in production,
/// hours after the first failure.
/// </para>
///
/// <para>
/// Stateless, so it is a singleton and both workers hold the same one.
/// </para>
/// </summary>
public sealed class WebhookSender
{
    /// <summary>The documented schedule: 1m, 5m, 30m, 2h, 12h, 24h, then auto-disable.</summary>
    public static readonly TimeSpan[] Backoffs =
    [
        TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(30),
        TimeSpan.FromHours(2), TimeSpan.FromHours(12), TimeSpan.FromHours(24),
    ];

    private const int ExcerptLimit = 512;

    private readonly IHttpClientFactory _http;
    private readonly ILogger<WebhookSender> _logger;

    public WebhookSender(IHttpClientFactory http, ILogger<WebhookSender> logger)
    {
        _http = http;
        _logger = logger;
    }

    /// <summary>
    /// Sends once and records the outcome on <paramref name="delivery"/> and
    /// <paramref name="endpoint"/>. Does not save — the caller owns the transaction.
    /// </summary>
    public async Task AttemptAsync(WebhookDelivery delivery, WebhookEndpoint endpoint, string body, CancellationToken ct)
    {
        var result = await PostAsync(delivery.Url, body, endpoint.Secret, ct);

        delivery.ResponseStatus = result.Status;
        delivery.LatencyMs = result.LatencyMs;
        delivery.ResponseBodyExcerpt = result.Excerpt;
        delivery.NextRetryAt = null;

        if (result.Status is >= 200 and < 300)
        {
            delivery.FinalState = "delivered";
            endpoint.FailureCount = 0;
            endpoint.LastSuccessAt = DateTimeOffset.UtcNow;
            return;
        }

        endpoint.FailureCount++;
        endpoint.LastFailureAt = DateTimeOffset.UtcNow;

        // A blocked destination is a configuration error, not a transient one. Retrying
        // it six times over 41 hours re-runs a decision that cannot change and buries
        // the real reason under a retry history. Treated the same way a missing template
        // variable already is: abandoned at once, endpoint disabled.
        if (result.Blocked)
        {
            delivery.FinalState = "abandoned";
            endpoint.Enabled = false;
            _logger.LogWarning(
                "webhook {EndpointId} disabled: destination is not permitted from this deployment", endpoint.Id);
            return;
        }

        if (endpoint.FailureCount >= Backoffs.Length)
        {
            delivery.FinalState = "abandoned";
            endpoint.Enabled = false;
            _logger.LogWarning("webhook {EndpointId} auto-disabled after {N} failures", endpoint.Id, endpoint.FailureCount);
            return;
        }

        delivery.FinalState = "pending";
        delivery.Attempt++;
        delivery.NextRetryAt = DateTimeOffset.UtcNow.Add(Backoffs[Math.Min(endpoint.FailureCount - 1, Backoffs.Length - 1)]);
    }

    private sealed record SendResult(int? Status, int LatencyMs, string? Excerpt, bool Blocked);

    private async Task<SendResult> PostAsync(string url, string body, string secret, CancellationToken ct)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();

        try
        {
            var client = _http.CreateClient("webhooks");
            client.Timeout = TimeSpan.FromSeconds(10);

            using var req = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = new StringContent(body, Encoding.UTF8)
                {
                    Headers = { ContentType = new MediaTypeHeaderValue("application/json") },
                },
            };
            req.Headers.TryAddWithoutValidation("X-Crusaders-Signature", $"sha256={SignPayload(body, secret)}");
            req.Headers.TryAddWithoutValidation(
                "X-Crusaders-Timestamp", DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString());

            using var res = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            var resBody = await res.Content.ReadAsStringAsync(ct);
            sw.Stop();

            return new SendResult(
                (int)res.StatusCode,
                (int)sw.ElapsedMilliseconds,
                resBody.Length > ExcerptLimit ? resBody[..ExcerptLimit] : resBody,
                Blocked: false);
        }
        catch (Exception ex)
        {
            sw.Stop();
            return new SendResult(
                null, (int)sw.ElapsedMilliseconds, $"exception:{ex.GetType().Name}:{ex.Message}", IsBlocked(ex));
        }
    }

    /// <summary>The guard's refusal arrives wrapped by HttpClient, so unwrap to find it.</summary>
    private static bool IsBlocked(Exception? ex)
    {
        for (var depth = 0; ex is not null && depth < 5; depth++, ex = ex.InnerException)
        {
            if (ex is OutboundBlockedException) return true;
        }

        return false;
    }

    private static string SignPayload(string body, string secret)
    {
        var mac = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(body));
        return Convert.ToHexString(mac).ToLowerInvariant();
    }
}
