using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
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
                },
            });
        });

        return app;
    }
}

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
