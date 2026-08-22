using System.Security.Claims;

namespace Crusaders.Mainframe.Api.Security.DeviceAuth;

/// <summary>
/// Reads the device identity off an authenticated principal.
///
/// <para>
/// Deliberately not folded into <c>CurrentUser.Id()</c>. That reads
/// <c>NameIdentifier</c> and expects a user id; a device's is <c>device:{guid}</c>,
/// which does not parse — so a device can never be mistaken for a user by code that
/// asks for a user, and vice versa. Keeping the two accessors separate is what makes
/// <c>{actor, subject}</c> in the audit trail unambiguous.
/// </para>
/// </summary>
public static class DevicePrincipal
{
    public static Guid? DeviceId(this ClaimsPrincipal? principal)
        => Guid.TryParse(principal?.FindFirstValue("device_id"), out var id) ? id : null;

    public static string? DeviceCode(this ClaimsPrincipal? principal)
        => principal?.FindFirstValue("device_code");

    public static bool IsDevice(this ClaimsPrincipal? principal)
        => principal?.IsInRole(DeviceAuthenticationHandler.DeviceRole) ?? false;
}
