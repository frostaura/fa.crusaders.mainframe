using System.Text.Json;
using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

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
        var g = app.MapGroup("/api/v1/admin/devices").RequireAuthorization(p => p.RequireRole("admin")).RefuseUnstorableText();

        // Declared before the "/{id:guid}" routes for readability only — the guid
        // constraint already stops "api-key" matching them.
        // Device contract v3 (device-api.md §6–§8): the key ring (rotate / retire / restore, in
        // place of v2's Regenerate), the club's device network and signed firmware.
        g.MapAdminDeviceV3Endpoints();

        g.MapGet("/", ListAsync);
        g.MapGet("/member-codes", MemberCodeRolloutAsync);
        g.MapPatch("/{id:guid}", UpdateAsync);
        g.MapDelete("/{id:guid}", DeleteAsync);

        // What this board has been doing. On this group rather than beside the audit trail
        // because the question is about a DEVICE — see AdminDeviceActivityEndpoint for why a
        // door needs it more than a court box does, and why the trail had no reader at all.
        g.MapGet("/{id:guid}/activity", AdminDeviceActivityEndpoint.HandleAsync);

        return app;
    }

    /// <summary>
    /// The club's member-code rollout (member-code §8): the phase, its two instants, when the
    /// cut-off falls due, and every enabled board that is still blocking the cut-over — a board
    /// whose latest heartbeat did not name <c>codes:m1</c>. A dead board blocks it until an admin
    /// disables it, and this is where the admin finds out which one.
    /// </summary>
    private static async Task<IResult> MemberCodeRolloutAsync(
        TenantSettingsAccessor settingsAccessor, MainframeDbContext db, CancellationToken ct)
    {
        var s = await settingsAccessor.GetAsync(ct);
        var enabled = await db.Devices.AsNoTracking().Where(d => d.Enabled).OrderBy(d => d.DeviceCode).ToListAsync(ct);

        // Only ACKNOWLEDGED boards vote on the cut-over (MemberCodeRollout.EveryEnabledBoardSpeaksAsync);
        // the unacknowledged ones are listed apart so the page can say why they do not block.
        var now = DateTimeOffset.UtcNow;
        var boards = enabled.Where(MemberCodeHeartbeat.Acknowledged).ToList();
        // MCV1-03: an acknowledged board blocks when it does not speak codes:m1, or — a court box —
        // when it has not been sent a keyed heartbeat in the last hour; an unacknowledged court box
        // heard this week blocks too, without voting. Each row says why.
        var blocking = boards
            .Where(d => !d.SpeaksMemberCodes || (d.Kind == DeviceKind.CourtBox && !MemberCodeRollout.HasKeyedBeat(d, now)))
            .Select(d => Row(d) with { Blocks = d.SpeaksMemberCodes ? "no_keyed_heartbeat" : "no_member_codes" })
            .Concat(enabled.Where(d => MemberCodeRollout.BlocksUnacknowledged(d, now)).Select(d => Row(d) with { Blocks = "unacknowledged" }))
            .ToList();
        var unacknowledged = enabled.Where(d => !MemberCodeHeartbeat.Acknowledged(d)).Select(Row).ToList();

        return Results.Ok(new
        {
            phase = MemberCodeSettings.Phase(s),
            cutover_at = s.MemberCodeCutoverAt,
            cutoff_at = s.MemberCodeCutoffAt,
            cutoff_days = MemberCodeSettings.CutoffDays(s),
            cutoff_due_at = s.MemberCodeCutoverAt?.AddDays(MemberCodeSettings.CutoffDays(s)),
            enabled_boards = boards.Count,
            ready_boards = boards.Count - blocking.Count(b => b.Blocks != "unacknowledged"),
            blocking,

            // An administrator's rollback holds the automatic rollout until they move forward
            // again or clear it (MemberCodeSettings.HoldKey).
            manual_hold = s.MemberCodeManualHold,
            manual_hold_by = s.MemberCodeManualHoldBy,
            manual_hold_at = s.MemberCodeManualHoldAt,
            unacknowledged,
        });

        static RolloutBoard Row(Device d) => new(
            d.Id, d.DeviceCode, DeviceView.Named(d.Name), d.Kind.ToString(), d.RunningVersion, d.Capabilities, d.LastSeenAt,
            d.CodeKeysSent, d.CodeKeysTrimmed, d.CodeKeysAt, MemberCodeHeartbeat.Acknowledged(d));
    }

    /// <summary>
    /// The tenant's configured heartbeat interval, which every device view carries so the
    /// page can derive an offline threshold from it rather than hardcoding one. See
    /// <see cref="DeviceView"/> and <see cref="HeartbeatCadence"/>.
    /// </summary>
    private static async Task<int> HeartbeatSecondsAsync(TenantSettingsAccessor settingsAccessor, CancellationToken ct)
        => (await settingsAccessor.GetAsync(ct)).HeartbeatSeconds;

    private static async Task<IResult> ListAsync(
        DeviceRegistryService devices, TenantSettingsAccessor settingsAccessor, MainframeDbContext db,
        CancellationToken ct)
    {
        var heartbeat = await HeartbeatSecondsAsync(settingsAccessor, ct);
        var rows = await devices.ListAsync(ct);

        // One read for the whole list. See PersonNames.
        var names = await PersonNames.ForAsync(db, rows.Select(d => d.ShutByUserId), ct);

        return Results.Ok(rows.Select(d => DeviceView.Of(d, heartbeat, PersonNames.Of(d.ShutByUserId, names))).ToList());
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
    /// <remarks>
    /// <para>
    /// <b>A PATCH that changes nothing says so (B10).</b> A console tab left open while another
    /// admin shut the door offered "Shut this door", sent it, and was answered <c>200</c> with a
    /// row that looked exactly like a success — so two admins each believed they had shut it and
    /// neither was told the other had. The answer now carries <c>unchanged: true</c> alongside
    /// <c>shut_by_name</c> and <c>out_of_service_since</c>, which is everything the sentence "it
    /// was already shut — by Priya Naidoo at 21:48" needs. It is still a <c>200</c>: nothing was
    /// wrong with the request and the row is in the state the caller asked for, which is what a
    /// <c>409</c> would deny.
    /// </para>
    /// </remarks>
    private static async Task<IResult> UpdateAsync(
        Guid id, UpdateDeviceRequest req, [AsParameters] DeviceUpdateServices services,
        HttpContext ctx, CancellationToken ct)
    {
        var (devices, settingsAccessor, db) = services;
        var device = await devices.FindAsync(id, ct);
        if (device is null) return Results.NotFound();

        // Every refusal that can be decided from the request and the row alone, before a single
        // field is parsed or written. See StateAndWidthRefusal and KindFieldsRefusal.
        if (StateAndWidthRefusal(device, req) is { } refused) return refused;

        // Before the button map is even parsed: a field that does not belong on this kind of
        // row is refused rather than parsed and then ignored.
        if (KindFieldsRefusal(device, req) is { } wrongKind) return wrongKind;

        if (ParseButtonMapPatch(req.ButtonMap, out var buttons) is { } badMap) return badMap;

        // Device contract v3 (device-api.md §5, §10, §12): this board's own layout, marquee and
        // hardware facts, three-valued like button_map, and the explicit network push. A door has
        // no glass, relays or scanner settings of this kind, so it is refused them.
        if (device.Kind == DeviceKind.Gate && DeviceBoardOverrides.Mentions(req.Extra))
        {
            return Results.BadRequest(new { error = "court_box_fields_on_gate" });
        }
        var (board, badBoard) = DeviceBoardOverrides.Parse(req.Extra);
        if (badBoard is not null) return Results.BadRequest(badBoard);

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

        // The behaviour has already been checked against the closed set by KindFieldsRefusal,
        // so this parse cannot fail here; it is the same parse rather than a second reading of
        // the element, so the value validated and the value stored are one value.
        DoorPowerLossBehaviour? powerLoss = null;
        if (req.EffectivePowerLossBehaviour.ValueKind == JsonValueKind.String
            && DoorPowerLoss.TryParse(req.EffectivePowerLossBehaviour.GetString(), out var parsedPowerLoss))
        {
            powerLoss = parsedPowerLoss;
        }

        var (updated, changes) = await devices.UpdateAsync(
            device,
            new UpdateDeviceCommand(req.Name, req.Enabled, req.CourtNumbers, buttons, req.EffectiveGateKey?.Trim())
            {
                LocationNote = req.EffectiveLocationNote?.Trim(),
                PowerLossBehaviour = powerLoss,
                Board = board,
            },
            ctx.User.Id() ?? Guid.Empty, ct);

        var names = await PersonNames.ForAsync(db, [updated.ShutByUserId], ct);

        return Results.Ok(DeviceView.Of(
            updated, await HeartbeatSecondsAsync(settingsAccessor, ct),
            PersonNames.Of(updated.ShutByUserId, names), unchanged: changes.Count == 0));
    }

    /// <summary>
    /// The two refusals that are about the row's STATE and the column's WIDTH rather than about
    /// which kind of board this is — checked first, and before anything is written.
    ///
    /// <para>
    /// <b><c>expected_enabled</c> is the half of a PATCH that was missing (B13 / R3-34,
    /// WIRE-R3 §3).</b> A console tab left open overnight still offers "Shut this door" for a
    /// door another admin reopened at 06:00, and sending it shut a door somebody had
    /// deliberately opened — with a success panel and no sign anywhere that the screen had been
    /// out of date. The request carries the state the admin WANTS and nothing about the state
    /// they were looking at when they decided. This is an If-Match and not a version column, so
    /// it is optional and a request without it behaves exactly as it always has; with it, a
    /// mismatch is a <c>409</c> and NOTHING is written — not the name, not the card, not the
    /// switch. A partial apply would be the worst answer available, because the admin would be
    /// told their request was rejected while some of it had landed.
    /// </para>
    ///
    /// <para>
    /// It is distinct from <c>unchanged: true</c>, which is a <c>200</c>: that is a request that
    /// asked for the state the row is already in, which is success. This is a request built on a
    /// reading of the row that is no longer true.
    /// </para>
    ///
    /// <para>
    /// <b>The name's width is checked for BOTH kinds and before the kind rules</b>, because how
    /// wide the column is is not a door question — and because the alternative is what R3-15
    /// found: a <c>DbUpdateException</c> out of <c>SaveChangesAsync</c>, which in Development is
    /// a developer exception page. See <see cref="Device.NameMaxLength"/>.
    /// </para>
    /// </summary>
    private static IResult? StateAndWidthRefusal(Device device, UpdateDeviceRequest req)
    {
        if (req.ExpectedEnabled is { } expected && expected != device.Enabled)
        {
            return Results.Conflict(new { error = DoorChanged });
        }

        if (req.Name is { } proposed && proposed.Trim().Length > Device.NameMaxLength)
        {
            return Results.BadRequest(new { error = NameTooLong, max = Device.NameMaxLength });
        }

        return null;
    }

    /// <summary>
    /// Error code for a <c>name</c> longer than <see cref="Device.NameMaxLength"/>. Carries
    /// <c>max</c>, which is the number the console puts in front of the admin — WIRE-R3 §3.
    /// </summary>
    public const string NameTooLong = "name_too_long";

    /// <summary>
    /// Error code — on a <c>409</c>, not a <c>400</c> — for a PATCH whose <c>expected_enabled</c>
    /// does not match the row. See <see cref="UpdateAsync"/>: it means "this door changed since
    /// you looked", and nothing was written.
    /// </summary>
    public const string DoorChanged = "door_changed";

    /// <summary>Error code for <c>gate_key</c> sent to a court box.</summary>
    public const string GateKeyNotAGate = "gate_key_not_a_gate";

    /// <summary>Error code for <c>court_numbers</c> or <c>button_map</c> sent to a gate.</summary>
    public const string CourtFieldsOnAGate = "court_fields_on_a_gate";

    /// <summary>Error code for a <c>gate_key</c> longer than the column.</summary>
    public const string GateKeyTooLong = "gate_key_too_long";

    /// <summary>
    /// Error code for a door-card field — <c>location_note</c> or <c>power_loss_behaviour</c>
    /// — sent to a court box. The mirror of <see cref="CourtFieldsOnAGate"/>, and refused for
    /// the same reason: a box has no door to be located or to fall open.
    /// </summary>
    public const string DoorFieldsOnACourtBox = "door_fields_on_a_court_box";

    /// <summary>Error code for a <c>location_note</c> longer than the column.</summary>
    public const string LocationNoteTooLong = "location_note_too_long";

    /// <summary>Error code for a <c>power_loss_behaviour</c> outside <see cref="DoorPowerLoss.All"/>.</summary>
    public const string PowerLossBehaviourInvalid = "power_loss_behaviour_invalid";

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
            if (req.EffectiveGateKey is not null) return Results.BadRequest(new { error = GateKeyNotAGate });

            // The door card describes a DOOR: where it is, and what its lock does with the
            // power off. A court box has neither. Refused rather than dropped, for the reason
            // the summary gives — a 200 that changed nothing is the worst of the three
            // available answers.
            return req.SaysAnythingAboutTheDoorCard
                ? Results.BadRequest(new { error = DoorFieldsOnACourtBox })
                : null;
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

        return DoorCardRefusal(req);
    }

    /// <summary>
    /// The door card's own bounds, on a row that is a gate: the note's length and the
    /// behaviour's closed set. Null when both are acceptable, including when neither arrived.
    ///
    /// <para>
    /// Separate from <see cref="KindFieldsRefusal"/> because that method answers "does this
    /// field belong on this kind of row" and these two answer "is this value usable" — and
    /// because <c>power_loss_behaviour</c> is a string enum whose validity is checked the same
    /// STRICT way <c>gate_access_policy</c> is on the settings PUT. A console that invents a
    /// fourth answer to "what does this lock do with no power" is a console publishing a
    /// measurement nobody took.
    /// </para>
    ///
    /// <para>
    /// A present-but-null <c>power_loss_behaviour</c> is refused rather than read as absent,
    /// unlike <c>gate_key</c>. There is no state a JSON null could mean here that
    /// <c>"not_established"</c> does not already name, so a null is a client bug, and the one
    /// thing this field must never do is quietly leave a stale measurement in place while
    /// reporting success.
    /// </para>
    /// </summary>
    private static IResult? DoorCardRefusal(UpdateDeviceRequest req)
    {
        if (req.EffectiveLocationNote is { } note && note.Trim().Length > Device.LocationNoteMaxLength)
        {
            return Results.BadRequest(new { error = LocationNoteTooLong, max_length = Device.LocationNoteMaxLength });
        }

        var behaviour = req.EffectivePowerLossBehaviour;
        if (behaviour.ValueKind == JsonValueKind.Undefined) return null;

        var wire = behaviour.ValueKind == JsonValueKind.String ? behaviour.GetString() : null;
        return DoorPowerLoss.TryParse(wire, out _)
            ? null
            : Results.BadRequest(new { error = PowerLossBehaviourInvalid, allowed = DoorPowerLoss.All });
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
/// <summary>
/// One board on the member-code rollout view (FA-3, MCV1-03, MCV1-07): who it is, what it speaks,
/// the keys it was last sent and how many were trimmed, and — on the blocking list — why it blocks.
/// </summary>
public sealed record RolloutBoard(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("device_code")] string DeviceCode,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("running_version")] string? RunningVersion,
    [property: JsonPropertyName("capabilities")] IReadOnlyList<string> Capabilities,
    [property: JsonPropertyName("last_seen_at")] DateTimeOffset? LastSeenAt,
    [property: JsonPropertyName("keys_sent")] int? KeysSent,
    [property: JsonPropertyName("keys_trimmed")] int? KeysTrimmed,
    [property: JsonPropertyName("keys_sent_at")] DateTimeOffset? KeysSentAt,
    [property: JsonPropertyName("acknowledged")] bool Acknowledged)
{
    /// <summary>On the blocking list only: <c>no_member_codes</c>, <c>no_keyed_heartbeat</c> or <c>unacknowledged</c>.</summary>
    [JsonPropertyName("blocks")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Blocks { get; init; }
}

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
    [property: JsonPropertyName("gateKey")] string? GateKeyCamel = null,

    /// <summary>
    /// The door card's prose location (W1.4). Two-valued exactly like <see cref="GateKey"/> —
    /// <c>""</c> clears it, absent leaves it alone — and bound under both spellings for the
    /// reason <see cref="GateKeyCamel"/> records. Refused on a court box.
    /// </summary>
    [property: JsonPropertyName("location_note")] string? LocationNote = null,
    [property: JsonPropertyName("locationNote")] string? LocationNoteCamel = null,

    /// <summary>
    /// What the lock does with no power (W1.4). A bare <see cref="JsonElement"/> rather than a
    /// string, because the three answers this field must distinguish are "absent", "a value in
    /// the closed set" and "anything else" — and a nullable string reads a JSON null, a
    /// missing key and an empty document as one thing. The last of those three has to be a
    /// refusal: see <c>DoorCardRefusal</c>.
    /// </summary>
    [property: JsonPropertyName("power_loss_behaviour")] JsonElement PowerLossBehaviour = default,
    [property: JsonPropertyName("powerLossBehaviour")] JsonElement PowerLossBehaviourCamel = default,

    /// <summary>
    /// The value of <c>enabled</c> the caller believes this row holds — an If-Match on the one
    /// field that is a decision rather than a description (B13 / R3-34, WIRE-R3 §3). Optional;
    /// absent means the caller is not asserting anything and the PATCH behaves as it always
    /// has. Present and wrong is a <c>409</c> <see cref="AdminDeviceEndpoints.DoorChanged"/>
    /// with nothing written. There is deliberately no camelCase twin: it is new in this round,
    /// so there is no client spelling it the other way, and a second binding is a second thing
    /// to keep in step.
    /// </summary>
    [property: JsonPropertyName("expected_enabled")] bool? ExpectedEnabled = null)
{
    /// <summary>
    /// Every key this record has no member for — where the device contract v3 per-board settings
    /// (<c>lcd_layout</c>, <c>lcd_marquee_enabled</c>, the five <c>hw_*</c> keys) and
    /// <c>push_network</c> are read from by <see cref="DeviceBoardOverrides"/>. As bare elements,
    /// because each is THREE-valued: absent, JSON null (the club's) and a value (the board's).
    /// </summary>
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? Extra { get; init; }

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

    /// <summary>The door's location as the caller asked for it, under either spelling.</summary>
    public string? EffectiveLocationNote => LocationNote ?? LocationNoteCamel;

    /// <summary>
    /// The power-loss behaviour as the caller sent it, under either spelling — snake_case
    /// winning where both arrived, like every other pair here. <c>Undefined</c> when neither
    /// did.
    /// </summary>
    public JsonElement EffectivePowerLossBehaviour
        => PowerLossBehaviour.ValueKind != JsonValueKind.Undefined ? PowerLossBehaviour : PowerLossBehaviourCamel;

    /// <summary>
    /// Whether this PATCH says anything at all about the door card — the question a court box
    /// is refused on. Either field, under either spelling, at any value including an explicit
    /// null: sending a door's fields to a box is the mistake, not the value in them.
    /// </summary>
    public bool SaysAnythingAboutTheDoorCard
        => EffectiveLocationNote is not null
           || EffectivePowerLossBehaviour.ValueKind != JsonValueKind.Undefined;
}

/// <summary>
/// The services the device PATCH needs, bundled — see <c>WalkUpServices</c> for the pattern and
/// the reason.
///
/// <para>
/// The handler acquired its seventh parameter when the answer started naming the admin who shut
/// the door (A5/B10): <see cref="PersonNames"/> reads the display name, and reading it needs the
/// context. Seven is past the complexity gate's limit of six and past the point where the shape
/// of the handler is visible at a glance; <c>[AsParameters]</c> leaves the binding identical.
/// </para>
/// </summary>
public sealed record DeviceUpdateServices(
    DeviceRegistryService Devices,
    TenantSettingsAccessor SettingsAccessor,
    MainframeDbContext Db);
