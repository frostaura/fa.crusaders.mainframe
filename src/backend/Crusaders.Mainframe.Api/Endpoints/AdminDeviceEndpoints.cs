using System.Text.Json;
using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Admin management of the physical devices allowed to talk to this tenant.
///
/// <para>
/// The derived key is returned <b>once</b>, on registration and on rotation, and is
/// never readable afterwards — it is not stored, so there is nothing to read back.
/// That mirrors how <c>WebhookEndpoints</c> hands out an endpoint secret, and it is
/// the reason rotation is a first-class operation rather than an afterthought.
/// </para>
///
/// <para>
/// The work is in <see cref="DeviceRegistryService"/>; this file is routing and shape.
/// </para>
/// </summary>
public static class AdminDeviceEndpoints
{
    public static IEndpointRouteBuilder MapAdminDeviceEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/devices").RequireAuthorization(p => p.RequireRole("admin"));

        g.MapGet("/", ListAsync);
        g.MapPost("/", RegisterAsync);
        g.MapPost("/{id:guid}/rotate-key", RotateKeyAsync);
        g.MapPatch("/{id:guid}", UpdateAsync);
        g.MapPost("/{id:guid}/revoke", RevokeAsync);

        return app;
    }

    /// <summary>
    /// The tenant's configured heartbeat interval, which every device view carries so the
    /// page can derive an offline threshold from it rather than hardcoding one. See
    /// <see cref="DeviceView"/> and <see cref="HeartbeatCadence"/>.
    /// </summary>
    private static async Task<int> HeartbeatSecondsAsync(TenantSettingsAccessor settingsAccessor, CancellationToken ct)
        => (await settingsAccessor.GetAsync(ct)).HeartbeatSeconds;

    private static async Task<IResult> ListAsync(
        DeviceRegistryService devices, TenantSettingsAccessor settingsAccessor, CancellationToken ct)
    {
        var heartbeat = await HeartbeatSecondsAsync(settingsAccessor, ct);
        return Results.Ok((await devices.ListAsync(ct)).Select(d => DeviceView.Of(d, heartbeat)).ToList());
    }

    private static async Task<IResult> RegisterAsync(
        RegisterDeviceRequest req, DeviceRegistryService devices, TenantSettingsAccessor settingsAccessor,
        HttpContext ctx, CancellationToken ct)
    {
        var invalid = Validate(req);
        if (invalid is not null) return Results.BadRequest(new { error = invalid });

        if (ParseRegistrationButtonMap(req, out var buttons) is { } badMap) return badMap;
        if (ParseRegistrationMac(req, out var mac) is { } badMac) return badMac;

        // A MAC is what makes a hand-registered box recoverable later: given one, this
        // endpoint reclaims the row that already owns it — re-keyed, un-revoked — exactly
        // as the discovery claim does. See ParseRegistrationMac.
        var existing = mac is null ? null : await devices.FindByMacAddressAsync(mac, ct);

        if (await IsDeviceCodeTakenAsync(devices, req.DeviceCode, existing, ct))
        {
            return Results.Conflict(new { error = "device_code_taken" });
        }

        // The map this box will run — its own override when the request carries one, else
        // the club's — must be able to address its court list, and the list must name real
        // courts. A list naming a court the club does not have is refused here, where the
        // admin can act on it. A map that reaches past the list is refused only when the
        // admin wrote it; otherwise the club's map is trimmed to fit this box and stored as
        // its override, because "your club map names four courts and this box drives two"
        // used to be a dead end from this screen. See ResolveCourtAssignmentAsync.
        //
        // A registration either carries a map or does not; there is no "clear" on this
        // path, so an absent one is no opinion at all and is the trim's to derive.
        var assignment = req.Kind == DeviceKind.CourtBox
            ? await devices.ResolveCourtAssignmentAsync(
                req.CourtNumbers!, buttons is null ? null : new Optional<ButtonMap?>(buttons), null, ct)
            : new CourtAssignment(null, buttons, false);
        if (assignment.Error is { } mismatch) return Results.BadRequest(new { error = mismatch });
        buttons = assignment.Override;

        var command = new RegisterDeviceCommand(req.DeviceCode, req.Name, req.Kind, req.Hardware, req.CourtNumbers, req.GateKey)
        {
            ButtonMap = buttons,
            MacAddress = mac,
        };

        var registered = existing is null
            ? await devices.RegisterAsync(command, ctx.User.Id() ?? Guid.Empty, ct)
            : await devices.ReclaimAsync(existing, command, ctx.User.Id() ?? Guid.Empty, ct);

        // Shown once. Flash it into the device's secrets.h and do not keep a copy here.
        return Results.Ok(new
        {
            // True when this MAC already had a row here — revoked, reflashed, or key lost —
            // and that row was re-keyed and re-enabled rather than duplicated.
            reclaimed = existing is not null,
            device = DeviceView.Of(registered.Device, await HeartbeatSecondsAsync(settingsAccessor, ct)),
            device_key = registered.DeviceKey,
            key_version = registered.Device.KeyVersion,
            // True when this box got a button map derived from the club's rather than the
            // club's own — its court buttons beyond its relay count are off. The map itself
            // is in device.button_map.
            button_map_trimmed = assignment.Trimmed,
            note = existing is null
                ? "Store this key on the device now. It is derived, not stored, and cannot be shown again."
                : "This board was already registered here; its row has been re-keyed and re-enabled. Store the new key on the device now — it cannot be shown again.",
        });
    }

    private static async Task<IResult> RotateKeyAsync(
        Guid id, DeviceRegistryService devices, TenantSettingsAccessor settingsAccessor,
        HttpContext ctx, CancellationToken ct)
    {
        var device = await devices.FindAsync(id, ct);
        if (device is null) return Results.NotFound();

        var rotated = await devices.RotateKeyAsync(device, ctx.User.Id() ?? Guid.Empty, ct);

        return Results.Ok(new
        {
            device = DeviceView.Of(rotated.Device, await HeartbeatSecondsAsync(settingsAccessor, ct)),
            device_key = rotated.DeviceKey,
            key_version = rotated.Device.KeyVersion,
            // The board cannot be handed this key: its next signed call is refused, it
            // drops to CLAIM CODE, and connecting it again re-keys this same row and
            // issues the grant it collects. See DeviceRegistryService.RotateKeyAsync.
            note = "The board's old key stops working now. It will show a new claim code on its LCD; connect it again from the discovered boards list to deliver the new key.",
        });
    }

    private static async Task<IResult> UpdateAsync(
        Guid id, UpdateDeviceRequest req, DeviceRegistryService devices, TenantSettingsAccessor settingsAccessor,
        HttpContext ctx, CancellationToken ct)
    {
        var device = await devices.FindAsync(id, ct);
        if (device is null) return Results.NotFound();

        if (ParseButtonMapPatch(req.ButtonMap, out var buttons) is { } badMap) return badMap;

        // The effective map after this PATCH — the override it sets, else the one the row
        // keeps, else the club's — must be able to address the effective court list, and a
        // new list must be well-formed and name real courts. Same three rules as
        // registration, including the trim: shrinking a box's court list turns off the
        // court buttons it no longer has rather than refusing the edit.
        var resolved = await AssignmentAsync(devices, device, req.CourtNumbers, buttons, ct);
        if (resolved is { } outcome)
        {
            if (outcome.Error is { } invalid) return Results.BadRequest(new { error = invalid });
            buttons = new Optional<ButtonMap?>(outcome.Override);
        }

        var updated = await devices.UpdateAsync(
            device,
            new UpdateDeviceCommand(req.Name, req.Enabled, req.CourtNumbers, req.OtaChannel, req.PinnedVersion, buttons),
            ctx.User.Id() ?? Guid.Empty, ct);

        return Results.Ok(DeviceView.Of(updated, await HeartbeatSecondsAsync(settingsAccessor, ct)));
    }

    /// <summary>
    /// The override a registration carries, or the refusal. Absent is not an error — it
    /// means "run the club's map", which <see cref="DeviceRegistryService.ResolveCourtAssignmentAsync"/>
    /// then either honours or trims to fit.
    /// </summary>
    private static IResult? ParseRegistrationButtonMap(RegisterDeviceRequest req, out ButtonMap? buttons)
    {
        buttons = null;
        if (req.ButtonMap is null) return null;

        return ButtonMap.TryParse(req.ButtonMap, out buttons, out var reason)
            ? null
            : Results.BadRequest(new { error = "button_map_invalid", message = reason });
    }

    /// <summary>
    /// The board's MAC in the form the boards announce, or the refusal. Absent is not an
    /// error — a MAC is optional, and a box registered without one simply cannot be
    /// recovered this way.
    ///
    /// <para>
    /// Why it is worth typing: a revoked hand-registered box used to have no way back at
    /// all. Revoking sets <c>RevokedAt</c> for ever and nothing clears it, rotation issues
    /// no provisioning grant, and the discovery claim's un-revoke path finds its row BY MAC
    /// — which a hand-registered row did not have, because this endpoint would not accept
    /// one. The admin's only move was to register the same hardware again under a different
    /// device code, leaving a dead row and two identities for one physical box.
    /// </para>
    /// </summary>
    private static IResult? ParseRegistrationMac(RegisterDeviceRequest req, out string? mac)
    {
        mac = null;
        if (string.IsNullOrWhiteSpace(req.MacAddress)) return null;

        mac = DeviceRegistryService.NormaliseMacAddress(req.MacAddress);
        return mac is null
            ? Results.BadRequest(new { error = DeviceRegistryService.MacAddressInvalid })
            : null;
    }

    /// <summary>
    /// Whether this device code belongs to some OTHER row. The row being reclaimed is
    /// excluded, or re-registering a revoked box under its own code would collide with
    /// itself — which is precisely the dead end the MAC lookup exists to end.
    /// </summary>
    private static Task<bool> IsDeviceCodeTakenAsync(
        DeviceRegistryService devices, string deviceCode, Device? existing, CancellationToken ct)
        => existing is null
            ? devices.DeviceCodeTakenAsync(deviceCode.Trim(), ct)
            : devices.DeviceCodeTakenAsync(deviceCode.Trim(), existing.Id, ct);

    /// <summary>
    /// button_map on a PATCH is three-valued: absent leaves the override alone, null clears
    /// it (back to the club's map), a list sets it. Bound as a JsonElement because a nullable
    /// list cannot tell the first two apart. Returns the refusal, or null when the value is
    /// usable (including absent).
    /// </summary>
    private static IResult? ParseButtonMapPatch(JsonElement element, out Optional<ButtonMap?>? buttons)
    {
        buttons = null;
        if (element.ValueKind == JsonValueKind.Undefined) return null;
        if (element.ValueKind == JsonValueKind.Null)
        {
            buttons = new Optional<ButtonMap?>(null);
            return null;
        }
        if (element.ValueKind != JsonValueKind.Array)
        {
            return Results.BadRequest(new { error = "button_map_invalid", message = "button_map must be a list of eight entries or null" });
        }

        var wire = element.EnumerateArray().Select(e => e.ValueKind == JsonValueKind.String ? e.GetString() ?? "" : "?").ToList();
        if (!ButtonMap.TryParse(wire, out var parsed, out var reason))
        {
            return Results.BadRequest(new { error = "button_map_invalid", message = reason });
        }
        buttons = new Optional<ButtonMap?>(parsed);
        return null;
    }

    /// <summary>
    /// The court-list and effective-map rules for a PATCH, or null when nothing relevant
    /// changed — in which case the request's own button_map is left exactly as it arrived,
    /// including absent.
    /// </summary>
    private static async Task<CourtAssignment?> AssignmentAsync(
        DeviceRegistryService devices, Device device, IReadOnlyList<int>? newCourts, Optional<ButtonMap?>? buttons, CancellationToken ct)
    {
        if (device.Kind != DeviceKind.CourtBox || (newCourts is null && buttons is null)) return null;

        var courts = newCourts ?? device.CourtNumbers;
        if (newCourts is not null && DeviceRegistryService.ValidateCourtNumbers(courts) is { } bad)
        {
            return new CourtAssignment(bad, null, false);
        }

        // buttons is already the three-valued shape ResolveCourtAssignmentAsync wants:
        // absent means the caller said nothing about the map, so shrinking the court list
        // trims it; null means they explicitly asked for the club's map and is refused when
        // it does not fit; a list is theirs and is refused when it does not fit.
        return await devices.ResolveCourtAssignmentAsync(courts, buttons, device.ButtonMapJson, ct);
    }

    private static async Task<IResult> RevokeAsync(
        Guid id, DeviceRegistryService devices, TenantSettingsAccessor settingsAccessor,
        HttpContext ctx, CancellationToken ct)
    {
        var device = await devices.FindAsync(id, ct);
        if (device is null) return Results.NotFound();

        return Results.Ok(DeviceView.Of(
            await devices.RevokeAsync(device, ctx.User.Id() ?? Guid.Empty, ct),
            await HeartbeatSecondsAsync(settingsAccessor, ct)));
    }

    private static string? Validate(RegisterDeviceRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.DeviceCode)) return "device_code_required";
        if (req.DeviceCode.Length > 64) return "device_code_too_long";
        if (string.IsNullOrWhiteSpace(req.Name)) return "name_required";

        // A court box drives a set of courts; a gate opens a specific gate. Mixing
        // them means a heartbeat cannot be routed to anything.
        if (req.Kind == DeviceKind.CourtBox && DeviceRegistryService.ValidateCourtNumbers(req.CourtNumbers) is { } courts)
        {
            return courts;
        }
        if (req.Kind == DeviceKind.Gate && string.IsNullOrWhiteSpace(req.GateKey)) return "gate_key_required_for_gate";

        return null;
    }
}

