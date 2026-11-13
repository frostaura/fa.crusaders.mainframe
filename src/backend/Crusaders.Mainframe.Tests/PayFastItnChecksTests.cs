using System.Net;
using Crusaders.Mainframe.Api.Payments;
using Crusaders.Mainframe.Api.Payments.PayFast;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The ITN's checks beyond its signature, without a database: the credential rules every
/// checkout and ITN is gated on, PayFast's validate call over a fake transport, and the source
/// check (money lane BM-1, platform BP-01, browser BM-03).
/// </summary>
public sealed class PayFastItnChecksTests
{
    private static readonly PerTenantCredentials Sandbox = new("10000100", "46f0cd694581a", "a-long-enough-passphrase", "test");

    // ---- credential rules -------------------------------------------------------------

    [Theory]
    [InlineData("10000100", "46f0cd694581a", "a-long-enough-passphrase", "test", true, "")]
    [InlineData("10000100", "46f0cd694581a", "a-long-enough-passphrase", "production", true, "")]
    [InlineData("10000100", "46f0cd694581a", "", "test", false, "")]
    [InlineData("10000100", "46f0cd694581a", "", "test", true, "passphrase_required")]
    [InlineData("10000100", "46f0cd694581a", "eleven-char", "test", true, "passphrase_too_short")]
    [InlineData("10000100", "46f0cd694581a", " padded-passphrase ", "test", true, "passphrase_invalid")]
    [InlineData("10000100", "46f0cd694581a", "REPLACE_WITH_PAYFAST_PASSPHRASE", "test", false, "passphrase_invalid")]
    [InlineData("REPLACE_WITH_PAYFAST_MERCHANT_ID", "46f0cd694581a", "a-long-enough-passphrase", "test", true, "merchant_id_invalid")]
    [InlineData("1000010a", "46f0cd694581a", "a-long-enough-passphrase", "test", true, "merchant_id_invalid")]
    [InlineData("10000100", "46f0cd694581", "a-long-enough-passphrase", "test", true, "merchant_key_invalid")]
    [InlineData("10000100", "46f0cd69-581a", "a-long-enough-passphrase", "test", true, "merchant_key_invalid")]
    [InlineData("10000100", "46f0cd694581a", "a-long-enough-passphrase", "prod", true, "environment_invalid")]
    public void Credentials_payfast_would_refuse_are_named(
        string id, string key, string phrase, string env, bool requirePhrase, string expected)
    {
        var problems = PayFastCredentialRules.Problems(id, key, phrase, env, requirePhrase);
        Assert.Equal(expected, string.Join(",", problems));
    }

    // ---- the validate call -----------------------------------------------------------

