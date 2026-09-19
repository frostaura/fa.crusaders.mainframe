using System.Text.Json;
using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Admin management of the boxes that have called this club's API, and of the one key
/// they all present.
///
/// <para>
/// There is no register route. A board creates its own row on its first heartbeat, so
/// this surface is list, edit, delete — plus the club key, which is <b>readable</b>
/// rather than shown-once because an admin has to be able to paste it into a
/// <c>secrets.h</c> at a workbench weeks after the club was created. Regenerating it
/// invalidates the old key on the very next request, which is why the page warns that
/// every box must be reflashed.
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

        // Declared before the "/{id:guid}" routes for readability only — the guid
        // constraint already stops "api-key" matching them.
        g.MapGet("/api-key", ApiKeyAsync);
        g.MapPost("/api-key/regenerate", RegenerateApiKeyAsync);

        g.MapGet("/", ListAsync);
        g.MapPatch("/{id:guid}", UpdateAsync);
        g.MapDelete("/{id:guid}", DeleteAsync);

        // What this board has been doing. On this group rather than beside the audit trail
        // because the question is about a DEVICE — see AdminDeviceActivityEndpoint for why a
        // door needs it more than a court box does, and why the trail had no reader at all.
        g.MapGet("/{id:guid}/activity", AdminDeviceActivityEndpoint.HandleAsync);

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

    /// <summary>
    /// <c>GET /api/v1/admin/devices/api-key</c> — the club's device key, minted on the
    /// first read so the page is never empty.
    /// </summary>
    private static async Task<IResult> ApiKeyAsync(
        DeviceRegistryService devices, HttpContext ctx, CancellationToken ct)
        => Results.Ok(ApiKeyView(await devices.ApiKeyAsync(ctx.User.Id() ?? Guid.Empty, ct)));

    /// <summary>
    /// <c>POST /api/v1/admin/devices/api-key/regenerate</c> — a new key, effective
    /// immediately. Every box is offline until it is reflashed with it.
    /// </summary>
    private static async Task<IResult> RegenerateApiKeyAsync(
        DeviceRegistryService devices, HttpContext ctx, CancellationToken ct)
        => Results.Ok(ApiKeyView(await devices.RegenerateApiKeyAsync(ctx.User.Id() ?? Guid.Empty, ct)));

    // Block body, not an expression body: lizard's C# parser mis-scopes an
    // expression-bodied member containing braces into a *global* pseudo-function the
    // length of the file — see memory/gotchas.md.
    private static object ApiKeyView(Domain.Tenant tenant)
    {
        return new
        {
            api_key = tenant.DeviceApiKey,
            regenerated_at = tenant.DeviceApiKeyRegeneratedAt,
        };
    }

    /// <summary>
    /// The admin PATCH. <c>enabled</c> is the one field here that moves money after the fact, and
    /// it is <b>idempotent on purpose</b>: <c>DeviceRegistryService.UpdateAsync</c> stamps
    /// <see cref="Device.OutOfServiceSince"/> only on the TRANSITION, so sending
    /// <c>{"enabled": false}</c> to a board that is already out of service changes nothing.
    ///
    /// <para>
    /// Without that guard a repeat of a request that says nothing new would move the recorded
    /// switch-off instant forward to now, which pushes every unsettled deadline between the real
    /// switch-off and the repeat out of <c>DoorWasShutFor</c>'s "dark at once" branch and back
    /// into the silence test — reopening the <c>offline_after_seconds</c> hole the column was
    /// added to close, across the sweep's whole lookback. The console happens to send only the
    /// fields it changed, but this is a documented surface and callers repeat requests. Pinned by
    /// <c>Taking_a_board_out_of_service_records_the_instant_and_returning_it_clears_it</c>.
    /// </para>
    /// </summary>
    private static async Task<IResult> UpdateAsync(
        Guid id, UpdateDeviceRequest req, DeviceRegistryService devices, TenantSettingsAccessor settingsAccessor,
        HttpContext ctx, CancellationToken ct)
    {
        var device = await devices.FindAsync(id, ct);
        if (device is null) return Results.NotFound();

        // Before the button map is even parsed: a field that does not belong on this kind of
        // row is refused rather than parsed and then ignored.
        if (KindFieldsRefusal(device, req) is { } wrongKind) return wrongKind;

        if (ParseButtonMapPatch(req.ButtonMap, out var buttons) is { } badMap) return badMap;

        // The effective map after this PATCH — the override it sets, else the one the row
        // keeps, else the club's — must be able to address the effective court list, and a
        // new list must be well-formed and name real courts. Including the trim: shrinking
        // a box's court list turns off the court buttons it no longer has rather than
        // refusing the edit.
        var resolved = await AssignmentAsync(devices, device, req.CourtNumbers, buttons, ct);
        if (resolved is { } outcome)
        {
            if (outcome.Error is { } invalid) return Results.BadRequest(new { error = invalid });
            buttons = new Optional<ButtonMap?>(outcome.Override);
        }

        var updated = await devices.UpdateAsync(
            device,
            new UpdateDeviceCommand(req.Name, req.Enabled, req.CourtNumbers, buttons, req.EffectiveGateKey?.Trim()),
            ctx.User.Id() ?? Guid.Empty, ct);

        return Results.Ok(DeviceView.Of(updated, await HeartbeatSecondsAsync(settingsAccessor, ct)));
    }

    /// <summary>Error code for <c>gate_key</c> sent to a court box.</summary>
    public const string GateKeyNotAGate = "gate_key_not_a_gate";

    /// <summary>Error code for <c>court_numbers</c> or <c>button_map</c> sent to a gate.</summary>
    public const string CourtFieldsOnAGate = "court_fields_on_a_gate";

    /// <summary>Error code for a <c>gate_key</c> longer than the column.</summary>
    public const string GateKeyTooLong = "gate_key_too_long";

    /// <summary>
    /// The fields that belong to one kind of board and not the other, refused rather than
    /// ignored.
    ///
    /// <para>
    /// Silently dropping <c>court_numbers</c> on a gate is what the code did before this
    /// existed — <see cref="AssignmentAsync"/> returns null for anything that is not a court
    /// box — and a PATCH that reports success while changing nothing is the worst of the
    /// three available answers: the admin believes the courts are assigned, the row says
    /// otherwise, and nothing anywhere says which. The same argument in the other direction
    /// for <c>gate_key</c> on a box.
    /// </para>
    ///
    /// <para>
    /// <b><c>kind</c> is not editable at all and is not a field here.</b> Changing it would
    /// mean a row keeping a court list it can no longer use, or acquiring one it never had;
    /// the reset is to delete the row and let the board re-register with its own hint, which
    /// is the same reset a misconfigured box already has.
    /// </para>
    ///
    /// <para>
    /// A present-but-null <c>button_map</c> counts as sent. On a box that means "run the
    /// club's map", which is a real instruction; on a gate there is no map to run, so the
    /// request is as wrong as a list would be.
    /// </para>
    /// </summary>
    private static IResult? KindFieldsRefusal(Device device, UpdateDeviceRequest req)
    {
        if (device.Kind != DeviceKind.Gate)
        {
            return req.EffectiveGateKey is null ? null : Results.BadRequest(new { error = GateKeyNotAGate });
        }

        if (req.CourtNumbers is not null || req.ButtonMap.ValueKind != JsonValueKind.Undefined)
        {
            return Results.BadRequest(new { error = CourtFieldsOnAGate });
        }

        // Bounded here rather than truncated at the column: a door whose name is silently
        // shortened is a door nobody can find in the audit trail afterwards. Read through
        // EffectiveGateKey like everything else, so a spelling is not a way round a rule.
        if (req.EffectiveGateKey is { } key && key.Trim().Length > Device.GateKeyMaxLength)
        {
            return Results.BadRequest(new { error = GateKeyTooLong, max_length = Device.GateKeyMaxLength });
        }

        return null;
    }

    /// <summary>
    /// Removes a box's row. Not destructive and not a revocation: the board still holds the
    /// club key, so it re-registers on its next heartbeat with default courts. That is the
    /// intended way to reset a box whose configuration has been got into a mess.
    /// </summary>
    private static async Task<IResult> DeleteAsync(
        Guid id, DeviceRegistryService devices, HttpContext ctx, CancellationToken ct)
    {
        var device = await devices.FindAsync(id, ct);
        if (device is null) return Results.NotFound();

        await devices.DeleteAsync(device, ctx.User.Id() ?? Guid.Empty, ct);

        // A body rather than 204, because the Devices page types this route's answer and a
        // 204 would leave it typing `undefined`.
        return Results.Ok(new { deleted = true });
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
}

