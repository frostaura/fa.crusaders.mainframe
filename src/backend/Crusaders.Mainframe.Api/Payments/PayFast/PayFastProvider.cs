using System.Globalization;
using Crusaders.Mainframe.Api.Payments;

namespace Crusaders.Mainframe.Api.Payments.PayFast;

/// <summary>
/// PayFast, replacing PeachPayments per the founder's decision.
///
/// <para>
/// PayFast has no server-side checkout registration. Where Peach returned a checkout id
/// and a widget URL, PayFast expects the browser to POST a <b>signed form</b> to their
/// process endpoint — so <see cref="RegisterCheckoutAsync"/> makes no network call at all.
/// It builds and signs the field list, and the frontend submits it. That is why
/// <c>RegisterCheckoutResult</c> grew a <c>FormFields</c> collection.
/// </para>
/// </summary>
public sealed class PayFastProvider : IPaymentProvider
{
    public const string Sandbox = "https://sandbox.payfast.co.za/eng/process";
    public const string Live = "https://www.payfast.co.za/eng/process";

    /// <summary>
    /// PayFast's published ITN source addresses.
    ///
    /// <para>
    /// A secondary check, never the primary one: the signature is what authenticates a
    /// notification. This exists because an unsigned merchant — PayFast does not require a
    /// passphrase — would otherwise have nothing at all, and because it is cheap. It is
    /// advisory by configuration, since a reverse proxy that rewrites the source address
    /// would otherwise reject every real notification.
    /// </para>
    /// </summary>
    public static readonly string[] KnownSourceHosts =
    [
        "www.payfast.co.za",
        "sandbox.payfast.co.za",
        "w1w.payfast.co.za",
        "w2w.payfast.co.za",
    ];

    /// <summary>
    /// Configuration key that overrides the process URL: <c>PayFast:ProcessUrl</c>
    /// (<c>PayFast__ProcessUrl</c> as an environment variable).
    ///
    /// <para>
    /// Exists so a test stack can point the checkout at a stand-in — the mountebank
    /// imposter, a staging proxy — instead of at PayFast itself. Without it the redirect
    /// was a hardcoded constant and the imposter could only ever be reached by POSTing to
    /// it by hand, which meant the one leg it exists to prove was never driven by the app.
    /// Unset in production, where the environment picks sandbox or live as before.
    /// </para>
    /// </summary>
    public const string ProcessUrlConfigKey = "PayFast:ProcessUrl";

    private readonly ILogger<PayFastProvider> _logger;
    private readonly string? _processUrlOverride;

    public PayFastProvider(ILogger<PayFastProvider> logger, IConfiguration? config = null)
    {
        _logger = logger;
        var configured = config?[ProcessUrlConfigKey];
        _processUrlOverride = string.IsNullOrWhiteSpace(configured) ? null : configured.Trim();
    }

    public string ProviderName => "PayFast";

    public Task<RegisterCheckoutResult> RegisterCheckoutAsync(RegisterCheckoutRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Creds.MerchantId) || string.IsNullOrWhiteSpace(req.Creds.MerchantKey))
        {
            return Task.FromResult(new RegisterCheckoutResult(false, null, null, "payfast_credentials_missing"));
        }

        // Order is part of the signature, so this is a list and PayFast's documented field
        // order is the order written here. Do not sort it, and do not put it in a dictionary.
        var fields = new List<KeyValuePair<string, string?>>
        {
            new("merchant_id", req.Creds.MerchantId),
            new("merchant_key", req.Creds.MerchantKey),
            new("return_url", req.ReturnUrl),
            new("cancel_url", req.CancelUrl),
            new("notify_url", req.NotificationUrl),
            new("name_first", req.NameFirst),
            new("name_last", req.NameLast),
            new("email_address", req.UserEmail),
            new("m_payment_id", req.MerchantTransactionId),

            // Two decimals, invariant culture. "100,00" in en-ZA would be rejected, and the
            // machine's locale is not something a payment should depend on.
            new("amount", req.AmountZar.ToString("F2", CultureInfo.InvariantCulture)),
            new("item_name", req.ItemName),
        };

        var signature = PayFastSignature.Compute(fields, req.Creds.SigningSecret);

        var formFields = fields
            .Where(f => !string.IsNullOrEmpty(f.Value))
            .Select(f => new KeyValuePair<string, string>(f.Key, f.Value!))
            .Append(new KeyValuePair<string, string>("signature", signature))
            .ToList();

        return Task.FromResult(new RegisterCheckoutResult(
            Ok: true,
            CheckoutId: req.MerchantTransactionId,
            RedirectUrl: _processUrlOverride ?? ProcessUrlFor(req.Creds.Environment),
            FailureReason: null)
        {
            FormFields = formFields,
        });
    }

    public Task<CallbackInterpretation> InterpretCallbackAsync(CallbackPayload payload, CancellationToken ct)
    {
        // Everything except `signature`, in the order posted. PayFast signs what it sent, in
        // the sequence it sent it.
        var signed = payload.Fields
            .Where(f => !string.Equals(f.Key, "signature", StringComparison.OrdinalIgnoreCase))
            .Select(f => new KeyValuePair<string, string?>(f.Key, f.Value))
            .ToList();

        var presented = payload.Fields
            .FirstOrDefault(f => string.Equals(f.Key, "signature", StringComparison.OrdinalIgnoreCase)).Value;

        var valid = PayFastSignature.Verify(signed, payload.Creds.SigningSecret, presented);

        string? Field(string name) => payload.Fields
            .FirstOrDefault(f => string.Equals(f.Key, name, StringComparison.OrdinalIgnoreCase)).Value;

        var status = Field("payment_status");

        // COMPLETE is the only success. A valid signature says the message is authentic,
        // not that money moved — treating them as the same credits a member for a payment
        // that failed.
        var successful = string.Equals(status, "COMPLETE", StringComparison.OrdinalIgnoreCase);

        decimal? gross = decimal.TryParse(
            Field("amount_gross"), NumberStyles.Number, CultureInfo.InvariantCulture, out var g) ? g : null;

        if (!valid)
        {
            _logger.LogWarning(
                "PayFast ITN for {MerchantTransactionId} failed signature verification", Field("m_payment_id"));
        }

        return Task.FromResult(new CallbackInterpretation(
            SignatureValid: valid,
            MerchantTransactionId: Field("m_payment_id"),
            PaymentId: Field("pf_payment_id"),
            Successful: successful,
            ResultCode: status,
            ResultDescription: successful ? "COMPLETE" : status)
        {
            AmountGross = gross,
        });
    }

    /// <summary>
    /// PayFast's query API needs a merchant passphrase and a separate signed request, and
    /// nothing in this application polls for status — the ITN is the notification, and it
    /// retries on its own until acknowledged.
    ///
    /// <para>
    /// Returning an explicit "not supported" rather than throwing, so a caller that reaches
    /// here gets a decision instead of a 500.
    /// </para>
    /// </summary>
    public Task<PaymentStatusSnapshot> GetStatusAsync(string checkoutId, PerTenantCredentials creds, CancellationToken ct)
        => Task.FromResult(new PaymentStatusSnapshot(false, "status_query_not_supported", null));

    public static string ProcessUrlFor(string environment) =>
        string.Equals(environment, "production", StringComparison.OrdinalIgnoreCase) ? Live : Sandbox;
}
