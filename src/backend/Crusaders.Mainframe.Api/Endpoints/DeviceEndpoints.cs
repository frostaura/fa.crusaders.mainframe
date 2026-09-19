using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
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

        // The door gate's whole online surface is this group: heartbeat, and one scan
        // decision. It has no walk-up (a door sells nothing) and no activation (a door
        // starts nothing), which is why it sits here beside the heartbeat rather than on
        // DeviceEventEndpoints' group with the court box's money paths.
        g.MapPost("/gate", DeviceGateEndpoint.HandleAsync);

        return app;
    }

    /// <summary>Error code for a <c>kind</c> hint naming a device kind this server does not have.</summary>
    public const string KindUnknown = "kind_unknown";

    /// <summary>
    /// A board calling home: last-seen and versions in, its configuration and the roster it
    /// decides scans against out — and, the first time, the row itself.
    /// </summary>
    private static async Task<IResult> HeartbeatAsync(
        HeartbeatRequest req,
        [AsParameters] HeartbeatServices services,
        HttpContext ctx,
        ILoggerFactory logs,
        CancellationToken ct)
    {
        var (db, tenant, settings, registry, codes) = services;

        // Validated BEFORE the MAC is resolved, so a firmware that believes in a device kind
        // this server does not have is told so whether or not its row already exists. The
        // alternative — ignoring the hint on a known MAC, including when it is nonsense —
        // means a board sending `kind:"turnstile"` gets a clean 200 for as long as its row
        // lives and discovers the problem only when somebody deletes the row.
        if (!DeviceKinds.TryParseHint(req.Kind, out var hintedKind))
        {
            return Results.BadRequest(new { error = KindUnknown });
        }

        var (device, refusal) = await DeviceIdentity.ResolveOrRegisterAsync(db, registry, req.Mac, hintedKind, ct);
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

        // The board's own diagnostic counter, to the log and no further. Warning rather than
        // information: a board that could not push a heartbeat, or could not arm its
        // watchdog, is a board somebody has to look at — and nobody at the door can see it.
        if (req.NoPush is > 0 and { } noPush)
        {
            logs.CreateLogger(typeof(DeviceEndpoints)).LogWarning(
                "Device {DeviceCode} reports {NoPush} heartbeat(s) it could not push since the last one it could",
                device!.DeviceCode, noPush);
        }

        device!.LastIpAddress = ctx.Connection.RemoteIpAddress?.ToString();
        if (req.EffectiveRunningVersion is { } running) device.RunningVersion = running;
        if (!string.IsNullOrWhiteSpace(req.MegaVersion)) device.MegaVersion = req.MegaVersion.Trim();

        await db.SaveChangesAsync(ct);

        // A gate answers a different shape entirely — no court numbers, no relay config, no
        // button map, because a door has none of them. Branched on the ROW's kind rather than
        // on the request's hint: the hint only ever creates a row, and a board that started
        // sending `kind:"gate"` at a box's MAC must not thereby be handed a gate's response.
        // See GateHeartbeatView for what the shape is and DeviceGateRosterBuilder for why the
        // gate's roster is the club's rather than this board's.
        if (device.Kind == DeviceKind.Gate)
        {
            // A DOOR NOBODY HAS NAMED GETS NO ROSTER. Auto-registration is the whole
            // provisioning story, so anything holding the club's device key can heartbeat
            // with a MAC it invented and a `kind` of "gate" and have a row appear — and that
            // one call used to be answered with the club's live access codes for every
            // booking in the roster window, each of which opens every door in the club for
            // the length of its booking. Naming the door is the admin's acknowledgement that
            // the board is one of theirs, and it is the cheapest possible gate available.
            //
            // IT IS NOT, HOWEVER, THE ONLY CALL THAT HANDS OUT OTHER MEMBERS' CODES IN BULK,
            // and this comment said it was. A `kind`-less heartbeat from the same invented MAC
            // auto-registers a COURT BOX on the club's first four courts, with no naming step
            // at all, and is answered with up to sixteen live booking codes for those courts —
            // and after the gate shipped, every one of those codes opens every door in the club
            // inside its own booking's window. The gate's naming step therefore narrows this
            // surface rather than closing it. Whether an auto-registered, never-acknowledged
            // COURT BOX should also get no roster is a live product question, recorded in
            // memory/questions.md and stated in the spec's threat model (§10a) rather than
            // quietly fixed here: taking a box's roster away until an admin names it changes
            // the court-box install story and the offline lighting path, which is a decision
            // the founder owns. (/me/qr/generate hands a member their own code, one at a time,
            // authenticated as them — a different thing, and not this risk.)
            //
            // Online scans are unaffected, so an install stays plug-and-play: what waits for
            // the admin is the OFFLINE fallback. The list is still always present and still
            // replaced wholesale — an omitted key would leave a stale cache live, which is
            // the opposite of what this is for.
            //
            // Checked here and not inside BuildAsync, which deliberately takes no Device: two
            // NAMED gates on one club are still handed the identical list, and that sentence
            // is pinned. This is a gate on whether the board is asked at all.
            var gateRoster = string.IsNullOrWhiteSpace(device.GateKey)
                ? []
                : await DeviceGateRosterBuilder.BuildAsync(db, codes, s, now, ct);

            return Results.Ok(GateHeartbeatView.Of(
                device, tenant.TenantSlug, s.HeartbeatSeconds, GateAccess.UnlockSecondsFor(s),
                gateRoster, now));
        }

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
                // The longest walk-up this club will actually sell — the same bound
                // WalkUpForDeviceAsync applies, min(club cap, relay hard cap), so the box
                // is never told a number the API will refuse.
                //
                // Sent because it was not (finding M-F1): a club that lowered its walk-up
                // maximum to 20 left the box advertising 15/30/45/60 on its minute buttons
                // and the API refusing three of the four with `minutes_out_of_range` — a
                // configuration change the member got blamed for, at a court with nobody at
                // the desk. The console now warns an admin whose button map exceeds this
                // (see AdminDevices), and the box has the number it needs to grey the
                // button out or refuse it locally rather than round-tripping to a refusal.
                walk_up_max_minutes = Math.Min(s.WalkUpMaxMinutes, RelayHardCap.Minutes),

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
    [property: JsonPropertyName("running_version")] string? RunningVersion = null,
    /// <summary>
    /// What kind of board this is — <c>court_box</c> or <c>gate</c>, per
    /// <see cref="DeviceKinds"/>. Optional, and a HINT rather than an instruction: it is
    /// honoured only when the MAC is unknown, because it is the only moment the server has no
    /// other answer. Absent means <c>court_box</c>, which is what every board in the field
    /// sends today; an unrecognised string is a 400 rather than a silent court box. See
    /// <see cref="DeviceIdentity.ResolveOrRegisterAsync"/>.
    /// </summary>
    [property: JsonPropertyName("kind")] string? Kind = null,
    /// <summary>
    /// How many heartbeats the board could not push since it last reported one, plus its
    /// watchdog-arm failures. Optional, additive, and a DIAGNOSTIC — a board that sends
    /// nothing is a board reporting zero.
    ///
    /// <para>
    /// A door has one LED and a boot log, and the two failures it needs to report are ones a
    /// member must never be shown: a heartbeat body that did not fit the board's buffer or
    /// arrived incomplete, and a watchdog that would not arm. A distinct LED cue for either
    /// means nothing to the person standing at the door, so they ride the request instead.
    /// </para>
    ///
    /// <para>
    /// <b>It is logged and not stored.</b> A column on <see cref="Device"/> would be an EF
    /// migration for a counter nothing decides anything on, and this repository's rule is
    /// that a schema change needs one; the log line carries the device code, which is what a
    /// technician searches by. It changes nothing about the response, and a negative value is
    /// ignored rather than refused — a diagnostic must not be able to take a door out of
    /// service. Corpus vector <c>gate-heartbeat-request-no-push</c>.
    /// </para>
    /// </summary>
    [property: JsonPropertyName("no_push")] int? NoPush = null)
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
