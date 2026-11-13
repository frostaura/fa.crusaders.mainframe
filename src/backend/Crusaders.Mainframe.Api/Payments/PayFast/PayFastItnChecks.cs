using System.Collections.Concurrent;
using System.Net;
using System.Text;

namespace Crusaders.Mainframe.Api.Payments.PayFast;

/// <summary>What PayFast's server said about an ITN it was asked to confirm.</summary>
public enum ItnValidation
{
    /// <summary>PayFast answered <c>VALID</c>: it sent this notification.</summary>
    Valid,

    /// <summary>PayFast answered anything else: it did not send this, or not with these fields.</summary>
    Invalid,

    /// <summary>PayFast could not be asked (timeout, DNS, 5xx). Nothing is decided; PayFast retries the ITN.</summary>
    Unavailable,
}

/// <summary>
/// Step 2½ of receiving an ITN (<c>payments-payfast.md</c>, Receiving an ITN): ask PayFast's own
/// server whether it sent the notification, before any money moves.
/// </summary>
public interface IPayFastItnValidator
{
    /// <summary>
    /// POSTs the received fields (everything before <c>signature</c>, in the order posted, PHP
    /// url-encoded — PayFast's own parameter string, without the passphrase) to the environment's
    /// <c>/eng/query/validate</c>.
    /// </summary>
    Task<ItnValidation> ValidateAsync(
        IReadOnlyList<KeyValuePair<string, string>> fields, PerTenantCredentials creds, CancellationToken ct);
}

/// <summary>
/// The real validator. PayFast's sample integration makes this call on every ITN and so does
/// this one: a passphrase proves the club and PayFast share a secret, the validate call proves
/// PayFast — not somebody holding a leaked passphrase — sent this notification about this payment.
/// </summary>
/// <remarks>
/// <para>
/// <b>Configuration.</b> <c>PayFast:ServerValidation</c> is <c>required</c> (the default) or
/// <c>off</c>; <c>off</c> exists for a stack with no route to PayFast and is logged on every ITN.
/// <c>PayFast:ValidateUrl</c> overrides the endpoint, as <c>PayFast:ProcessUrl</c> overrides the
/// checkout — the mountebank imposter (<c>test/virtualization/payfast</c>) answers it with
/// <c>VALID</c>.
/// </para>
/// </remarks>
public sealed class PayFastItnValidator : IPayFastItnValidator
{
    public const string ClientName = "payfast-validate";
    public const string ValidateUrlConfigKey = "PayFast:ValidateUrl";
    public const string ModeConfigKey = "PayFast:ServerValidation";
    public const string SandboxValidateUrl = "https://sandbox.payfast.co.za/eng/query/validate";
    public const string LiveValidateUrl = "https://www.payfast.co.za/eng/query/validate";

    private readonly IHttpClientFactory _http;
    private readonly ILogger<PayFastItnValidator> _logger;
    private readonly string? _urlOverride;
    private readonly bool _off;

