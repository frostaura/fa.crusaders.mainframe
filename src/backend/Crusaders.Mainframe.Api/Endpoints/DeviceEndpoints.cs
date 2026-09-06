using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.RateLimiting;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The device-facing surface. Everything here authenticates with the <c>Device</c>
/// scheme — the club's one API key as a bearer token — and never with a JWT.
///
/// <para>
/// Heartbeat is deliberately the first endpoint on this surface. It is what proves,
/// end to end and over real HTTP, that a request from a board in a cupboard resolves a
/// tenant, passes authorisation and writes to the right rows. Every later device
/// endpoint inherits that path; if this one is wrong they are all wrong. It is also the
/// only endpoint that will create a device row: a board that has never called before
/// appears on the Devices page by heartbeating, and there is no provisioning step at all.
/// </para>
/// </summary>
public static class DeviceEndpoints
{
    public static IEndpointRouteBuilder MapDeviceEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/device")
            .RequireAuthorization(p => p
                .AddAuthenticationSchemes(DeviceAuthenticationHandler.SchemeName)
                .RequireRole(DeviceAuthenticationHandler.DeviceRole))
            .RequireRateLimiting(RateLimitPolicies.Device);

        g.MapPost("/heartbeat", HeartbeatAsync);

        return app;
    }

    /// <summary>
    /// A box calling home: last-seen and versions in, its configuration and the roster it
    /// decides scans against out — and, the first time, the row itself.
    /// </summary>
    private static async Task<IResult> HeartbeatAsync(
        HeartbeatRequest req,
        [AsParameters] HeartbeatServices services,
        HttpContext ctx,
        CancellationToken ct)
    {
        var (db, tenant, settings, registry, codes) = services;

        var (device, refusal) = await DeviceIdentity.ResolveOrRegisterAsync(db, registry, req.Mac, ct);
        if (refusal is not null) return refusal;

        // Read once. The roster's relative seconds are all measured from the same instant,
        // because the box anchors them to the moment it accepted this response.
        var now = DateTimeOffset.UtcNow;
        var s = await settings.GetAsync(ct);

        // Moves LastSeenAt AND, if this call ends a silence past the club's own threshold,
        // records that silence — in this same save, because LastSeenAt is the evidence it
        // would otherwise erase and the no-show waiver is settled from it. DeviceSilenceLog
        // says why the health sweep alone cannot see this case.
        DeviceSilenceLog.NoteHeartbeat(db, device!, now, HeartbeatCadence.OfflineAfterSeconds(s.HeartbeatSeconds));

        device!.LastIpAddress = ctx.Connection.RemoteIpAddress?.ToString();
        if (req.EffectiveRunningVersion is { } running) device.RunningVersion = running;
        if (!string.IsNullOrWhiteSpace(req.MegaVersion)) device.MegaVersion = req.MegaVersion.Trim();

        await db.SaveChangesAsync(ct);

        // The bookings this box may admit on its own, as TOKEN|relay|opens_in|closes_in.
        // Always present, even when empty: the firmware replaces its cache wholesale on
        // every push, and a cancelled booking is expressed by its absence from the next
        // one — an omitted key would leave a stale roster live. See DeviceRosterBuilder.
        var roster = await DeviceRosterBuilder.BuildAsync(db, codes, device, s, now, ct);

        return Results.Ok(new
        {
            server_time = now,
            tenant_slug = tenant.TenantSlug,
            device_code = device.DeviceCode,
            // The courts this box drives, in relay order: index 0 = relay A … index
            // 3 = relay D. Replaces the old single court_number — one physical box
            // serves up to four courts (review C4). The button map below is the
            // EFFECTIVE one for this box — its own override, else the club's — and
            // is guaranteed to fit this list: the pair is checked at the moment an
            // admin saves either one (ButtonMap.FirstSelectionBeyond), and
            // auto-registration derives an override rather than leaving a mismatch.
            court_numbers = device.CourtNumbers,
            heartbeat_seconds = s.HeartbeatSeconds,
            config = new
            {
                slice_minutes = s.SliceMinutes,
                grace_window_minutes = s.GraceWindowMinutes,
                // What each of the eight buttons does, by physical position. Sent on
                // every heartbeat rather than only when it changes: a box that
                // rebooted and missed the change would otherwise open the wrong
                // court until somebody edited the setting again. Same wire shape
                // whether the map is the box's own or the club's.
                button_map = ButtonMap.EffectiveFor(device.ButtonMapJson, s.Buttons).ToWire(),
            },
            roster,
        });
    }
}

/// <summary>
/// The services the heartbeat needs, bundled — the same reason as <see cref="WalkUpServices"/>:
/// bound individually they put too many parameters on one handler, past the complexity gate.
/// </summary>
public sealed record HeartbeatServices(
    MainframeDbContext Db,
    ITenantContext Tenant,
    TenantSettingsAccessor Settings,
    DeviceRegistryService Registry,
    AccessCodeService Codes);

/// <summary>
/// What a court box reports about itself. Only <c>mac</c> is required — it is the board's
/// whole identity now that the club key says nothing about which board is calling.
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
    [property: JsonPropertyName("mac")] string? Mac,
    [property: JsonPropertyName("firmware_version")] string? FirmwareVersion,
    [property: JsonPropertyName("uptime_ms")] long? UptimeMs,
    /// <summary>The ATmega's version, when the box has read it. Absent from a box that has just been flashed.</summary>
    [property: JsonPropertyName("mega_version")] string? MegaVersion = null,
    /// <summary>
    /// Accepted as a synonym of <see cref="FirmwareVersion"/>. The shared corpus pins the
    /// field as <c>firmware_version</c> and the firmware wrote <c>running_version</c> for
    /// its first two releases; taking both means a box on an older build reports a version
    /// rather than silently reporting none.
    /// </summary>
    [property: JsonPropertyName("running_version")] string? RunningVersion = null)
{
    /// <summary>The reported version under either name, trimmed — or null when neither was sent.</summary>
    public string? EffectiveRunningVersion
    {
        get
        {
            var value = !string.IsNullOrWhiteSpace(FirmwareVersion) ? FirmwareVersion : RunningVersion;
            return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        }
    }
}
