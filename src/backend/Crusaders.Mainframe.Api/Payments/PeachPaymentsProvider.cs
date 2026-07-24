using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Crusaders.Mainframe.Api.Payments;

/// <summary>
/// PeachPayments hosted-checkout integration per docs/specs/payments-peachpayments.md.
/// Sandbox base: https://test.oppwa.com — production: https://oppwa.com (per-tenant choice).
/// </summary>
public sealed class PeachPaymentsProvider : IPaymentProvider
{
    public string ProviderName => "PeachPayments";

    private readonly IHttpClientFactory _http;
    private readonly IConfiguration _config;
    private readonly ILogger<PeachPaymentsProvider> _logger;

    public PeachPaymentsProvider(IHttpClientFactory http, IConfiguration config, ILogger<PeachPaymentsProvider> logger)
    { _http = http; _config = config; _logger = logger; }

    public async Task<RegisterCheckoutResult> RegisterCheckoutAsync(RegisterCheckoutRequest req, CancellationToken ct)
    {
        var baseUrl = ResolveBaseUrl(req.Creds);
        var client = _http.CreateClient("peach");
        client.BaseAddress = new Uri(baseUrl);

        var form = new Dictionary<string, string>
        {
            ["entityId"] = req.Creds.EntityId,
            ["amount"] = req.AmountZar.ToString("F2", CultureInfo.InvariantCulture),
            ["currency"] = "ZAR",
            ["paymentType"] = "DB",
            ["merchantTransactionId"] = req.MerchantTransactionId,
            ["customer.email"] = req.UserEmail,
            ["customer.merchantCustomerId"] = req.UserId.ToString(),
            ["shopperResultUrl"] = req.ReturnUrl,
            ["notificationUrl"] = req.NotificationUrl,
        };

        using var http = new HttpRequestMessage(HttpMethod.Post, "v1/checkouts")
        {
            Content = new FormUrlEncodedContent(form),
        };
        http.Headers.Authorization = new AuthenticationHeaderValue("Bearer", req.Creds.AccessToken);

        try
        {
            using var res = await client.SendAsync(http, ct);
            var body = await res.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(body);
            if (!res.IsSuccessStatusCode)
            {
                var reason = doc.RootElement.TryGetProperty("result", out var r) && r.TryGetProperty("description", out var d) ? d.GetString() : res.StatusCode.ToString();
                _logger.LogWarning("PeachPayments register failed: {Reason}", reason);
                return new(false, null, null, reason);
            }
            var checkoutId = doc.RootElement.GetProperty("id").GetString();
            // Hosted-checkout URL: <baseUrl>/v1/paymentWidgets.js?checkoutId=...  (UI side renders the widget)
            // For simple redirect flow we'd use COPYandPay — using the documented redirect pattern.
            var redirect = $"{baseUrl.TrimEnd('/')}/v1/paymentWidgets.js?checkoutId={checkoutId}";
            return new(true, checkoutId, redirect, null);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PeachPayments register exception");
            return new(false, null, null, ex.Message);
        }
    }

    public Task<CallbackInterpretation> InterpretCallbackAsync(CallbackPayload payload, CancellationToken ct)
    {
        // PeachPayments uses HMAC-SHA256 over the form-encoded body using the per-merchant webhook secret.
        // Header convention: 'X-Initialization-Vector', 'X-Authentication-Tag', or a single signature header — depends on integration.
        // Documented standard for the 'Webhook V2' API is HMAC-SHA256 of the JSON body with the secret as key, hex-encoded in the header.
        var expected = ComputeHmacHex(payload.RawBody, payload.Creds.WebhookSecret);
        var ok = !string.IsNullOrEmpty(payload.SignatureHeader)
              && CryptographicOperations.FixedTimeEquals(
                    Encoding.UTF8.GetBytes(expected),
                    Encoding.UTF8.GetBytes(payload.SignatureHeader.Replace("sha256=", "", StringComparison.OrdinalIgnoreCase)));

        var fields = payload.ParsedFields;
        var merchantTxnId = fields.TryGetValue("merchantTransactionId", out var m) ? m : null;
        var paymentId = fields.TryGetValue("id", out var i) ? i : null;
        var resultCode = fields.TryGetValue("result.code", out var c) ? c : null;
        var resultDescription = fields.TryGetValue("result.description", out var d) ? d : null;
        // Successful result codes for Peach: 000.000.000, 000.100.110, 000.100.111, 000.100.112 (success / approved with risk).
        var success = resultCode is not null
            && System.Text.RegularExpressions.Regex.IsMatch(resultCode, @"^(000\.000\.|000\.100\.1)");
        return Task.FromResult(new CallbackInterpretation(ok, merchantTxnId, paymentId, success, resultCode, resultDescription));
    }

    public async Task<PaymentStatusSnapshot> GetStatusAsync(string checkoutId, PerTenantCredentials creds, CancellationToken ct)
    {
        var baseUrl = ResolveBaseUrl(creds);
        var client = _http.CreateClient("peach");
        client.BaseAddress = new Uri(baseUrl);

        using var http = new HttpRequestMessage(HttpMethod.Get, $"v1/checkouts/{Uri.EscapeDataString(checkoutId)}/payment?entityId={Uri.EscapeDataString(creds.EntityId)}");
        http.Headers.Authorization = new AuthenticationHeaderValue("Bearer", creds.AccessToken);

        using var res = await client.SendAsync(http, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(body);
        var resultCode = doc.RootElement.TryGetProperty("result", out var r) && r.TryGetProperty("code", out var c) ? c.GetString() : null;
        var paymentId = doc.RootElement.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;
        var success = resultCode is not null && System.Text.RegularExpressions.Regex.IsMatch(resultCode, @"^(000\.000\.|000\.100\.1)");
        return new(success, resultCode, paymentId);
    }

    private string ResolveBaseUrl(PerTenantCredentials creds)
    {
        var fallback = _config["PeachPayments:BaseUrl"] ?? "https://test.oppwa.com";
        return creds.Environment.Equals("production", StringComparison.OrdinalIgnoreCase) ? "https://oppwa.com" : fallback;
    }

    private static string ComputeHmacHex(string body, string secret)
    {
        using var h = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return Convert.ToHexString(h.ComputeHash(Encoding.UTF8.GetBytes(body))).ToLowerInvariant();
    }
}
