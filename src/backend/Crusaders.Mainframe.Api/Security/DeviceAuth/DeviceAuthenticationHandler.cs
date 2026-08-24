using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Crusaders.Mainframe.Api.Security.DeviceAuth;

public sealed class DeviceAuthOptions : AuthenticationSchemeOptions
{
}

/// <summary>
/// Authenticates a physical device by HMAC over a canonical request string.
///
/// <para>
/// This class does HTTP only: read the headers, buffer the body, hand a
/// <see cref="DeviceCredential"/> to <see cref="DeviceVerifier"/>, turn its answer into
/// an <c>AuthenticateResult</c>. The security decision — and the tenant assignment that
/// goes with it — lives in the verifier.
/// </para>
///
/// <para>
/// <b>The verifier sets the tenant context</b>, and that is not incidental. The three
/// existing courtside endpoints sit on a path prefix that the tenant middleware skips,
/// and nothing behind it ever calls <c>Set</c> — so <c>TenantId</c> stays
/// <c>Guid.Empty</c>, every query filter matches nothing, and any row they did write
/// would land orphaned at the empty tenant, invisible to every query and to the balance
/// sum. A device scheme that authenticated but left the tenant unset would reproduce
/// that bug exactly.
/// </para>
/// </summary>
public sealed class DeviceAuthenticationHandler : AuthenticationHandler<DeviceAuthOptions>
{
    public const string SchemeName = "Device";
    public const string DeviceRole = "device";

    private readonly DeviceVerifier _verifier;

    public DeviceAuthenticationHandler(
        IOptionsMonitor<DeviceAuthOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder,
        DeviceVerifier verifier)
        : base(options, logger, encoder)
    {
        _verifier = verifier;
    }

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var credential = await ReadCredentialAsync(Request);

        if (credential is null)
        {
            // Either no device headers at all — this request is not for us, so NoResult
            // rather than Fail, leaving the JWT scheme its turn on shared endpoints —
            // or headers that are present but malformed, which is the same to a caller.
            return Request.Headers.ContainsKey(DeviceRequestSigner.DeviceIdHeader)
                ? AuthenticateResult.Fail("Device credential headers are missing or malformed.")
                : AuthenticateResult.NoResult();
        }

        var result = await _verifier.VerifyAsync(credential, Context.RequestAborted);
        if (!result.Succeeded) return AuthenticateResult.Fail(result.Failure!);

        var identity = new ClaimsIdentity(
        [
            new Claim(ClaimTypes.NameIdentifier, $"device:{result.Device!.Id:D}"),
            new Claim(ClaimTypes.Role, DeviceRole),
            new Claim("device_id", result.Device.Id.ToString()),
            new Claim("device_code", result.Device.DeviceCode),
            new Claim("device_kind", result.Device.Kind.ToString()),
            new Claim("tenant_id", result.Tenant!.Id.ToString()),
            new Claim("tenant_slug", result.Tenant.Slug),
            new Claim("purpose", "device"),
        ], SchemeName);

        return AuthenticateResult.Success(
            new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName));
    }

    /// <summary>
    /// Every Device-scheme 401 carries the server's clock in its body. The box has no
    /// RTC: a board whose clock has skewed past the verifier's window can never sign a
    /// valid request again, so an empty 401 would strand it until someone reprovisioned
    /// it. The firmware (<c>DeviceClient::react</c>) reads <c>server_unix</c> from this
    /// body, re-seeds its clock and retries. Nothing else goes in the body — why
    /// authentication failed is for the log, never for the response (see
    /// <see cref="DeviceVerification"/>).
    /// </summary>
    protected override async Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        Response.Headers.WWWAuthenticate = SchemeName;
        Response.ContentType = "application/json";
        await Response.WriteAsync(
            $"{{\"server_unix\":{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}}}",
            Context.RequestAborted);
    }

    /// <summary>Returns null when the headers are absent or unusable — the caller distinguishes the two.</summary>
    private static async Task<DeviceCredential?> ReadCredentialAsync(HttpRequest req)
    {
        if (!Guid.TryParse(req.Headers[DeviceRequestSigner.DeviceIdHeader].ToString(), out var deviceId))
        {
            return null;
        }

        var nonce = req.Headers[DeviceRequestSigner.NonceHeader].ToString();
        var signature = req.Headers[DeviceRequestSigner.SignatureHeader].ToString();

        if (!long.TryParse(req.Headers[DeviceRequestSigner.TimestampHeader].ToString(), out var unixSeconds)
            || string.IsNullOrWhiteSpace(nonce)
            || string.IsNullOrWhiteSpace(signature))
        {
            return null;
        }

        req.EnableBuffering();
        var body = await ReadBodyAsync(req);

        return new DeviceCredential(
            deviceId, unixSeconds, nonce, signature, req.Method, req.Path + req.QueryString, body);
    }

    private static async Task<byte[]> ReadBodyAsync(HttpRequest req)
    {
        if (req.ContentLength is null or 0)
        {
            return [];
        }

        req.Body.Position = 0;
        using var ms = new MemoryStream();
        await req.Body.CopyToAsync(ms);
        req.Body.Position = 0;
        return ms.ToArray();
    }
}