/// <summary>
/// <c>court_numbers</c> is pinned to snake_case like the discovery claim's request,
/// because the same admin screen builds both bodies; the remaining fields bind
/// case-insensitively from the camelCase the screen already sends. The list is in
/// relay order — see <c>Device.CourtNumbers</c>.
/// </summary>
public sealed record RegisterDeviceRequest(
    string DeviceCode,
    string Name,
    DeviceKind Kind,
    DeviceHardware Hardware,
    [property: JsonPropertyName("court_numbers")] IReadOnlyList<int>? CourtNumbers,
    string? GateKey,
    /// <summary>This box's own eight-entry button map, or omitted to run the club's.</summary>
    [property: JsonPropertyName("button_map")] IReadOnlyList<string>? ButtonMap = null,
    /// <summary>
    /// The board's MAC, however it is printed on the label — separators are stripped.
    /// Optional, and worth typing: it is the only stable link between this row and the
    /// physical board, so it is what lets a revoked or reflashed box be recovered later
    /// instead of registered a second time under a different code.
    /// </summary>
    [property: JsonPropertyName("mac_address")] string? MacAddress = null);

/// <summary>
/// <c>button_map</c> is pinned snake_case like <c>court_numbers</c> and is three-valued:
/// absent leaves the override alone, <c>null</c> clears it, a list sets it — hence a bare
/// <see cref="JsonElement"/> (Undefined when absent, Null when null) rather than a
/// nullable list, which reads both as null.
/// </summary>
public sealed record UpdateDeviceRequest(
    string? Name,
    bool? Enabled,
    [property: JsonPropertyName("court_numbers")] IReadOnlyList<int>? CourtNumbers,
    OtaChannel? OtaChannel,
    string? PinnedVersion,
    [property: JsonPropertyName("button_map")] JsonElement ButtonMap = default);
