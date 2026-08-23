using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Security.Discovery;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The device-facing surface. Everything here authenticates with the <c>Device</c>
/// scheme — an HMAC over a canonical request string — and never with a JWT.
///
/// <para>
/// Heartbeat is deliberately the first endpoint on this surface. It is what proves,
/// end to end and over real HTTP, that a signed request from a board in a cupboard
/// resolves a tenant, passes authorisation and writes to the right rows. Every later
/// device endpoint inherits that path; if this one is wrong they are all wrong.
/// </para>
/// </summary>
public static class DeviceEndpoints
{
    /// <summary>Devices that stop calling within this window are treated as offline by the admin UI.</summary>
    public const int OfflineAfterSeconds = 180;

    public static IEndpointRouteBuilder MapDeviceEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/device")
            .RequireAuthorization(p => p
                .AddAuthenticationSchemes(DeviceAuthenticationHandler.SchemeName)
                .RequireRole(DeviceAuthenticationHandler.DeviceRole))
            .RequireRateLimiting(RateLimitPolicies.Device);

        g.MapPost("/heartbeat", async (
            HeartbeatRequest req,
            MainframeDbContext db,
            ITenantContext tenant,
            TenantSettingsAccessor settings,
            HttpContext ctx,
            CancellationToken ct) =>
        {
            var deviceId = ctx.User.DeviceId();
            if (deviceId is null) return Results.Unauthorized();

            // No IgnoreQueryFilters: the handler has already set the tenant, so this
            // read is filtered exactly like every other request-path query. If the
            // filter were broken the row would not be found and the test would fail,
            // which is the point.
            var device = await db.Devices.FirstOrDefaultAsync(d => d.Id == deviceId.Value, ct);
            if (device is null) return Results.NotFound();

            device.LastSeenAt = DateTimeOffset.UtcNow;
            device.LastIpAddress = ctx.Connection.RemoteIpAddress?.ToString();
            if (!string.IsNullOrWhiteSpace(req.RunningVersion)) device.RunningVersion = req.RunningVersion.Trim();
            if (!string.IsNullOrWhiteSpace(req.MegaVersion)) device.MegaVersion = req.MegaVersion.Trim();

            await db.SaveChangesAsync(ct);

            var s = await settings.GetAsync(ct);

            // The clock is part of the response because the box has no RTC. It signs
            // with its own clock, so a box that has drifted past the skew window can
            // never call successfully — it re-syncs from the last good response, and
            // failing that from NTP.
            return Results.Ok(new
            {
                server_time = DateTimeOffset.UtcNow,
                server_unix = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                tenant_slug = tenant.TenantSlug,
                device_code = device.DeviceCode,
                court_number = device.CourtNumber,
                heartbeat_seconds = 60,
                config = new
                {
                    slice_minutes = s.SliceMinutes,
                    grace_window_minutes = s.GraceWindowMinutes,
                    // What each of the eight buttons does, by physical position. Sent on
                    // every heartbeat rather than only when it changes: a box that
                    // rebooted and missed the change would otherwise open the wrong
                    // court until somebody edited the setting again.
                    button_map = s.Buttons.ToWire(),
                },
            });
        });

        // Provisioning is deliberately OUTSIDE the signed group above: a board collecting
        // its key does not have one yet, so it cannot sign. It authenticates with the
        // claim code instead — which it generated, is displaying on its own LCD, and has
        // never put on the wire.
        app.MapPost("/api/v1/device/provision", ProvisionAsync)
           .AllowAnonymous()
           .RequireRateLimiting(RateLimitPolicies.Auth);

        return app;
    }

    /// <summary>
    /// Hands a freshly-claimed board its device key, once.
    ///
    /// <para>
    /// The direction is inverted on purpose. Pushing the key to the address the board
    /// announced from would mean dialling an address that arrived in an unauthenticated
    /// UDP datagram — exactly what <c>OutboundAddressGuard</c> exists to prevent, and a
    /// discovered RFC1918 address is by definition not on its allow-list. Having the
    /// board fetch instead means nothing dials anything and the API's outbound posture is
    /// unchanged.
    /// </para>
    ///
    /// <para>
    /// Anonymous, so the failure responses are deliberately uniform: a wrong code, an
    /// unknown MAC and an expired grant are indistinguishable to the caller. Telling them
    /// apart would turn this into an oracle for which boards are mid-claim.
    /// </para>
    /// </summary>
    private static IResult ProvisionAsync(
        ProvisionRequest req,
        ProvisioningGrants grants,
        IDeviceKeyDeriver keys,
        DiscoveryOptions discovery,
        HttpContext ctx)
    {
        if (string.IsNullOrWhiteSpace(req.Mac) || string.IsNullOrWhiteSpace(req.ClaimCode))
        {
            return Results.BadRequest(new { error = "mac_and_claim_code_required" });
        }

        var grant = grants.Redeem(req.Mac.Trim(), req.ClaimCode);
        if (grant is null)
        {
            return Results.NotFound(new
            {
                error = "no_pending_claim",
                message = "No claim is pending for this board, or the code did not match. Ask an admin to connect it again.",
            });
        }

        return Results.Ok(new
        {
            device_id = grant.DeviceId,
            tenant_slug = grant.TenantSlug,
            key_version = grant.KeyVersion,
            device_key = keys.DeriveEncoded(grant.TenantId, grant.DeviceId, grant.KeyVersion),
            // Not discovered — echoed. The board reached this endpoint somehow, so the
            // address it used is by construction one that works from where it is
            // standing. An explicitly configured value still wins, for a club that
            // fronts the API with a name the boards must use instead.
            api_base_url = !string.IsNullOrWhiteSpace(discovery.AdvertisedBaseUrl)
                ? discovery.AdvertisedBaseUrl
                : $"{ctx.Request.Scheme}://{ctx.Request.Host}",
        });
    }
}

/// <summary>What a board presents to collect its key. The MAC identifies the grant; the
/// claim code authenticates it.</summary>
public sealed record ProvisionRequest(
    [property: JsonPropertyName("mac")] string? Mac,
    [property: JsonPropertyName("claim_code")] string? ClaimCode);

/// <summary>
/// What a court box reports about itself. Every field is optional: a box that has just
/// been flashed knows its version but not yet its Mega's.
///
/// <para>
/// The names are pinned with <see cref="JsonPropertyNameAttribute"/> rather than left
/// to the default binder. The application configures no naming policy, so responses
/// are hand-written snake_case while requests bind camelCase — an asymmetry the
/// browser client absorbs invisibly and a hand-rolled JSON writer on an ESP does not.
/// Pinning them makes the device wire format snake_case in both directions, and makes
/// it a compile-time artefact instead of a convention someone has to remember.
/// </para>
/// </summary>
public sealed record HeartbeatRequest(
    [property: JsonPropertyName("running_version")] string? RunningVersion,
    [property: JsonPropertyName("mega_version")] string? MegaVersion,
    [property: JsonPropertyName("uptime_seconds")] long? UptimeSeconds,
    [property: JsonPropertyName("wifi_rssi")] int? WifiRssi);
