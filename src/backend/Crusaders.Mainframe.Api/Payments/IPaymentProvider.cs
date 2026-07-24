namespace Crusaders.Mainframe.Api.Payments;

public interface IPaymentProvider
{
    string ProviderName { get; }

    Task<RegisterCheckoutResult> RegisterCheckoutAsync(RegisterCheckoutRequest req, CancellationToken ct);
    Task<CallbackInterpretation> InterpretCallbackAsync(CallbackPayload payload, CancellationToken ct);
    Task<PaymentStatusSnapshot> GetStatusAsync(string checkoutId, PerTenantCredentials creds, CancellationToken ct);
}

public sealed record RegisterCheckoutRequest(
    PerTenantCredentials Creds,
    Guid TenantId,
    Guid UserId,
    string UserEmail,
    decimal AmountZar,
    string MerchantTransactionId,
    string ReturnUrl,
    string NotificationUrl);

public sealed record RegisterCheckoutResult(
    bool Ok,
    string? CheckoutId,
    string? RedirectUrl,
    string? FailureReason);

public sealed record CallbackPayload(
    PerTenantCredentials Creds,
    string RawBody,
    string SignatureHeader,
    IDictionary<string, string> ParsedFields);

public sealed record CallbackInterpretation(
    bool SignatureValid,
    string? MerchantTransactionId,
    string? PaymentId,
    bool Successful,
    string? ResultCode,
    string? ResultDescription);

public sealed record PaymentStatusSnapshot(
    bool Successful,
    string? ResultCode,
    string? PaymentId);

public sealed record PerTenantCredentials(
    string EntityId,
    string AccessToken,
    string WebhookSecret,
    string Environment); // "test" | "production"
