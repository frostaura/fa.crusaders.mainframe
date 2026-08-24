using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Payments;
using Crusaders.Mainframe.Api.Payments.PayFast;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The PayFast provider and the ITN parse path.
///
/// <para>
/// <see cref="PayFastSignatureTests"/> pins the algorithm against an independent
/// implementation. These cover the wiring around it — the field order that the signature
/// depends on, and the two checks that stand between a signed notification and a member's
/// balance.
/// </para>
/// </summary>
public class PayFastProviderTests
{
    private static PayFastProvider Provider() => new(NullLogger<PayFastProvider>.Instance);

    /// <summary>
    /// Deliberately unmistakable as a fixture.
    ///
    /// <para>
    /// This was a realistic-looking random string, and the secret scanner flagged every
    /// occurrence — correctly. It was never a live credential, so nothing needed rotating,
    /// but a test suite full of things that look like credentials is a test suite people
    /// stop reading scanner output for. The value is arbitrary; the signatures derive from
    /// it, so any string exercises the algorithm equally well.
    /// </para>
    /// </summary>
    private const string TestPassphrase = "not-a-real-passphrase-test-fixture-only";

    private static PerTenantCredentials Creds(string environment = "test", string passphrase = TestPassphrase) =>
        new("10000100", "46f0cd694581a", passphrase, environment);

    private static RegisterCheckoutRequest Request(decimal amount = 100m) => new(
        Creds(), Guid.NewGuid(), Guid.NewGuid(), "jan@example.com", amount,
        "tu_9f8e7d6c5b4a3210",
        "https://crusaders.example.com/wallet/topup/done",
        "https://crusaders.example.com/api/v1/credit/topup/callback?tenant=crusaders")
    {
        CancelUrl = "https://crusaders.example.com/wallet/topup/cancelled",
        NameFirst = "Jan",
        NameLast = "van der Merwe",
    };

    // ---- Checkout ----------------------------------------------------------

    /// <summary>
    /// PayFast has no server-side registration — the browser POSTs a signed form. So this
    /// must make no network call and still return everything the frontend needs.
    /// </summary>
    [Fact]
    public async Task Registering_a_checkout_returns_a_signed_form_without_calling_out()
    {
        var result = await Provider().RegisterCheckoutAsync(Request(), default);

        Assert.True(result.Ok);
        Assert.Equal(PayFastProvider.Sandbox, result.RedirectUrl);
        Assert.NotEmpty(result.FormFields);

        var signature = result.FormFields.Single(f => f.Key == "signature").Value;
        Assert.Equal(32, signature.Length);

        // The signature must verify over the other fields, in the order they were emitted.
        var signed = result.FormFields
            .Where(f => f.Key != "signature")
            .Select(f => new KeyValuePair<string, string?>(f.Key, f.Value))
            .ToList();

        Assert.True(PayFastSignature.Verify(signed, Creds().SigningSecret, signature));
    }

    [Fact]
    public async Task The_environment_selects_the_gateway_host()
    {
        var sandbox = await Provider().RegisterCheckoutAsync(Request(), default);
        Assert.Equal(PayFastProvider.Sandbox, sandbox.RedirectUrl);

        var live = Request() with { Creds = Creds(environment: "production") };
        Assert.Equal(PayFastProvider.Live, (await Provider().RegisterCheckoutAsync(live, default)).RedirectUrl);
    }

    /// <summary>The amount must be invariant-culture, or "100,00" reaches PayFast on an en-ZA host.</summary>
    [Fact]
    public async Task The_amount_is_formatted_invariantly()
    {
        var previous = Thread.CurrentThread.CurrentCulture;
        try
        {
            Thread.CurrentThread.CurrentCulture = new System.Globalization.CultureInfo("af-ZA");

            var result = await Provider().RegisterCheckoutAsync(Request(1234.5m), default);
            Assert.Equal("1234.50", result.FormFields.Single(f => f.Key == "amount").Value);
        }
        finally
        {
            Thread.CurrentThread.CurrentCulture = previous;
        }
    }

    [Fact]
    public async Task Missing_credentials_refuse_rather_than_sending_an_unsigned_form()
    {
        var req = Request() with { Creds = new PerTenantCredentials("", "", "", "test") };
        var result = await Provider().RegisterCheckoutAsync(req, default);

        Assert.False(result.Ok);
        Assert.Equal("payfast_credentials_missing", result.FailureReason);
        Assert.Empty(result.FormFields);
    }

    // ---- ITN parsing -------------------------------------------------------

    /// <summary>
    /// The load-bearing property. PayFast signs the fields in the order posted, so the
    /// parse must preserve that order — <c>http.Form</c> would hand back a sorted
    /// dictionary and every notification would fail to verify with nothing saying why.
    /// </summary>
    [Fact]
    public void Form_parsing_preserves_the_order_fields_were_sent_in()
    {
        var fields = TopUpEndpoints.ParseFormPreservingOrder(
            "zebra=1&alpha=2&middle=3&beta=4");

        Assert.Equal(["zebra", "alpha", "middle", "beta"], fields.Select(f => f.Key));
    }

    [Fact]
    public void Form_parsing_decodes_plus_as_space_and_percent_escapes()
    {
        var fields = TopUpEndpoints.ParseFormPreservingOrder(
            "item_name=Court+1+booking&name_last=van+der+Merwe&note=50%25+off&email=a%40b.com");

        Assert.Equal("Court 1 booking", fields[0].Value);
        Assert.Equal("van der Merwe", fields[1].Value);
        Assert.Equal("50% off", fields[2].Value);
        Assert.Equal("a@b.com", fields[3].Value);
    }

