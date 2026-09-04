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

        g.MapPost("/heartbeat", HeartbeatAsync);

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
    /// A box calling home: last-seen and versions in, the clock, its configuration, an
    /// update if one is due and — since review C2 — the roster it decides scans against.
    /// </summary>
    private static async Task<IResult> HeartbeatAsync(
        HeartbeatRequest req,
        [AsParameters] HeartbeatServices services,
        HttpContext ctx,
        CancellationToken ct)
    {
        var (db, tenant, settings, ota, codes) = services;

        var deviceId = ctx.User.DeviceId();
        if (deviceId is null) return Results.Unauthorized();

        // No IgnoreQueryFilters: the handler has already set the tenant, so this
        // read is filtered exactly like every other request-path query. If the
        // filter were broken the row would not be found and the test would fail,
        // which is the point.
        var device = await db.Devices.FirstOrDefaultAsync(d => d.Id == deviceId.Value, ct);
        if (device is null) return Results.NotFound();

        // Read once. server_time and server_unix are the same instant expressed two
        // ways, and the box re-seeds its clock from them — two reads of the clock
        // could straddle a second boundary and hand it a pair that disagree. The
        // roster's relative seconds are measured from the same instant, for the same
        // reason: the box anchors them to the moment it accepted this response.
        var now = DateTimeOffset.UtcNow;

        device.LastSeenAt = now;
        device.LastIpAddress = ctx.Connection.RemoteIpAddress?.ToString();
        if (!string.IsNullOrWhiteSpace(req.RunningVersion)) device.RunningVersion = req.RunningVersion.Trim();
        if (!string.IsNullOrWhiteSpace(req.MegaVersion)) device.MegaVersion = req.MegaVersion.Trim();

        // A build the box installed and could never make a successful call on. Its
        // own guard already refuses to reinstall it; this is so a human finds out,
        // because a fleet quietly declining an update is the kind of silence that
        // gets noticed a week after the release was promoted everywhere.
        if (!string.IsNullOrWhiteSpace(req.FailedVersion)) device.FailedVersion = req.FailedVersion.Trim();

        await db.SaveChangesAsync(ct);

        var s = await settings.GetAsync(ct);

        // The clock is part of the response because the box has no RTC. It signs
        // with its own clock, so a box that has drifted past the skew window can
        // never call successfully — it re-syncs from the last good response, and
        // failing that from NTP.
        // What this box should be running, or nothing at all.
        //
        // Omitted rather than sent-and-refused when the box already has it: the
        // decision is the firmware's, but there is no reason to make every box in
        // the club re-derive "I already have this" four times a minute, and an
        // absent `ota` object is the ordinary heartbeat.
        var release = ota.For(device);
        var offerUpdate = release is not null
            && !string.Equals(release.Version, device.RunningVersion, StringComparison.Ordinal)
            && !string.Equals(release.Version, device.FailedVersion, StringComparison.Ordinal);

        // The bookings this box may admit on its own, as TOKEN|relay|opens_in|closes_in.
        // Always present, even when empty: the firmware replaces its cache wholesale on
        // every push, and a cancelled booking is expressed by its absence from the next
        // one — an omitted key would leave a stale roster live. See DeviceRosterBuilder.
        var roster = await DeviceRosterBuilder.BuildAsync(db, codes, device, s, now, ct);

        return Results.Ok(new
        {
            server_time = now,
            server_unix = now.ToUnixTimeSeconds(),
            tenant_slug = tenant.TenantSlug,
            device_code = device.DeviceCode,
            // The courts this box drives, in relay order: index 0 = relay A … index
            // 3 = relay D. Replaces the old single court_number — one physical box
            // serves up to four courts (review C4). The button map below is
            // guaranteed to fit this list: both are checked against each other at
            // the moment an admin saves either one (ButtonMap.FirstSelectionBeyond),
            // so nothing here has to warn about a button that selects nothing.
            court_numbers = device.CourtNumbers,
            heartbeat_seconds = s.HeartbeatSeconds,
            ota = offerUpdate
                ? new
                {
                    ota_version = release!.Version,
                    ota_url = release.Url,
                    ota_size = release.SizeBytes,
                }
                : null,
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
            roster,
        });
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

        // One read, two encodings — see the heartbeat for why.
        var now = DateTimeOffset.UtcNow;

        return Results.Ok(new
        {
            // The first clock seed a fresh board ever sees. The box has no RTC and
            // cannot sign a request until it knows the time — a provision response
            // without the clock hands out a key the board can never use, and it
            // deadlocks on 401s until someone reprovisions it.
            server_time = now,
            server_unix = now.ToUnixTimeSeconds(),
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

/// <summary>
/// The services the heartbeat needs, bundled — the same reason as <see cref="WalkUpServices"/>:
/// bound individually they put eight parameters on one handler, past the complexity gate.
/// </summary>
public sealed record HeartbeatServices(
    MainframeDbContext Db,
    ITenantContext Tenant,
    TenantSettingsAccessor Settings,
    OtaCatalogue Ota,
    AccessCodeService Codes);

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
    [property: JsonPropertyName("wifi_rssi")] int? WifiRssi,
    /// <summary>A version this box installed and could never make a working call on.
    /// Reported once, by the only thing that can know it.</summary>
    [property: JsonPropertyName("failed_version")] string? FailedVersion = null);
