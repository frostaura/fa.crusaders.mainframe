using System.Text;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Microsoft.AspNetCore.Authentication;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// Which bucket a device request is charged to — review round 16 (FW16's offer, D16-2's server half).
///
/// <para>
/// <b>Why per board.</b> The device limiter was ONE bucket per club (120 a minute). A board refused
/// with 401/403/404/429 — a disabled box on bridge 2.2.5, which re-posted its head event every pass
/// in about 5 ms — spent the whole club's minute in under a second, and every other box and the door
/// gate were then answered 429 for the rest of it: one misbehaving board took the club's lights and
/// doors offline. Charged to its own bucket, the board only exhausts itself.
/// </para>
///
/// <para>
/// <b>Where the board's identity comes from.</b> One club key is shared by every board (the device
/// contract is hobby grade), so the request's credentials cannot tell boards apart; the body's
/// <c>mac</c> can. The limiter partitions before the endpoint reads the body, so this middleware —
/// before the limiter — authenticates the key and buffers a device POST and reads the <c>mac</c> out of
/// its first <see cref="PrefixBytes"/> (every firmware writes it first), then rewinds the body for
/// <see cref="Endpoints.DeviceBody"/>. No MAC readable: the club's bucket, as before. Not
/// authenticated: never read, the caller's address as before.
/// </para>
///
/// <para>
/// The MAC is the caller's to choose, so a holder of the club key could spread a flood over invented
/// MACs; that is a stolen key, which the limiter never defended (the global per-address ceiling still
/// applies), and the registry's ceiling on unacknowledged boards bounds what such a flood can create.
/// </para>
/// </summary>
public static class DeviceRateKey
{
    /// <summary>How much of a device body is read for its MAC.</summary>
    public const int PrefixBytes = 4096;

    private const string ItemKey = "crusaders.device-rate-mac";

    private const string TenantItemKey = "crusaders.device-rate-tenant";

    /// <summary>The device limiter's partition key: the board when its MAC was read, else the club, else the address.</summary>
    public static string Of(HttpContext ctx, string clientAddress)
    {
        var tenantId = ctx.Items[TenantItemKey] as Guid? ?? ctx.User.DeviceTenantId();
        if (tenantId is not { } id) return $"ip:{clientAddress}";
        return ctx.Items[ItemKey] is string mac ? $"device:{id:N}:{mac}" : $"tenant:{id:N}";
    }

    /// <summary>
    /// Authenticates a device request's key and reads its body's MAC, ahead of the rate limiter.
    ///
    /// <para>
    /// <b>The device scheme is not the default one</b>, so <c>UseAuthentication</c> never ran it: it ran
    /// at authorization, AFTER the limiter, and every device call was partitioned by client address —
    /// one bucket for every board behind the same gateway, whatever the comment on the policy said.
    /// The scheme's own handler is asked here (its result is cached for the request, so authorization
    /// does not ask twice). The cost is one key lookup per device request before the limiter, which
    /// the global per-address ceiling still bounds.
    /// </para>
    /// </summary>
    public static IApplicationBuilder UseDeviceRateKey(this IApplicationBuilder app) =>
        app.Use(async (ctx, next) =>
        {
            if (HttpMethods.IsPost(ctx.Request.Method) && ctx.Request.Path.StartsWithSegments("/api/v1/device"))
            {
                var auth = await ctx.AuthenticateAsync(DeviceAuthenticationHandler.SchemeName);
                if (auth.Succeeded && auth.Principal.DeviceTenantId() is { } tenant)
                {
                    ctx.Items[TenantItemKey] = tenant;
                    await NoteMacAsync(ctx);
                }
            }
            await next(ctx);
        });

    private static async Task NoteMacAsync(HttpContext ctx)
    {
        ctx.Request.EnableBuffering();
        var buffer = new byte[PrefixBytes];
        var filled = 0;
        int read;
        while (filled < buffer.Length
               && (read = await ctx.Request.Body.ReadAsync(buffer.AsMemory(filled), ctx.RequestAborted)) > 0)
        {
            filled += read;
        }
        ctx.Request.Body.Position = 0;

        var match = Endpoints.DeviceBody.MacField().Match(Encoding.UTF8.GetString(buffer, 0, filled));
        if (match.Success && DeviceRegistryService.NormaliseMacAddress(match.Groups[1].Value) is { } mac)
        {
            ctx.Items[ItemKey] = mac;
        }
    }
}