/// <summary>
/// <c>button_map</c> is pinned snake_case like <c>court_numbers</c> and is three-valued:
/// absent leaves the override alone, <c>null</c> clears it, a list sets it — hence a bare
/// <see cref="JsonElement"/> (Undefined when absent, Null when null) rather than a
/// nullable list, which reads both as null.
///
/// <para>
/// <c>gate_key</c> needs only two values and so is a plain nullable string: absent leaves
/// the door's name alone and an EMPTY STRING clears it. There is no "run the club's default"
/// state for it to distinguish a JSON null from — a door either has a name or has not — and
/// clearing a text field by emptying it is the gesture an admin already makes.
/// </para>
///
/// <para>
/// There is no <c>kind</c>. See <c>KindFieldsRefusal</c>.
/// </para>
/// </summary>
public sealed record UpdateDeviceRequest(
    string? Name,
    bool? Enabled,
    [property: JsonPropertyName("court_numbers")] IReadOnlyList<int>? CourtNumbers,
    [property: JsonPropertyName("button_map")] JsonElement ButtonMap = default,
    [property: JsonPropertyName("gate_key")] string? GateKey = null,
    /// <summary>
    /// The camelCase spelling of <see cref="GateKey"/>, bound so that picking the wrong one is
    /// an answer rather than silence. Never read directly — see <see cref="EffectiveGateKey"/>.
    /// </summary>
    [property: JsonPropertyName("gateKey")] string? GateKeyCamel = null)
{
    /// <summary>
    /// The door's name as the caller asked for it, under either spelling — or null when
    /// neither arrived, which is the two-valued "leave it alone".
    ///
    /// <para>
    /// <b>This endpoint answers snake_case and .NET binds camelCase</b>, and the cost of a
    /// client choosing the wrong one is not an error: it is <c>null</c>, which
    /// <c>gate_key</c> reads as "omitted", so the PATCH returns <c>200</c> with the door's OLD
    /// name in the body and nothing anywhere says the write was dropped. <c>door-gate.md</c>
    /// §8 makes exactly that argument about the settings PUT — where both spellings have bound
    /// since it shipped — and it was never applied to the one field on this PATCH that carries
    /// the same risk. For a value that names the door in every audit row a club will ever read
    /// back, a silent no-op is worth removing rather than documenting.
    /// </para>
    ///
    /// <para>
    /// snake_case wins where both arrive, because it is the spelling this document and the
    /// corpus declare; a caller sending two different values has a bug either way and the
    /// deterministic answer is the documented one. Every refusal still applies to whichever
    /// value this returns — a spelling is not a way round a rule.
    /// </para>
    /// </summary>
    public string? EffectiveGateKey => GateKey ?? GateKeyCamel;
}
