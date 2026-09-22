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
    string NotificationUrl)
{
    /// <summary>Where the gateway sends someone who backs out. PayFast requires it; Peach did not.</summary>
    public string? CancelUrl { get; init; }

    public string? NameFirst { get; init; }
    public string? NameLast { get; init; }

    /// <summary>
    /// Shown on the gateway's own payment page and on the member's card statement.
    ///
    /// <para>
    /// <b>It said "Crusaders credits top-up", and the word had to go for the same reason it
    /// went everywhere else</b> — but this string is read in a place none of the others are:
    /// a bank statement, weeks later, next to purchases from shops. So it names the CLUB and
    /// what was bought rather than the club's internal unit of account: a member scanning a
    /// statement for an unrecognised line needs to know who took the money, and "credits" told
    /// them nothing they could act on. Deliberately NOT the currency symbol either — the
    /// statement already prints the amount in the bank's own.
    /// </para>
    /// </summary>
    public string ItemName { get; init; } = "Crusaders Mainframe wallet top-up";
}

public sealed record RegisterCheckoutResult(
    bool Ok,
    string? CheckoutId,
    string? RedirectUrl,
    string? FailureReason)
{
    /// <summary>
    /// Fields the browser must POST to <see cref="RedirectUrl"/>, in order.
    ///
    /// <para>
    /// PayFast has no server-side checkout registration: you POST a signed form to their
    /// process endpoint. Peach returned a checkout id and a widget URL instead. Empty for
    /// providers that redirect with a plain GET.
    /// </para>
    /// </summary>
    public IReadOnlyList<KeyValuePair<string, string>> FormFields { get; init; } = [];
}

/// <summary>
/// A gateway callback, as received.
///
/// <para>
/// <b><see cref="Fields"/> is an ordered list, not a dictionary, and that is load-bearing.</b>
/// PayFast signs its ITN over the fields <i>in the order they were posted</i>, so a
/// <c>Dictionary</c> anywhere in this path silently reorders them and every notification
/// fails to verify — with no error saying why. This record used to carry an
/// <c>IDictionary&lt;string, string&gt;</c>.
/// </para>
/// </summary>
public sealed record CallbackPayload(
    PerTenantCredentials Creds,
    string RawBody,
    string SignatureHeader,
    IReadOnlyList<KeyValuePair<string, string>> Fields)
{
    /// <summary>The caller's IP, for gateways that publish a source range. Null when unknown.</summary>
    public string? SourceIp { get; init; }
}

public sealed record CallbackInterpretation(
    bool SignatureValid,
    string? MerchantTransactionId,
    string? PaymentId,
    bool Successful,
    string? ResultCode,
    string? ResultDescription)
{
    /// <summary>
    /// The gross amount the gateway says was paid, when it reports one.
    ///
    /// <para>
    /// Checked against the pending top-up before any credit is posted. Without it, a
    /// correctly-signed notification for R1 credits the member for the R1000 they asked to
    /// pay — the signature proves the message is authentic, not that it is the one expected.
    /// </para>
    /// </summary>
    public decimal? AmountGross { get; init; }
}

public sealed record PaymentStatusSnapshot(
    bool Successful,
    string? ResultCode,
    string? PaymentId);

/// <summary>
/// One tenant's gateway credentials, named neutrally because this is a provider seam.
/// </summary>
/// <param name="MerchantId">PayFast <c>merchant_id</c>.</param>
/// <param name="MerchantKey">PayFast <c>merchant_key</c>.</param>
/// <param name="SigningSecret">PayFast <c>passphrase</c>. May be empty — a merchant need not set one.</param>
/// <param name="Environment">"test" or "production". Selects the gateway host.</param>
public sealed record PerTenantCredentials(
    string MerchantId,
    string MerchantKey,
    string SigningSecret,
    string Environment);
