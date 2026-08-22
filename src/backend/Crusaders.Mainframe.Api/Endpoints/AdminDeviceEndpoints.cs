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

        if (await devices.DeviceCodeTakenAsync(req.DeviceCode.Trim(), ct))
        {
            return Results.Conflict(new { error = "device_code_taken" });
        }

        var registered = await devices.RegisterAsync(
            new RegisterDeviceCommand(req.DeviceCode, req.Name, req.Kind, req.Hardware, req.CourtNumber, req.GateKey),
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
        });
    }

    private static async Task<IResult> UpdateAsync(
        Guid id, UpdateDeviceRequest req, DeviceRegistryService devices, HttpContext ctx, CancellationToken ct)
    {
        var device = await devices.FindAsync(id, ct);
        if (device is null) return Results.NotFound();

        var updated = await devices.UpdateAsync(
            device,
            new UpdateDeviceCommand(req.Name, req.Enabled, req.CourtNumber, req.OtaChannel, req.PinnedVersion),
            ctx.User.Id() ?? Guid.Empty, ct);

        return Results.Ok(DeviceView.Of(updated));
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

        // A court box drives a specific court; a gate opens a specific gate. Mixing
        // them means a heartbeat cannot be routed to anything.
        if (req.Kind == DeviceKind.CourtBox && req.CourtNumber is null) return "court_number_required_for_court_box";
        if (req.Kind == DeviceKind.Gate && string.IsNullOrWhiteSpace(req.GateKey)) return "gate_key_required_for_gate";

        return null;
    }
}

public sealed record RegisterDeviceRequest(
    string DeviceCode,
    string Name,
    DeviceKind Kind,
    DeviceHardware Hardware,
    int? CourtNumber,
    string? GateKey);

public sealed record UpdateDeviceRequest(
    string? Name,
    bool? Enabled,
    int? CourtNumber,
    OtaChannel? OtaChannel,
    string? PinnedVersion);