    [Fact]
    public void Form_parsing_survives_empty_values_and_a_missing_equals()
    {
        var fields = TopUpEndpoints.ParseFormPreservingOrder("a=&b&c=3");

        Assert.Equal(3, fields.Count);
        Assert.Equal("", fields[0].Value);
        Assert.Equal("", fields[1].Value);
        Assert.Equal("3", fields[2].Value);
    }

    [Fact]
    public void Form_parsing_of_an_empty_body_yields_nothing_rather_than_throwing()
    {
        Assert.Empty(TopUpEndpoints.ParseFormPreservingOrder(""));
    }

    // ---- ITN interpretation ------------------------------------------------

    private static string SignedItn(string status = "COMPLETE", string gross = "100.00", string passphrase = TestPassphrase)
    {
        var fields = new List<KeyValuePair<string, string?>>
        {
            new("m_payment_id", "tu_9f8e7d6c5b4a3210"),
            new("pf_payment_id", "1089250"),
            new("payment_status", status),
            new("item_name", "Crusaders credits top-up"),
            new("amount_gross", gross),
            new("amount_fee", "-2.30"),
            new("amount_net", "97.70"),
            new("merchant_id", "10000100"),
        };

        var signature = PayFastSignature.Compute(fields, passphrase);

        return string.Join("&", fields
            .Select(f => $"{f.Key}={PayFastSignature.UrlEncode(f.Value!)}")
            .Append($"signature={signature}"));
    }

    private static CallbackPayload PayloadOf(string body, string passphrase = TestPassphrase) =>
        new(Creds(passphrase: passphrase), body, "", TopUpEndpoints.ParseFormPreservingOrder(body));

    [Fact]
    public async Task A_correctly_signed_completion_is_accepted()
    {
        var interp = await Provider().InterpretCallbackAsync(PayloadOf(SignedItn()), default);

        Assert.True(interp.SignatureValid);
        Assert.True(interp.Successful);
        Assert.Equal("tu_9f8e7d6c5b4a3210", interp.MerchantTransactionId);
        Assert.Equal("1089250", interp.PaymentId);
        Assert.Equal(100.00m, interp.AmountGross);
    }

    /// <summary>
    /// The distinction that matters most: a valid signature means the message is authentic,
    /// not that money moved. Treating them as the same credits a member for a failed payment.
    /// </summary>
    [Theory]
    [InlineData("FAILED")]
    [InlineData("PENDING")]
    [InlineData("CANCELLED")]
    public async Task A_signed_but_unsuccessful_notification_is_authentic_and_not_successful(string status)
    {
        var interp = await Provider().InterpretCallbackAsync(PayloadOf(SignedItn(status)), default);

        Assert.True(interp.SignatureValid);
        Assert.False(interp.Successful);
        Assert.Equal(status, interp.ResultCode);
    }

    [Fact]
    public async Task A_tampered_body_fails_verification()
    {
        var body = SignedItn().Replace("amount_gross=100.00", "amount_gross=10000.00");
        var interp = await Provider().InterpretCallbackAsync(PayloadOf(body), default);

        Assert.False(interp.SignatureValid);
    }

    [Fact]
    public async Task The_wrong_passphrase_fails_verification()
    {
        var interp = await Provider().InterpretCallbackAsync(
            PayloadOf(SignedItn(), passphrase: "not-the-passphrase"), default);

        Assert.False(interp.SignatureValid);
    }

    /// <summary>A merchant with no passphrase set is legitimate and must still verify.</summary>
    [Fact]
    public async Task A_merchant_without_a_passphrase_still_verifies()
    {
        var interp = await Provider().InterpretCallbackAsync(
            PayloadOf(SignedItn(passphrase: ""), passphrase: ""), default);

        Assert.True(interp.SignatureValid);
        Assert.True(interp.Successful);
    }

    [Fact]
    public async Task A_body_with_no_signature_at_all_is_refused()
    {
        var body = "m_payment_id=tu_x&payment_status=COMPLETE&amount_gross=100.00";
        var interp = await Provider().InterpretCallbackAsync(PayloadOf(body), default);

        Assert.False(interp.SignatureValid);
    }

    /// <summary>PayFast sends the fee negative; a parser assuming unsigned decimals breaks.</summary>
    [Fact]
    public async Task A_negative_fee_does_not_break_the_parse()
    {
        var interp = await Provider().InterpretCallbackAsync(PayloadOf(SignedItn()), default);

        Assert.True(interp.SignatureValid);
        Assert.Equal(100.00m, interp.AmountGross);
    }

    /// <summary>
    /// Reordering the posted fields must invalidate — this is what proves the order
    /// dependency is real and that a dictionary in this path would be fatal.
    /// </summary>
    [Fact]
    public async Task Reordering_the_posted_fields_invalidates_the_signature()
    {
        var body = SignedItn();
        var parts = body.Split('&').ToList();

        var signature = parts.Last();
        var reordered = parts.Take(parts.Count - 1).Reverse().Append(signature);

        var shuffled = string.Join("&", reordered);
        var interp = await Provider().InterpretCallbackAsync(PayloadOf(shuffled), default);

        Assert.False(interp.SignatureValid);
    }
}
