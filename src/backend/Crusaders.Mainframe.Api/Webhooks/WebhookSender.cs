using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.Outbound;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Webhooks;

/// <summary>What one delivery attempt did to the delivery and to its endpoint.</summary>
public enum WebhookAttemptOutcome
{
    Delivered,
    WillRetry,

    /// <summary>The sixth consecutive failure: the endpoint has been switched off.</summary>
    DisabledAfterFailures,

    /// <summary>The destination is not permitted from this deployment: switched off on the first attempt.</summary>
    DisabledBlocked,
}

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
    /// <paramref name="endpoint"/>. Does not save — the caller owns the transaction, which is
    /// also why switching an endpoint off answers an outcome rather than raising the admins'
    /// notice itself: see <see cref="StageDisabledNotice"/>.
    /// </summary>
    public async Task<WebhookAttemptOutcome> AttemptAsync(WebhookDelivery delivery, WebhookEndpoint endpoint, string body, CancellationToken ct)
    {
        var result = await PostAsync(delivery.Url, body, endpoint.Secret, endpoint.OwnerKind, ct);

        delivery.ResponseStatus = result.Status;
        delivery.LatencyMs = result.LatencyMs;
        delivery.ResponseBodyExcerpt = result.Excerpt;
        delivery.NextRetryAt = null;

        if (result.Status is >= 200 and < 300)
        {
            delivery.FinalState = "delivered";
            endpoint.FailureCount = 0;
            endpoint.LastSuccessAt = DateTimeOffset.UtcNow;
            return WebhookAttemptOutcome.Delivered;
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
            return WebhookAttemptOutcome.DisabledBlocked;
        }

        if (endpoint.FailureCount >= Backoffs.Length)
        {
            delivery.FinalState = "abandoned";
            endpoint.Enabled = false;
            _logger.LogWarning("webhook {EndpointId} auto-disabled after {N} failures", endpoint.Id, endpoint.FailureCount);
            return WebhookAttemptOutcome.DisabledAfterFailures;
        }

        delivery.FinalState = "pending";
        delivery.Attempt++;
        delivery.NextRetryAt = DateTimeOffset.UtcNow.Add(Backoffs[Math.Min(endpoint.FailureCount - 1, Backoffs.Length - 1)]);
        return WebhookAttemptOutcome.WillRetry;
    }

    /// <summary>
    /// Stages the admins' notice when <paramref name="outcome"/> switched a CLUB endpoint off —
    /// the email to the owner that <c>docs/specs/webhooks.md</c> has promised since it was
    /// written and nothing sent (R23). Staged into the caller's context so it commits with the
    /// disable itself: the delivery row, the endpoint's <c>enabled = false</c> and the notice are
    /// one save.
    ///
    /// <para>
    /// <b>A club endpoint only.</b> A club's endpoints are owned by the club, so its
    /// administrators are the owner. A member-registered endpoint is the member's, and mailing
    /// every admin about a member's private integration would be reporting on the member; that
    /// owner's own mail is still owed.
    /// </para>
    ///
    /// <para>
    /// The destination is named by scheme and host only. The rendered URL can carry template
    /// variables — a member's id, a token in the query — and a mail is not where those go.
    /// </para>
    /// </summary>
    public static void StageDisabledNotice(
        MainframeDbContext db, WebhookDelivery delivery, WebhookEndpoint endpoint, WebhookAttemptOutcome outcome)
    {
        if (endpoint.OwnerKind != WebhookOwnerKind.Tenant) return;
        if (outcome is not (WebhookAttemptOutcome.DisabledAfterFailures or WebhookAttemptOutcome.DisabledBlocked)) return;

        AdminNotices.Stage(db, endpoint.TenantId, AdminNotices.WebhookAutoDisabled(
            endpoint, delivery.Id, DestinationOf(delivery.Url), outcome == WebhookAttemptOutcome.DisabledBlocked));
    }

    /// <summary>Scheme, host and a non-default port; never the path or the query.</summary>
    internal static string DestinationOf(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return "an address that is not a URL";
        return uri.IsDefaultPort ? $"{uri.Scheme}://{uri.Host}" : $"{uri.Scheme}://{uri.Host}:{uri.Port}";
    }

    private sealed record SendResult(int? Status, int LatencyMs, string? Excerpt, bool Blocked);

    /// <summary>
    /// One delivery attempt, on the client that matches who chose the destination.
    ///
    /// <para>
    /// Two guarded clients, differing only in whether
    /// <c>Webhooks:PrivateNetworkAllowList</c> applies. The club's own endpoints need it —
    /// that carve-out is what lets the API reach the lights controller on the LAN, and
    /// closing it would break the hardware. Endpoints an ordinary member registered do not:
    /// <c>POST /api/v1/webhooks</c> is authenticated but not admin-gated, so any member could
    /// aim one at the relay controller and then trigger delivery by making a booking of their
    /// own — <c>booking.created</c> carries their own subject id, which is exactly what the
    /// owner-kind filter matches on. The owner filter restricts which events reach an
    /// endpoint, never where it points.
    /// </para>
    ///
    /// <para>
    /// Doing it at the socket rather than at registration is the point: a member can register
    /// a name that resolves publicly today and to the relay controller tomorrow, and no
    /// pre-flight check survives that.
    /// </para>
    /// </summary>
    private async Task<SendResult> PostAsync(
        string url, string body, string secret, WebhookOwnerKind ownerKind, CancellationToken ct)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();

        try
        {
            var client = _http.CreateClient(
                ownerKind == WebhookOwnerKind.Tenant ? "webhooks" : "webhooks-member");
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