    public PayFastItnValidator(IHttpClientFactory http, IConfiguration config, ILogger<PayFastItnValidator> logger)
    {
        _http = http;
        _logger = logger;
        var url = config[ValidateUrlConfigKey];
        _urlOverride = string.IsNullOrWhiteSpace(url) ? null : url.Trim();
        _off = string.Equals(config[ModeConfigKey]?.Trim(), "off", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>The validate endpoint for a recognised environment (sandbox for test).</summary>
    public static string ValidateUrlFor(string environment) =>
        PayFastEnvironment.ProcessUrl(environment) == PayFastProvider.Live ? LiveValidateUrl : SandboxValidateUrl;

    /// <summary>The parameter string PayFast's validate call expects: the fields before <c>signature</c>, PHP url-encoded, no passphrase.</summary>
    public static string ParameterString(IReadOnlyList<KeyValuePair<string, string>> fields)
    {
        var builder = new StringBuilder();
        foreach (var (key, value) in fields)
        {
            if (string.Equals(key, "signature", StringComparison.OrdinalIgnoreCase)) break;
            if (builder.Length > 0) builder.Append('&');
            builder.Append(key).Append('=').Append(PayFastSignature.UrlEncode(value));
        }
        return builder.ToString();
    }

    public async Task<ItnValidation> ValidateAsync(
        IReadOnlyList<KeyValuePair<string, string>> fields, PerTenantCredentials creds, CancellationToken ct)
    {
        if (_off)
        {
            _logger.LogWarning("PayFast server validation is OFF ({Key}=off); an ITN was trusted on its signature alone", ModeConfigKey);
            return ItnValidation.Valid;
        }

        var url = _urlOverride ?? ValidateUrlFor(creds.Environment);
        try
        {
            using var content = new StringContent(ParameterString(fields), Encoding.ASCII, "application/x-www-form-urlencoded");
            using var response = await _http.CreateClient(ClientName).PostAsync(url, content, ct);
            if ((int)response.StatusCode >= 500)
            {
                _logger.LogWarning("PayFast validate answered {Status}; the ITN is left for PayFast's retry", (int)response.StatusCode);
                return ItnValidation.Unavailable;
            }
            var body = (await response.Content.ReadAsStringAsync(ct)).Trim();
            return response.IsSuccessStatusCode && string.Equals(body, "VALID", StringComparison.Ordinal)
                ? ItnValidation.Valid
                : ItnValidation.Invalid;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            _logger.LogWarning(ex, "PayFast validate could not be reached; the ITN is left for PayFast's retry");
            return ItnValidation.Unavailable;
        }
    }
}

/// <summary>How an ITN's source address is judged (<c>PayFast:SourceCheck</c>).</summary>
public enum SourceCheckMode
{
    /// <summary>Not looked at.</summary>
    Off,

    /// <summary>The default: an unrecognised source is logged and raised to the admins once a day, and the ITN is still judged on its signature and PayFast's validate answer.</summary>
    Advisory,

    /// <summary>An unrecognised source is refused (403). For a deployment that knows its proxy hands the real peer through.</summary>
    Enforce,
}

/// <summary>What the source check concluded about one ITN.</summary>
public enum SourceVerdict
{
    /// <summary>The peer is one of PayFast's published addresses.</summary>
    Recognised,

    /// <summary>The peer is not, and the check is advisory: note it, carry on.</summary>
    Unrecognised,

    /// <summary>The peer is not, and the check is enforced: refuse.</summary>
    Refused,

    /// <summary>The check is off, or the connection carries no peer address to judge.</summary>
    NotChecked,
}

/// <summary>
/// Step 2 of receiving an ITN: is the caller one of PayFast's published addresses?
/// </summary>
/// <remarks>
/// <para>
/// <b>Advisory by default, never primary</b> (<c>payments-payfast.md</c>): the signature and the
/// validate call authenticate a notification. This exists because it is cheap and because a
/// forged ITN from an unknown address is worth an admin hearing about. A reverse proxy that does
/// not hand the real peer through would make <see cref="SourceCheckMode.Enforce"/> refuse every
/// genuine notification, so enforcing is a deployment's explicit choice.
/// </para>
/// <para>
/// <b>Recognised</b> means inside <c>PayFast:SourceRanges</c> (comma-separated CIDRs; default
/// PayFast's published ranges, <see cref="PublishedRanges"/>) or one of the addresses
/// <see cref="PayFastProvider.KnownSourceHosts"/> resolve to (cached ten minutes; a lookup that
/// fails recognises nothing and refuses nothing on its own).
/// </para>
/// </remarks>
public sealed class PayFastSourceCheck
{
    public const string ModeConfigKey = "PayFast:SourceCheck";
    public const string RangesConfigKey = "PayFast:SourceRanges";

    /// <summary>PayFast's published ITN source ranges (developer documentation, "Security checks").</summary>
    public static readonly string[] PublishedRanges =
    [
        "197.97.145.144/28",
        "41.74.179.192/27",
        "102.216.36.0/28",
        "102.216.36.128/28",
        "144.126.193.139/32",
    ];

    private static readonly TimeSpan HostCacheLifetime = TimeSpan.FromMinutes(10);

    private readonly Func<string, CancellationToken, Task<IPAddress[]>> _resolve;
    private readonly ILogger<PayFastSourceCheck> _logger;
    private readonly IReadOnlyList<IPNetwork> _ranges;
    private readonly ConcurrentDictionary<string, (DateTimeOffset At, IPAddress[] Addresses)> _hosts = new(StringComparer.OrdinalIgnoreCase);

    public SourceCheckMode Mode { get; }

    public PayFastSourceCheck(
        IConfiguration config, ILogger<PayFastSourceCheck> logger, Func<string, CancellationToken, Task<IPAddress[]>>? resolve = null)
    {
        _logger = logger;
        _resolve = resolve ?? ((host, ct) => Dns.GetHostAddressesAsync(host, ct));
        Mode = ParseMode(config[ModeConfigKey]);
        var configured = config[RangesConfigKey];
        _ranges = (string.IsNullOrWhiteSpace(configured) ? PublishedRanges : configured.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            .Select(IPNetwork.Parse)
            .ToList();
    }

    /// <summary>An unrecognised mode is refused at startup rather than read as "off".</summary>
    public static SourceCheckMode ParseMode(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        null or "" or "advisory" => SourceCheckMode.Advisory,
        "enforce" => SourceCheckMode.Enforce,
        "off" => SourceCheckMode.Off,
        _ => throw new InvalidOperationException(
            $"{ModeConfigKey} '{value}' is not one of advisory, enforce, off."),
    };

    public async Task<SourceVerdict> JudgeAsync(IPAddress? peer, CancellationToken ct)
    {
        if (Mode == SourceCheckMode.Off || peer is null) return SourceVerdict.NotChecked;
        var address = peer.IsIPv4MappedToIPv6 ? peer.MapToIPv4() : peer;

        if (_ranges.Any(r => r.Contains(address)) || await IsKnownHostAsync(address, ct)) return SourceVerdict.Recognised;

        _logger.LogWarning("A PayFast ITN arrived from {Peer}, which is not one of PayFast's published addresses ({Mode})", address, Mode);
        return Mode == SourceCheckMode.Enforce ? SourceVerdict.Refused : SourceVerdict.Unrecognised;
    }

    private async Task<bool> IsKnownHostAsync(IPAddress address, CancellationToken ct)
    {
        foreach (var host in PayFastProvider.KnownSourceHosts)
        {
            if ((await AddressesOfAsync(host, ct)).Any(a => (a.IsIPv4MappedToIPv6 ? a.MapToIPv4() : a).Equals(address))) return true;
        }
        return false;
    }

    private async Task<IPAddress[]> AddressesOfAsync(string host, CancellationToken ct)
    {
        if (_hosts.TryGetValue(host, out var cached) && DateTimeOffset.UtcNow - cached.At < HostCacheLifetime) return cached.Addresses;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(3));
            var addresses = await _resolve(host, timeout.Token);
            _hosts[host] = (DateTimeOffset.UtcNow, addresses);
            return addresses;
        }
        catch (Exception ex) when (ex is System.Net.Sockets.SocketException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            _logger.LogWarning(ex, "Could not resolve PayFast host {Host} for the ITN source check", host);
            return [];
        }
    }
}