    private sealed class FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<(Uri Uri, string Body)> Seen { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Seen.Add((request.RequestUri!, await request.Content!.ReadAsStringAsync(ct)));
            return answer(request);
        }
    }

    private sealed class Factory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private static PayFastItnValidator Validator(FakeHandler handler, params (string Key, string Value)[] settings) =>
        new(new Factory(handler),
            new ConfigurationBuilder().AddInMemoryCollection(settings.Select(s => new KeyValuePair<string, string?>(s.Key, s.Value))).Build(),
            NullLogger<PayFastItnValidator>.Instance);

    private static readonly List<KeyValuePair<string, string>> Fields =
    [
        new("m_payment_id", "abc"), new("pf_payment_id", "123"), new("item_name", "Club - 5 hours (5 h)"),
        new("amount_gross", "550.00"), new("signature", "deadbeef"), new("after", "ignored"),
    ];

    [Theory]
    [InlineData(HttpStatusCode.OK, "VALID", ItnValidation.Valid)]
    [InlineData(HttpStatusCode.OK, "VALID\n", ItnValidation.Valid)]
    [InlineData(HttpStatusCode.OK, "INVALID", ItnValidation.Invalid)]
    [InlineData(HttpStatusCode.OK, "valid", ItnValidation.Invalid)]
    [InlineData(HttpStatusCode.BadRequest, "VALID", ItnValidation.Invalid)]
    [InlineData(HttpStatusCode.BadGateway, "", ItnValidation.Unavailable)]
    public async Task Payfasts_answer_decides(HttpStatusCode status, string body, ItnValidation expected)
    {
        var handler = new FakeHandler(_ => new HttpResponseMessage(status) { Content = new StringContent(body) });
        Assert.Equal(expected, await Validator(handler).ValidateAsync(Fields, Sandbox, CancellationToken.None));
    }

    [Fact]
    public async Task An_unreachable_payfast_decides_nothing()
    {
        var handler = new FakeHandler(_ => throw new HttpRequestException("no route"));
        Assert.Equal(ItnValidation.Unavailable, await Validator(handler).ValidateAsync(Fields, Sandbox, CancellationToken.None));
    }

    /// <summary>PayFast's sample: every field before <c>signature</c>, PHP url-encoded, in order; no passphrase.</summary>
    [Fact]
    public async Task The_fields_before_the_signature_are_posted_php_encoded_to_the_environments_endpoint()
    {
        var handler = new FakeHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("VALID") });
        await Validator(handler).ValidateAsync(Fields, Sandbox, CancellationToken.None);
        await Validator(handler).ValidateAsync(Fields, Sandbox with { Environment = "live" }, CancellationToken.None);
        await Validator(handler, (PayFastItnValidator.ValidateUrlConfigKey, "http://localhost:4545/eng/query/validate"))
            .ValidateAsync(Fields, Sandbox, CancellationToken.None);

        Assert.Equal("m_payment_id=abc&pf_payment_id=123&item_name=Club+-+5+hours+%285+h%29&amount_gross=550.00", handler.Seen[0].Body);
        Assert.Equal(PayFastItnValidator.SandboxValidateUrl, handler.Seen[0].Uri.ToString());
        Assert.Equal(PayFastItnValidator.LiveValidateUrl, handler.Seen[1].Uri.ToString());
        Assert.Equal("http://localhost:4545/eng/query/validate", handler.Seen[2].Uri.ToString());
        Assert.DoesNotContain("passphrase", handler.Seen[0].Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Validation_switched_off_trusts_without_calling()
    {
        var handler = new FakeHandler(_ => throw new InvalidOperationException("must not be called"));
        var validator = Validator(handler, (PayFastItnValidator.ModeConfigKey, "off"));
        Assert.Equal(ItnValidation.Valid, await validator.ValidateAsync(Fields, Sandbox, CancellationToken.None));
        Assert.Empty(handler.Seen);
    }

    // ---- the source check ----------------------------------------------------------

    private static PayFastSourceCheck Check(string? mode, Func<string, CancellationToken, Task<IPAddress[]>>? resolve = null, string? ranges = null)
    {
        var settings = new Dictionary<string, string?> { [PayFastSourceCheck.ModeConfigKey] = mode, [PayFastSourceCheck.RangesConfigKey] = ranges };
        return new PayFastSourceCheck(new ConfigurationBuilder().AddInMemoryCollection(settings).Build(),
            NullLogger<PayFastSourceCheck>.Instance, resolve ?? ((_, _) => Task.FromResult(Array.Empty<IPAddress>())));
    }

    [Theory]
    [InlineData(null, "197.97.145.144", SourceVerdict.Recognised)]
    [InlineData(null, "41.74.179.223", SourceVerdict.Recognised)]
    [InlineData(null, "::ffff:102.216.36.130", SourceVerdict.Recognised)]
    [InlineData(null, "41.74.179.224", SourceVerdict.Unrecognised)]
    [InlineData("advisory", "203.0.113.9", SourceVerdict.Unrecognised)]
    [InlineData("enforce", "203.0.113.9", SourceVerdict.Refused)]
    [InlineData("enforce", "144.126.193.139", SourceVerdict.Recognised)]
    [InlineData("off", "203.0.113.9", SourceVerdict.NotChecked)]
    public async Task A_source_is_judged_against_payfasts_published_ranges(string? mode, string peer, SourceVerdict expected)
    {
        Assert.Equal(expected, await Check(mode).JudgeAsync(IPAddress.Parse(peer), CancellationToken.None));
    }

    [Fact]
    public async Task A_connection_with_no_peer_is_not_judged()
    {
        Assert.Equal(SourceVerdict.NotChecked, await Check("enforce").JudgeAsync(null, CancellationToken.None));
    }

    [Fact]
    public async Task An_address_a_known_payfast_host_resolves_to_is_recognised_and_the_lookup_is_cached()
    {
        var lookups = 0;
        var check = Check("enforce", (host, _) =>
        {
            Interlocked.Increment(ref lookups);
            return Task.FromResult(host == "w1w.payfast.co.za" ? [IPAddress.Parse("198.51.100.7")] : Array.Empty<IPAddress>());
        });

        Assert.Equal(SourceVerdict.Recognised, await check.JudgeAsync(IPAddress.Parse("198.51.100.7"), CancellationToken.None));
        var first = lookups;
        Assert.Equal(SourceVerdict.Refused, await check.JudgeAsync(IPAddress.Parse("198.51.100.8"), CancellationToken.None));
        Assert.Equal(PayFastProvider.KnownSourceHosts.Length, lookups);
        Assert.True(first <= lookups);
    }

    [Fact]
    public async Task A_failed_lookup_recognises_nothing_and_refuses_nothing_on_its_own()
    {
        var check = Check("advisory", (_, _) => throw new System.Net.Sockets.SocketException());
        Assert.Equal(SourceVerdict.Unrecognised, await check.JudgeAsync(IPAddress.Parse("198.51.100.7"), CancellationToken.None));
        Assert.Equal(SourceVerdict.Recognised, await check.JudgeAsync(IPAddress.Parse("197.97.145.150"), CancellationToken.None));
    }

    [Fact]
    public async Task Configured_ranges_replace_the_published_ones()
    {
        var check = Check("enforce", ranges: "10.9.0.0/16");
        Assert.Equal(SourceVerdict.Recognised, await check.JudgeAsync(IPAddress.Parse("10.9.3.4"), CancellationToken.None));
        Assert.Equal(SourceVerdict.Refused, await check.JudgeAsync(IPAddress.Parse("197.97.145.150"), CancellationToken.None));
    }

    [Fact]
    public void An_unrecognised_mode_is_refused_rather_than_read_as_off()
    {
        Assert.Throws<InvalidOperationException>(() => Check("enforced"));
    }
}
