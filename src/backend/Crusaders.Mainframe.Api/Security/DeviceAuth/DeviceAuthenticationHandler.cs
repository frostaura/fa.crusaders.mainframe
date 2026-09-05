using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Crusaders.Mainframe.Api.Security.DeviceAuth;

public sealed class DeviceAuthOptions : AuthenticationSchemeOptions
{
}

/// <summary>
/// Authenticates a court box by the club's single device API key, presented as
/// <c>Authorization: Bearer &lt;key&gt;</c>.
///
/// <para>
/// The scheme authenticates a <b>club</b>, not a board. Which board is calling comes from
/// the <c>mac</c> in the request body, and an unknown MAC on a heartbeat registers itself
/// (<c>DeviceRegistryService.AutoRegisterAsync</c>) — so a reflashed or replaced box needs
/// no ceremony beyond being flashed with the key. The scheme it replaced signed each
/// request with a per-device HMAC over a canonical string, which meant a nonce cache, a
/// clock window, a provisioning dance to deliver the key and a 401 body carrying the server
/// clock so a clockless board could recover from its own drift. All of it is gone.
/// </para>
///
/// <para>
/// A failure is a bare 401. There is no challenge body: nothing on the box reads one any
/// more, and the one it used to carry (<c>server_unix</c>) existed only to un-wedge the
/// clock check that no longer exists.
/// </para>
/// </summary>
public sealed class DeviceAuthenticationHandler : AuthenticationHandler<DeviceAuthOptions>
{
    public const string SchemeName = "Device";
    public const string DeviceRole = "device";

    private readonly DeviceKeyResolver _resolver;

    public DeviceAuthenticationHandler(
        IOptionsMonitor<DeviceAuthOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder,
        DeviceKeyResolver resolver)
        : base(options, logger, encoder)
    {
        _resolver = resolver;
    }

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var key = DeviceApiKey.FromAuthorizationHeader(Request.Headers.Authorization.ToString());

        // No bearer header at all: not our request. NoResult rather than Fail, so the JWT
        // scheme still gets its turn on endpoints both schemes can serve.
        if (key is null) return AuthenticateResult.NoResult();

        var tenant = await _resolver.ResolveAsync(key, Context.RequestAborted);
        if (tenant is null)
        {
            // A JWT is also a bearer token, so an unrecognised one lands here on every
            // browser request. NoResult, not Fail — failing would turn every member's
            // ordinary API call into a device-scheme authentication failure.
            return AuthenticateResult.NoResult();
        }

        var identity = new ClaimsIdentity(
        [
            new Claim(ClaimTypes.NameIdentifier, $"device:{tenant.Id:D}"),
            new Claim(ClaimTypes.Role, DeviceRole),
            new Claim("tenant_id", tenant.Id.ToString()),
            new Claim("tenant_slug", tenant.Slug),
            new Claim("purpose", "device"),
        ], SchemeName);

        return AuthenticateResult.Success(
            new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName));
    }

    /// <summary>A bare 401. Nothing in the body: why a key was refused is for the log.</summary>
    protected override Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        Response.Headers.WWWAuthenticate = SchemeName;
        return Task.CompletedTask;
    }
}
