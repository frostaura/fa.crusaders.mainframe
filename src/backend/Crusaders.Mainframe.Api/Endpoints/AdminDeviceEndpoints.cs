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

    private static async Task<IResult> ListAsync(DeviceRegistryService devices, CancellationToken ct)
        => Results.Ok((await devices.ListAsync(ct)).Select(DeviceView.Of).ToList());

    private static async Task<IResult> RegisterAsync(
        RegisterDeviceRequest req, DeviceRegistryService devices, HttpContext ctx, CancellationToken ct)
    {
        var invalid = Validate(req);
        if (invalid is not null) return Results.BadRequest(new { error = invalid });

        ButtonMap? buttons = null;
        if (req.ButtonMap is not null && !ButtonMap.TryParse(req.ButtonMap, out buttons, out var reason))
        {
            return Results.BadRequest(new { error = "button_map_invalid", message = reason });
        }

        if (await devices.DeviceCodeTakenAsync(req.DeviceCode.Trim(), ct))
        {
            return Results.Conflict(new { error = "device_code_taken" });
        }

        // The map this box will run — its own override when the request carries one, else
        // the club's — must be able to address its court list, and the list must name real
        // courts. Refused here, where the admin can act on it, rather than discovered
        // later as buttons that do nothing or a relay that never lights.
        if (req.Kind == DeviceKind.CourtBox
            && await devices.CourtAssignmentErrorAsync(req.CourtNumbers!, buttons, null, ct) is { } mismatch)
        {
            return Results.BadRequest(new { error = mismatch });
        }

        var registered = await devices.RegisterAsync(
            new RegisterDeviceCommand(req.DeviceCode, req.Name, req.Kind, req.Hardware, req.CourtNumbers, req.GateKey) { ButtonMap = buttons },
            ctx.User.Id() ?? Guid.Empty, ct);

        // Shown once. Flash it into the device's secrets.h and do not keep a copy here.
        return Results.Ok(new
        {
            device = DeviceView.Of(registered.Device),
            device_key = registered.DeviceKey,
            key_version = registered.Device.KeyVersion,
            note = "Store this key on the device now. It is derived, not stored, and cannot be shown again.",
        });
    }

    private static async Task<IResult> RotateKeyAsync(
        Guid id, DeviceRegistryService devices, HttpContext ctx, CancellationToken ct)
    {
        var device = await devices.FindAsync(id, ct);
        if (device is null) return Results.NotFound();

        var rotated = await devices.RotateKeyAsync(device, ctx.User.Id() ?? Guid.Empty, ct);

        return Results.Ok(new
        {
            device = DeviceView.Of(rotated.Device),
            device_key = rotated.DeviceKey,
            key_version = rotated.Device.KeyVersion,
            // The board cannot be handed this key: its next signed call is refused, it
            // drops to CLAIM CODE, and connecting it again re-keys this same row and
            // issues the grant it collects. See DeviceRegistryService.RotateKeyAsync.
            note = "The board's old key stops working now. It will show a new claim code on its LCD; connect it again from the discovered boards list to deliver the new key.",
        });
    }

    private static async Task<IResult> UpdateAsync(
        Guid id, UpdateDeviceRequest req, DeviceRegistryService devices, HttpContext ctx, CancellationToken ct)
    {
        var device = await devices.FindAsync(id, ct);
        if (device is null) return Results.NotFound();

        if (ParseButtonMapPatch(req.ButtonMap, out var buttons) is { } badMap) return badMap;

        // The effective map after this PATCH — the override it sets, else the one the row
        // keeps, else the club's — must be able to address the effective court list, and a
        // new list must be well-formed and name real courts. Same two rules as registration.
        if (await AssignmentErrorAsync(devices, device, req.CourtNumbers, buttons, ct) is { } invalid)
        {
            return Results.BadRequest(new { error = invalid });
        }

        var updated = await devices.UpdateAsync(
            device,
            new UpdateDeviceCommand(req.Name, req.Enabled, req.CourtNumbers, req.OtaChannel, req.PinnedVersion, buttons),
            ctx.User.Id() ?? Guid.Empty, ct);

        return Results.Ok(DeviceView.Of(updated));
    }

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

    /// <summary>The court-list and effective-map rules for a PATCH, or null when nothing relevant changed or all is well.</summary>
    private static async Task<string?> AssignmentErrorAsync(
        DeviceRegistryService devices, Device device, IReadOnlyList<int>? newCourts, Optional<ButtonMap?>? buttons, CancellationToken ct)
    {
        if (device.Kind != DeviceKind.CourtBox || (newCourts is null && buttons is null)) return null;

        var courts = newCourts ?? device.CourtNumbers;
        var overrideJson = buttons is { } set ? set.Value?.ToJson() : device.ButtonMapJson;
        return (newCourts is not null ? DeviceRegistryService.ValidateCourtNumbers(courts) : null)
               ?? await devices.CourtAssignmentErrorAsync(courts, null, overrideJson, ct);
    }

    private static async Task<IResult> RevokeAsync(
        Guid id, DeviceRegistryService devices, HttpContext ctx, CancellationToken ct)
    {
        var device = await devices.FindAsync(id, ct);
        if (device is null) return Results.NotFound();

        return Results.Ok(DeviceView.Of(await devices.RevokeAsync(device, ctx.User.Id() ?? Guid.Empty, ct)));
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
    [property: JsonPropertyName("button_map")] IReadOnlyList<string>? ButtonMap = null);

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
