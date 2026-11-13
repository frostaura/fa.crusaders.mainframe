using System.Security.Claims;

namespace Crusaders.Mainframe.Api.Security.DeviceAuth;

/// <summary>
/// Reads the device-scheme identity off an authenticated principal.
///
/// <para>
/// Deliberately not folded into <c>CurrentUser.Id()</c>. That reads
/// <c>NameIdentifier</c> and expects a user id; a device's is <c>device:{guid}</c>,
/// which does not parse — so a device can never be mistaken for a user by code that
/// asks for a user, and vice versa. Keeping the two accessors separate is what makes
/// <c>{actor, subject}</c> in the audit trail unambiguous.
/// </para>
///
/// <para>
/// There is no <c>DeviceId</c> accessor any more. The key authenticates a club, not a
/// board, so the principal cannot name one: the board names itself with the <c>mac</c>
/// in the request body. See <c>DeviceIdentity</c>.
/// </para>
/// </summary>
public static class DevicePrincipal
{
    public static Guid? DeviceTenantId(this ClaimsPrincipal? principal)
        => Guid.TryParse(principal?.FindFirstValue("tenant_id"), out var id) ? id : null;

    /// <summary>The id number of the club key this device request authenticated with, or null.</summary>
    public static int? DeviceKeyId(this ClaimsPrincipal? principal)
        => int.TryParse(principal?.FindFirstValue(DeviceAuthenticationHandler.DeviceKeyIdClaim),
            System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var id) ? id : null;
}
