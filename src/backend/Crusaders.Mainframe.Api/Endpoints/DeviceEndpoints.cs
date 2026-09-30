using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
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
        var (db, tenant, settings, registry, codes, _, _, _, faults, _, _, _) = services;

        // Validated BEFORE the MAC is resolved, so a firmware that believes in a device kind
        // this server does not have is told so whether or not its row already exists. The
        // alternative — ignoring the hint on a known MAC, including when it is nonsense —
        // means a board sending `kind:"turnstile"` gets a clean 200 for as long as its row
        // lives and discovers the problem only when somebody deletes the row.
        if (!DeviceKinds.TryParseHint(req.Kind, out var hintedKind))
        {
            return Results.BadRequest(new { error = KindUnknown });
        }

        var (device, refusal) = await DeviceIdentity.ResolveOrRegisterAsync(db, registry, req.Mac, hintedKind, tenant.TenantId, ct);
        if (refusal is not null)
        {
            // The only refusal this path can give that a club can act on: their ceiling of
            // unacknowledged boards is full, so a real board they have just installed will not
            // register until somebody names the ones already waiting. Folded by code — see
            // DeviceFaultSink — because the MAC is the caller's to choose.
            faults.TooManyUnacknowledged(req.Mac);
            return refusal;
        }

        // Read once. The roster's relative seconds are all measured from the same instant,
        // because the box anchors them to the moment it accepted this response.
        var now = DateTimeOffset.UtcNow;
        var s = await settings.GetAsync(ct);

        // Moves LastSeenAt AND, if this call ends a silence past the club's own threshold,
        // records that silence — in this same save, because LastSeenAt is the evidence it
        // would otherwise erase and the no-show waiver is settled from it. DeviceSilenceLog
        // says why the health sweep alone cannot see this case.
        DeviceSilenceLog.NoteHeartbeat(db, device!, now, HeartbeatCadence.OfflineAfterSeconds(s.HeartbeatSeconds));

        // The board's own diagnostic counters, to the log and no further. Warning rather than
        // information: a board that could not push a heartbeat, or is losing queued events,
        // is a board somebody has to look at — and nobody at the door can see it.
        //
        // Both are SINCE-BOOT TOTALS, which the log line has to say, because "N since the last
        // one it could" is an instruction to read the wrong number: a technician reading it as
        // a per-interval count sees a board that looks worse every hour it stays up.
        NoteCountersAsync(logs, device!, req);

        // …and the two counters a club has to be able to see: onto the row, and — as the RISE
        // between two heartbeats — into the club's error log. See NoteCounterRows.
        NoteCounterRows(services, device!, req, now);

        // What the board says it speaks, from THIS heartbeat — replaced wholesale, an absent
        // `caps` meaning "nothing", because that is exactly what an image from before member
        // codes sends (member-code §5.1). The cut-over and this beat's answer both key on it.
        MemberCodeRollout.NoteCapabilities(device!, req.Caps, now);

        device!.LastIpAddress = ctx.Connection.RemoteIpAddress?.ToString();
        if (req.EffectiveRunningVersion is { } running) device.RunningVersion = running;
        if (!string.IsNullOrWhiteSpace(req.MegaVersion)) device.MegaVersion = req.MegaVersion.Trim();

        await db.SaveChangesAsync(ct);

        // The club's cut-over (§8), judged with this board's capabilities already on its row.
        // Re-read when it moved, so this very answer is the first one in the new phase.
        if (await services.Rollout.EvaluateAsync(device, s, now, ct)) s = await settings.GetAsync(ct);

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
            return Results.Ok(await GateBodyAsync(services, device, s, now, ct));
        }

        return Results.Ok(await CourtBoxBodyAsync(services, device, req, s, now, ct));
    }

    /// <summary>
    /// A door's answer: the member-code shape for a <c>codes:m1</c> door, else the legacy one.
    /// Lifted out of <see cref="HeartbeatAsync"/> for the complexity gate; the reasoning for the
    /// gate branch is in the comment at its call.
    /// </summary>
    private static async Task<object> GateBodyAsync(
        HeartbeatServices services, Device device, TenantSettingsView s, DateTimeOffset now, CancellationToken ct)
    {
        if (device.SpeaksMemberCodes) return await GateBodyWithCodesAsync(services, device, s, now, ct);

        // A door on legacy firmware: the legacy roster while legacy codes are honoured at
        // all, minted only while the club has not cut over, and nothing once they are not.
        var gateRoster = string.IsNullOrWhiteSpace(device.GateKey) || !MemberCodeSettings.LegacyAccepted(s)
            ? []
            : await DeviceGateRosterBuilder.BuildAsync(services.Db, services.Codes, s, now, MemberCodeSettings.MintsBookingCodes(s), ct);

        return GateHeartbeatView.Of(
            // HeartbeatCadence.Effective, not the raw setting. A stored 3600 used to be
            // sent verbatim to a board that clamps to 300, while the console showed 300 —
            // the exact failure HeartbeatCadence exists to prevent, reproduced on the one
            // path that bypassed it.
            device, services.Tenant.TenantSlug, HeartbeatCadence.Effective(s.HeartbeatSeconds),
            GateAccess.UnlockSecondsFor(s), gateRoster, now);
    }

    /// <summary>A court box's answer: its roster, the member-code sync, and the restore. Lifted out of <see cref="HeartbeatAsync"/> for the complexity gate.</summary>
    private static async Task<Dictionary<string, object?>> CourtBoxBodyAsync(
        HeartbeatServices services, Device device, HeartbeatRequest req, TenantSettingsView s, DateTimeOffset now, CancellationToken ct)
    {
        var db = services.Db;
        // The bookings this box may admit on its own, as TOKEN|relay|opens_in|closes_in.
        // Always present, even when empty: the firmware replaces its cache wholesale on
        // every push, and a cancelled booking is expressed by its absence from the next
        // one — an omitted key would leave a stale roster live. See DeviceRosterBuilder.
        var v1 = device.SpeaksMemberCodes && MemberCodeSettings.RostersCarryPlayers(s);
        var entries = v1
            ? await DeviceRosterBuilder.BuildV1Async(new RosterSources(db, services.Players, services.MemberCodes), device, s, now, ct)
            : [];
        var roster = v1
            ? [.. entries.Select(e => e.Element)]
            : MemberCodeSettings.LegacyAccepted(s)
                ? await DeviceRosterBuilder.BuildAsync(new LegacyRosterSources(db, services.Codes), device, s, now, MemberCodeSettings.MintsBookingCodes(s), ct)
                : [];
        var sync = device.SpeaksMemberCodes
            ? MemberCodeHeartbeat.Sync(entries, v1 && MemberCodeHeartbeat.Acknowledged(device),
                MemberCodeWire.CourtBoxKeyCap, services.MemberCodes, MemberCodeMath.ZoneOf(s.Timezone), now)
            : null;

        // GOAL item 17. Settled BEFORE the response is composed, because the previous beat's
        // outcome and this beat's answer are one decision: a box that just told us it restored
        // nothing needs the same answer again, and one that told us it restored two courts
        // needs those courts on the server's books before the control board is asked about them.
        var relays = await RestoreAsync(services, device, req, s, now, ct);

        await db.SaveChangesAsync(ct);

        // AFTER the commit, for the reason the activation path publishes after its own: a
        // restored court that appears on the board and then vanishes because the save failed
        // sends somebody to a dark court believing the software said otherwise.
        await PublishRestoredAsync(services, relays, ct);

        return MemberCodeHeartbeat.Fit(
            codes => CourtBoxView(device, services.Tenant.TenantSlug, s, new CourtBoxLists(roster, relays, codes), now),
            sync, MemberCodeWire.CourtBoxMaxBytes);
    }


    /// <summary>
    /// A <c>codes:m1</c> door's answer (member-code §5.2–§5.3): v1 elements and keys once the club
    /// has cut over, the legacy roster with the clock and empty arrays before it. An un-named door
    /// gets no roster and no keys either way.
    /// </summary>
    private static async Task<Dictionary<string, object?>> GateBodyWithCodesAsync(
        HeartbeatServices services, Device device, TenantSettingsView s, DateTimeOffset now, CancellationToken ct)
    {
        var named = !string.IsNullOrWhiteSpace(device.GateKey);
        var v1 = MemberCodeSettings.RostersCarryPlayers(s);
        var entries = named && v1
            ? await DeviceGateRosterBuilder.BuildV1Async(services.Db, services.Players, services.MemberCodes, s, now, ct)
            : [];
        IReadOnlyList<string> roster = !named
            ? []
            : v1
                ? [.. entries.Select(e => e.Element)]
                : await DeviceGateRosterBuilder.BuildAsync(services.Db, services.Codes, s, now, mint: true, ct);
        var sync = MemberCodeHeartbeat.Sync(
            entries, v1 && MemberCodeHeartbeat.Acknowledged(device), MemberCodeWire.GateKeyCap,
            services.MemberCodes, MemberCodeMath.ZoneOf(s.Timezone), now);

        return MemberCodeHeartbeat.Fit(
            codes => GateHeartbeatView.WithCodes(
                device, services.Tenant.TenantSlug,
                new GateTiming(HeartbeatCadence.Effective(s.HeartbeatSeconds), GateAccess.UnlockSecondsFor(s)), roster, now, codes),
            sync, MemberCodeWire.GateMaxBytes);
    }

    /// <summary>
    /// Pushes every court this heartbeat changed onto the control board, after the commit.
    ///
    /// <para>
    /// Reads the rows back from the tracker rather than carrying them out of
    /// <see cref="RestoreAsync"/>: the publish must describe what was COMMITTED, and the row
    /// the service returned was the pre-save entity.
    /// </para>
    /// </summary>
    private static async Task PublishRestoredAsync(
        HeartbeatServices services, IReadOnlyList<string>? relays, CancellationToken ct)
    {
        if (relays is null or { Count: 0 }) return;

        foreach (var entry in services.Db.ChangeTracker.Entries<CourtLightState>().ToList())
        {
            var number = await services.Db.Courts.AsNoTracking()
                .Where(c => c.Id == entry.Entity.CourtId)
                .Select(c => c.CourtNumber)
                .FirstOrDefaultAsync(ct);
            if (number == 0) continue;
            await services.Lights.PublishAsync(entry.Entity, number, ct);
        }
    }

    /// <summary>
    /// The court box's heartbeat response.
    ///
    /// <para>
    /// A named method rather than an inline initialiser, for the reason recorded in
    /// <c>memory/gotchas.md</c>: lizard's C# parser treats the <c>{</c> of an object
    /// initialiser as the end of a function, so a large anonymous object inside the handler
    /// charges the rest of the file to a global pseudo-function and trips the length gate.
    /// </para>
    /// </summary>
    internal static Dictionary<string, object?> CourtBoxView(
        Device device, string tenantSlug, TenantSettingsView s, CourtBoxLists lists, DateTimeOffset now)
    {
        var (roster, relays, codes) = lists;
        var body = new Dictionary<string, object?>
        {
            // CLUB-LOCAL WALL TIME, as nineteen characters, and this is a correction rather
            // than a preference. The box has no timezone database and no RTC: it reads the
            // first nineteen characters of this field and prints them on the glass. Sending
            // UTC put a South African club's landing screen two hours behind all day, and
            // "READY 17:42" beside a court booked for 19:45 is a member standing at a box
            // believing they are early.
            //
            // The offset is deliberately NOT appended. A board that prints a prefix cannot be
            // handed a value whose meaning depends on a suffix it will never read.
            //
            // AND THERE IS NO `server_unix` BESIDE IT. One was added here and taken out again:
            // the device scheme keeps no clock, every relative number on this wire is relative
            // to the response, and three tests — two on the live response and one on each
            // corpus family — exist precisely to stop that field coming back. A second
            // representation of the same instant is a second thing that can disagree.
            ["server_time"] = ClubWallTime(s, now),

            ["tenant_slug"] = tenantSlug,
            ["device_code"] = device.DeviceCode,

            // The courts this box drives, in relay order: index 0 = relay A … index
            // 3 = relay D. Replaces the old single court_number — one physical box
            // serves up to four courts (review C4). The button map below is the
            // EFFECTIVE one for this box — its own override, else the club's — and
            // is guaranteed to fit this list: the pair is checked at the moment an
            // admin saves either one (ButtonMap.FirstSelectionBeyond), and
            // auto-registration derives an override rather than leaving a mismatch.
            ["court_numbers"] = device.CourtNumbers,

            // Effective, not raw. See the gate branch above for what the raw value did.
            ["heartbeat_seconds"] = HeartbeatCadence.Effective(s.HeartbeatSeconds),
            ["config"] = ConfigView(device, s),
        };

        // ABSENT when the club has switched restore off, EMPTY when nothing should be on, and
        // the two mean different things to the firmware: absent is "this API does not do
        // restore" and the box stops waiting for one; empty is "nothing should be on", which
        // is information at boot. Neither ever switches anything off. Written BEFORE the
        // roster, which is the order both corpora pin (the firmware scans by key and does not
        // care; the byte-for-byte vectors do).
        if (relays is not null) body["relays"] = relays;
        body["roster"] = roster;

        // The member-code sync, after the roster (§5.2), for a board that said `codes:m1`.
        codes?.WriteTo(body);

        return body;
    }

    /// <summary>
    /// The club's own wall clock at <paramref name="now"/>, as the nineteen characters
    /// <c>YYYY-MM-DDTHH:MM:SS</c>.
    ///
    /// <para>
    /// Falls back to UTC when the club's stored zone id is one this platform's tzdb does not
    /// know. A board printing UTC is wrong by an offset; a board printing nothing because the
    /// heartbeat threw is a board with a blank screen, and the settings PUT is not the only way
    /// a value reaches that column.
    /// </para>
    /// </summary>
    private static string ClubWallTime(TenantSettingsView s, DateTimeOffset now)
    {
        var local = TimeZoneInfo.TryFindSystemTimeZoneById(s.Timezone, out var zone)
            ? TimeZoneInfo.ConvertTime(now, zone)
            : now;
        return local.ToString("yyyy-MM-ddTHH:mm:ss");
    }

    /// <summary>
    /// The <c>config</c> block: the numbers the box runs on.
    ///
    /// <para>
    /// Every value is read through <see cref="BoxSettings"/> rather than off the settings
    /// record, so the board is never sent a number the board would refuse — the rule the roster
    /// path already follows and the two decision paths did not. An absent key is impossible
    /// here by construction; the firmware's own contract is that an absent key changes nothing,
    /// which is what keeps an older API from blanking what a newer one configured.
    /// </para>
    /// </summary>
    private static object ConfigView(Device device, TenantSettingsView s)
    {
        return new
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
            // the desk.
            walk_up_max_minutes = Math.Min(s.WalkUpMaxMinutes, RelayHardCap.Minutes),

            // GOAL items 1, 11, 15 and 18 — the screen's own clocks. Every one of them is a
            // timeout that returns the glass to the landing page, which is the whole of the
            // "screens that never leave and no button closes" class of defect: a deadlock is
            // a state with no exit, and a revert timer is an exit that cannot be missed.
            //
            // lcd_revert_seconds is BOTH item 1's revert and item 18's rapid-scan window.
            // There is deliberately one number: the countdown item 18 asks for IS this hold,
            // surfaced, and a scan pre-empts it immediately rather than waiting it out. A
            // second "cooldown" setting would be a second timer over the same interval, and a
            // second state that can get stuck.
            lcd_revert_seconds = BoxSettings.LcdRevertSeconds(s),
            lcd_choice_seconds = BoxSettings.LcdChoiceSeconds(s),
            lcd_card_seconds = BoxSettings.LcdCardSeconds(s),
            lcd_hint_seconds = BoxSettings.LcdHintSeconds(s),

            // Held at or above lcd_choice_seconds by the reader, not by luck. Below it, a
            // member who scans, walks to the court door and comes back finds the pad still
            // holding their selection while the bridge has forgotten who they are — a
            // selection belonging to nobody, which is how somebody else's court comes on.
            scan_memory_seconds = BoxSettings.ScanMemorySeconds(s),

            clock_trust_minutes = BoxSettings.ClockTrustMinutes(s),
            relay_restore_enabled = BoxSettings.RelayRestoreEnabled(s),
            device_fault_reporting = BoxSettings.DeviceFaultReporting(s),
            device_fault_max_per_hour = BoxSettings.DeviceFaultMaxPerHour(s),

            // What each of the eight buttons does, by physical position. Sent on
            // every heartbeat rather than only when it changes: a box that
            // rebooted and missed the change would otherwise open the wrong
            // court until somebody edited the setting again. Same wire shape
            // whether the map is the box's own or the club's.
            button_map = ButtonMap.EffectiveFor(device.ButtonMapJson, s.Buttons).ToWire(),
        };
    }

    /// <summary>
    /// The board's two diagnostic counters, logged and nothing else.
    ///
    /// <para>
    /// <b>A value out of range is ignored rather than refused, and that is the whole of B7.</b>
    /// Both counters saturate at <c>int.MaxValue</c> on the board and are 64-bit here, so the
    /// first value past the saturation point does not answer <c>400</c> for the WHOLE
    /// heartbeat — which is what an <c>int?</c> binding did, taking the <c>gate</c> block and
    /// the roster down with it. The corpus vector's own note has said since it was written
    /// that a counter must not be able to take a door out of service; it could.
    /// </para>
    ///
    /// <para>
    /// <b>They are since-boot totals.</b> A board has no way to know which report the server
    /// kept, so a counter reset on send loses the whole count on any lost response — the exact
    /// case the counter exists to report. The reader takes the RISE between two heartbeats,
    /// which is why the log line says "since boot" rather than the sentence it used to.
    /// </para>
    /// </summary>
    private static void NoteCountersAsync(ILoggerFactory logs, Device device, HeartbeatRequest req)
    {
        var logger = logs.CreateLogger(typeof(DeviceEndpoints));

        if (req.NoPush is > 0 and { } noPush)
        {
            logger.LogWarning(
                "Device {DeviceCode} reports {NoPush} heartbeat(s) it could not push since boot (a total, not a delta)",
                device.DeviceCode, noPush);
        }

        if (req.EventsLost is > 0 and { } eventsLost)
        {
            logger.LogWarning(
                "Device {DeviceCode} reports {EventsLost} queued event(s) its ring overwrote since boot (a total, not a delta)",
                device.DeviceCode, eventsLost);
        }
    }

    /// <summary>
    /// GOAL item 17, both halves: settle what the box did with the LAST restore, then compute
    /// this one. Returns the wire array, or null when this club has switched restore off.
    ///
    /// <para>
    /// <b>The two halves are one method because they are one decision.</b> Settling first means
    /// a box reporting <c>restored_relays: 0</c> against an outstanding expectation is recorded
    /// as a failure AND is handed the same answer again on this very response — which is the
    /// only behaviour that gets the court lit without a person walking to the cupboard.
    /// </para>
    ///
    /// <para>
    /// Nothing here queues an activation, re-stamps attendance or touches money. <b>The API is
    /// the SOURCE of the restore, so it has already heard about it</b> — the event queue exists
    /// to carry what the API did NOT hear. The <c>!ON</c> the box sends is a relay command and
    /// nothing else, which is what makes a second power cut a second harmless restore rather
    /// than a second charge.
    /// </para>
    /// </summary>
    private static async Task<IReadOnlyList<string>?> RestoreAsync(
        HeartbeatServices services, Device device, HeartbeatRequest req, TenantSettingsView s,
        DateTimeOffset now, CancellationToken ct)
    {
        // The box's own report is read whether or not restore is enabled: it is evidence about
        // the hardware, not part of the restore handshake, and a club that has switched restore
        // off still wants its control board to say "confirmed by the box".
        await NoteRelayReportAsync(services, device, req, now, ct);

        if (!BoxSettings.RelayRestoreEnabled(s)) return null;

        var plan = await RelayRestorePlan.ForAsync(services.Db, device, now, ct);
        await SettleRestoreAsync(services, device, req, plan, now, ct);

        // Marked ONLY for a board that looks freshly booted. The answer is served on every
        // heartbeat because only the box knows whether it has just started, but an ordinary
        // running box with a lit court must never be asked to confirm a restore it was never
        // going to perform — that would file a `restore_failed` every minute of every evening
        // and bury the one that means a court is genuinely dark.
        if (plan.Count > 0 && LooksFreshlyBooted(req, s))
        {
            device.RestoreServedAt = now;
            device.RestoreServedRelays = plan.Count;
            Audit(services, device, "device.relay_restore_served", new
            {
                device_id = device.Id,
                device_code = device.DeviceCode,
                relays = plan.Select(p => new
                {
                    relay = p.Relay,
                    court_number = p.CourtNumber,
                    remaining_seconds = p.RemainingSeconds,
                    booking_id = p.BookingId,
                }),
            });
        }

        return [.. plan.Select(p => p.ToWire())];
    }

    /// <summary>
    /// What the box says its relays are actually doing, onto the light-state projection —
    /// the <c>confirmed_at</c> half of GOAL item 10.
    ///
    /// <para>
    /// <b>Every other column on that row is the server's BELIEF.</b> It is assembled from
    /// grants the server issued and events it was told about, and until this report arrives a
    /// control-board tile can only honestly say "we believe Court 2 is on". This is the box
    /// answering "here is what is closed right now", which is what lets the tile say "lights on
    /// — confirmed by the box at 18:04" and survive a member asking whether the software is
    /// sure.
    /// </para>
    ///
    /// <para>
    /// <b>An ABSENT key and an EMPTY array are different and both are handled.</b> Absent is a
    /// firmware that does not report relay state — every board in the field until the new image
    /// ships — and nothing is written, so the tiles keep saying "believed". Empty is the box
    /// reporting that nothing is closed, which confirms every one of its courts OFF. Treating
    /// absence as emptiness would paint "confirmed off" across every court in every club still
    /// running the current firmware.
    /// </para>
    ///
    /// <para>
    /// The report does NOT change the believed state. It is a second, independent column: a box
    /// that says a relay is open while the server believes it granted time is a contradiction
    /// an admin must SEE, not one the server should resolve by quietly adopting the box's view
    /// and losing the evidence that they disagreed.
    /// </para>
    /// </summary>
    private static async Task NoteRelayReportAsync(
        HeartbeatServices services, Device device, HeartbeatRequest req, DateTimeOffset now,
        CancellationToken ct)
    {
        if (req.RelayState is not { } report) return;
        if (device.Kind != DeviceKind.CourtBox) return;

        var closed = new HashSet<int>();
        foreach (var element in report)
        {
            // One bad element must not discard the evening's other three — the rule the roster
            // parser already states. A malformed entry is skipped silently here because the
            // fault channel is where a board's malformed output belongs, and raising one row
            // per heartbeat for a board with a stuck formatter is the flood item 7 exists to
            // prevent.
            var pipe = element?.IndexOf('|') ?? -1;
            if (pipe <= 0) continue;
            if (int.TryParse(element![..pipe], out var relay) && relay >= 0) closed.Add(relay);
        }

        var courts = await services.Lights.CourtsByRelayAsync(device, ct);
        for (var relay = 0; relay < courts.Count; relay++)
        {
            if (courts[relay] is not { } court) continue;
            await services.Lights.RecordConfirmationAsync(
                court.Id, device.Id, relay, closed.Contains(relay), now, ct);
        }
    }

    /// <summary>
    /// Whether this heartbeat is plausibly the board's first since a reboot.
    ///
    /// <para>
    /// Derived from the board's own uptime against the club's effective cadence — the same
    /// derivation the firmware uses for how long its landing screen says "checking with the
    /// club": four beats, clamped into <c>[60 s, 600 s]</c>. A board with no uptime field at
    /// all is treated as fresh, because a firmware that does not report uptime is an older
    /// build and the restore is the whole point of the feature.
    /// </para>
    /// </summary>
    private static bool LooksFreshlyBooted(HeartbeatRequest req, TenantSettingsView s)
    {
        if (req.UptimeMs is not { } uptime) return true;
        var window = Math.Clamp(HeartbeatCadence.Effective(s.HeartbeatSeconds) * 4, 60, 600);
        return uptime <= window * 1000L;
    }

    /// <summary>
    /// What the box did with the restore it was last served.
    ///
    /// <para>
    /// Three outcomes and each has a row, because the club needs to be able to tell them apart:
    /// nothing outstanding (silence); the box acted (confirmed, and the courts go on the
    /// server's books as restored after a power loss); the box heard and did not act
    /// (<b>failed</b> — a court is dark that the club believes is lit, with a member on it who
    /// has already been charged, and this is the highest-value single row on the control board).
    /// </para>
    ///
    /// <para>
    /// The expectation is consumed whatever the answer. The box restores exactly once per boot,
    /// so a second beat carrying zero is not a second failure — it is a board running normally,
    /// and re-filing the failure every minute would turn the one row that matters into noise.
    /// </para>
    /// </summary>
    private static async Task SettleRestoreAsync(
        HeartbeatServices services, Device device, HeartbeatRequest req,
        IReadOnlyList<RelayRestoreItem> plan, DateTimeOffset now, CancellationToken ct)
    {
        var restored = req.RestoredRelays is > 0 and { } n ? n : 0;
        var served = device.RestoreServedRelays;
        if (device.RestoreServedAt is null && restored == 0) return;

        device.RestoreServedAt = null;
        device.RestoreServedRelays = 0;

        if (restored == 0)
        {
            Audit(services, device, "device.relay_restore_failed", new
            {
                device_id = device.Id,
                device_code = device.DeviceCode,
                served,
                restored = 0,
            });
            DeviceErrorService.InBackground(
                services.Scopes, services.Logs.CreateLogger(typeof(DeviceEndpoints)),
                services.Tenant.TenantId, services.Tenant.TenantSlug,
                new DeviceErrorReport(
                    DeviceErrorCodes.RestoreNotConfirmed, DeviceErrorSource.Server,
                    DeviceId: device.Id, ClaimedDeviceCode: device.DeviceCode,
                    // In words (review round 1, B16): the fault page shows this line to a volunteer
                    // admin, and "served 4 relay(s)" is the server's vocabulary, not theirs.
                    Detail: RestoreDetail(served)));
            return;
        }

        Audit(services, device, "device.relay_restore_confirmed", new
        {
            device_id = device.Id,
            device_code = device.DeviceCode,
            served,
            restored,
        });

        foreach (var item in plan)
        {
            var evidence = new LightEvidence(item.CourtId, device.Id, item.Relay, Seq: 0, BootId: 0, At: now);
            var row = await services.Lights.RecordOnAsync(
                evidence, item.EndsAt, LightCause.RestoreAfterPowerDip, item.CausedByUserId,
                item.BookingId, ct);
            if (row is null) continue;

            services.Lights.Audit(
                CourtLightStateService.LightsRestoredAction, item.CourtId, item.CourtNumber,
                item.CausedByUserId,
                new
                {
                    device_id = device.Id,
                    device_code = device.DeviceCode,
                    relay = item.Relay,
                    booking_id = item.BookingId,
                    remaining_seconds = item.RemainingSeconds,
                });
        }
    }

    /// <summary>One audit row about this board, with the details already shaped by the caller.</summary>
    private static void Audit(HeartbeatServices services, Device device, string action, object details)
    {
        services.Db.AuditLogs.Add(new AuditLog
        {
            TenantId = device.TenantId,
            ActorUserId = Guid.Empty,
            Action = action,
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(details),
        });
    }

    /// <summary>
    /// Puts the board's dropped-record counter on the ROW, where a club can see it (R3-33).
    ///
    /// <para>
    /// <b>It was logged and stored nowhere.</b> This is the only number in the system that says
    /// a door's history has holes in it — the board's queue is a fixed ring, and a door that
    /// scans faster than it can upload, or that stays offline long enough, overwrites its own
    /// oldest entries. It went to a warning in the API's container log, which is not a place a
    /// club can read, so "why is there nothing in the log between 19:00 and 21:00" had no answer
    /// on any screen.
    /// </para>
    ///
    /// <para>
    /// <b>Absent is not zero, and a zero is not "nothing was lost".</b> A board on an older
    /// build sends no counter at all; one that has just rebooted sends a genuine zero and has
    /// forgotten everything it lost before the reboot. So an absent value leaves BOTH columns
    /// exactly as they were — a club that has seen a loss keeps seeing it — and a present value,
    /// including zero, is stored with the instant it arrived. That instant is what lets a
    /// console say "as of 19:04" rather than asserting a current state it cannot know.
    /// </para>
    ///
    /// <para>
    /// Clamped into <see cref="int"/>: the wire field is a <c>long</c> because the board's
    /// counter is, and a value past <c>int.MaxValue</c> is a board whose counter has gone wrong
    /// rather than a club that lost two billion scans. Saturating is honest at the top end and
    /// cannot throw. Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    /// <summary>
    /// Both board counters onto the row, and their RISE into the club's error log — GOAL item
    /// 7's answer to the two genuine failure counters the firmware reports.
    ///
    /// <para>
    /// <b>The rise, not the absolute, and that is the whole reason this is not one line.</b>
    /// Both counters are since-boot totals, so a board that has been up for a week and lost
    /// fourteen events would otherwise re-report the same fourteen every single minute — three
    /// hundred rows a day saying one thing happened once. The delta between two heartbeats is
    /// the number of NEW failures, which is the only figure an admin can act on. A counter that
    /// went DOWN is a reboot, not a negative rise, and contributes nothing.
    /// </para>
    ///
    /// <para>
    /// The absolute is kept on the row and echoed into the error row's detail as
    /// <c>since_boot=&lt;n&gt;</c>, which is what answers "and how many in total" without a
    /// second column anywhere.
    /// </para>
    /// </summary>
    private static void NoteCounterRows(
        HeartbeatServices services, Device device, HeartbeatRequest req, DateTimeOffset now)
    {
        NoteCounter(services, device, new CounterReport(
            DeviceErrorCodes.QueueEventsLost, req.EventsLost, device.EventsLost, now,
            (d, value) => { d.EventsLost = value; d.EventsLostReportedAt = now; }));

        NoteCounter(services, device, new CounterReport(
            DeviceErrorCodes.QueueNoPush, req.NoPush, device.NoPush, now,
            (d, value) => { d.NoPush = value; d.NoPushReportedAt = now; }));
    }

    /// <summary>
    /// One since-boot counter: stored, and its rise reported.
    ///
    /// <para>
    /// <b>Absent is not zero, and a zero is not "nothing was lost".</b> A board on an older
    /// build sends no counter at all; one that has just rebooted sends a genuine zero and has
    /// forgotten everything it lost before the reboot. So an absent value leaves the columns
    /// exactly as they were — a club that has seen a loss keeps seeing it — and a present
    /// value, including zero, is stored with the instant it arrived. That instant is what lets
    /// a console say "as of 19:04" rather than asserting a current state it cannot know.
    /// </para>
    ///
    /// <para>
    /// Clamped into <see cref="int"/>: the wire field is a <c>long</c> because the board's
    /// counter is, and a value past <c>int.MaxValue</c> is a board whose counter has gone wrong
    /// rather than a club that lost two billion scans. Saturating is honest at the top end and
    /// cannot throw.
    /// </para>
    /// </summary>
    private static void NoteCounter(HeartbeatServices services, Device device, CounterReport report)
    {
        var (code, reported, previous, now, store) = report;
        if (reported is not { } value) return;

        var current = (int)Math.Clamp(value, 0, int.MaxValue);
        var rise = current - previous;
        store(device, current);
        if (rise <= 0) return;

        DeviceErrorService.InBackground(
            services.Scopes, services.Logs.CreateLogger(typeof(DeviceEndpoints)),
            device.TenantId, services.Tenant.TenantSlug,
            new DeviceErrorReport(
                code, DeviceErrorSource.Server, DeviceId: device.Id,
                ClaimedDeviceCode: device.DeviceCode,
                Detail: $"since_boot={current}", Count: rise, At: now));
    }

    /// <summary>The restore fault's detail, in the club's words (B16).</summary>
    internal static string RestoreDetail(int served)
    {
        var courts = served == 1 ? "1 court's lights" : $"{served} courts' lights";
        return $"The box was told to switch {courts} back on after the power cut and has not confirmed any of them.";
    }
}

/// <summary>
/// One since-boot counter as this heartbeat found it: what it is called, what the board says
/// now, what the row said before, and where to put the new value.
/// </summary>
/// <param name="Code">The error-log code the RISE is reported under.</param>
/// <param name="Reported">What the board sent, or null when it sent nothing.</param>
/// <param name="Previous">What the row held before this heartbeat.</param>
/// <param name="Now">The instant the value arrived, which is what makes "as of 19:04" sayable.</param>
/// <param name="Store">Puts the clamped value and its instant on the row.</param>
public sealed record CounterReport(
    string Code, long? Reported, int Previous, DateTimeOffset Now, Action<Device, int> Store);

/// <summary>
/// The services the heartbeat needs, bundled — the same reason as <see cref="WalkUpServices"/>:
/// bound individually they put too many parameters on one handler, past the complexity gate.
/// </summary>
public sealed record HeartbeatServices(
    MainframeDbContext Db,
    ITenantContext Tenant,
    TenantSettingsAccessor Settings,
    DeviceRegistryService Registry,
    AccessCodeService Codes,
    /// <summary>The light-state projection this heartbeat's restore and relay report both write.</summary>
    CourtLightStateService Lights,
    /// <summary>For the fault rows this heartbeat raises off the request thread. See <see cref="DeviceErrorService.InBackground"/>.</summary>
    IServiceScopeFactory Scopes,
    ILoggerFactory Logs,
    /// <summary>The refusal sites' fault recorder. See <see cref="DeviceFaultSink"/>.</summary>
    DeviceFaultSink Faults,
    /// <summary>REFs and per-day keys for the member-code sync (§5).</summary>
    MemberCodeService MemberCodes,
    /// <summary>Who plays on a booking — organiser and accepted partners (<see cref="ParticipantBookingPlayers"/>).</summary>
    IBookingPlayers Players,
    /// <summary>Capabilities and the club's cut-over (§8).</summary>
    MemberCodeRollout Rollout);

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
    /// How many heartbeats the board could not push <b>since boot</b>. Optional, additive, and
    /// a DIAGNOSTIC — a board that sends nothing is a board reporting zero.
    ///
    /// <para>
    /// A door has one LED and a boot log, and the failure this reports is one a member must
    /// never be shown: a heartbeat body that did not fit the board's buffer, arrived
    /// incomplete, or failed its read on an otherwise-200 response. A distinct LED cue means
    /// nothing to the person standing at the door, so it rides the request instead.
    /// </para>
    ///
    /// <para>
    /// <b>It is a SINCE-BOOT TOTAL and this used to say "since it last reported one".</b> A
    /// board cannot know which of its reports the server kept — the lost response is precisely
    /// the case the counter exists to report — so a counter reset on send would lose the whole
    /// count exactly when it mattered. The reader takes the rise between two heartbeats. The
    /// board saturates it at <c>int.MaxValue</c> rather than wrapping, so a board up for years
    /// reports a ceiling instead of a small number.
    /// </para>
    ///
    /// <para>
    /// <b>The watchdog half does NOT ride this, and three places said it did.</b> A watchdog
    /// that will not arm is reported by the link pattern's fault variant on the LED and by the
    /// boot log; it is not a heartbeat that failed to push, and folding it in here would make
    /// a single number mean two unrelated things to whoever reads it.
    /// </para>
    ///
    /// <para>
    /// <b>It is logged and not stored.</b> A column on <see cref="Device"/> would be an EF
    /// migration for a counter nothing decides anything on, and this repository's rule is
    /// that a schema change needs one; the log line carries the device code, which is what a
    /// technician searches by. It changes nothing about the response. Corpus vector
    /// <c>gate-heartbeat-request-no-push</c>.
    /// </para>
    ///
    /// <para>
    /// <b>It binds as 64-bit, and this is not tidiness.</b> As an <c>int?</c> the first value
    /// past the board's own saturation point answered <c>400</c> for the WHOLE heartbeat —
    /// the <c>gate</c> block and the roster with it — so a diagnostic counter could take every
    /// door in a club out of service at its next stale deadline, which is the one thing the
    /// corpus vector's note says it must never do. Out-of-range and negative values are
    /// IGNORED. Vector <c>gate-heartbeat-request-counters-out-of-range</c>.
    /// </para>
    /// </summary>
    [property: JsonPropertyName("no_push")] long? NoPush = null,
    /// <summary>
    /// How many queued events the board's ring overwrote before they could be uploaded,
    /// <b>since boot</b>. Optional, additive, saturating, and bound and handled exactly as
    /// <see cref="NoPush"/> is — see there for why both of those matter.
    ///
    /// <para>
    /// The event queue's own header promised it was "never silent" about overflow, and for the
    /// gate it now is not: a board that has been offline long enough to lose events says so,
    /// and a technician can tell "nothing happened" from "we lost the record of it". The court
    /// box's wire is untouched this round.
    /// </para>
    /// </summary>
    [property: JsonPropertyName("events_lost")] long? EventsLost = null,
    /// <summary>
    /// How many relays this box re-energised from the restore it was last served — GOAL item
    /// 17's acknowledgement. Omitted at zero, so a board with nothing to report sends the same
    /// body it always did.
    ///
    /// <para>
    /// It is how the server learns the restore LANDED. A served restore followed by a zero —
    /// or by an absent field, which reads as zero — is the row an admin must see, because it
    /// means a court is dark that the club believes is lit, with a member on it who has already
    /// been charged.
    /// </para>
    ///
    /// <para>
    /// <c>long?</c> and not <c>int?</c>, for the reason <see cref="NoPush"/> is: an
    /// out-of-range value must be ignored, never 400 the whole heartbeat and take the roster
    /// and the config down with it. A diagnostic counter must not be able to take a court box
    /// out of service.
    /// </para>
    /// </summary>
    [property: JsonPropertyName("restored_relays")] long? RestoredRelays = null,
    /// <summary>
    /// What the box BELIEVES is closed right now, carried up from the Mega's <c>!STATE</c>, as
    /// <c>&lt;relay&gt;|&lt;remaining_seconds&gt;</c>.
    ///
    /// <para>
    /// The same pipe-delimited string array as the restore answer, for the same heapless-scanner
    /// reason. <b>Three states, not two:</b> the key ABSENT means this firmware does not report
    /// relay state at all — which is every board in the field until the new image ships — and
    /// an EMPTY ARRAY means the box reports that nothing is closed. Reading the first as the
    /// second would make the control board say "confirmed off" about every court in every club
    /// running the current firmware.
    /// </para>
    /// </summary>
    [property: JsonPropertyName("relay_state")] string[]? RelayState = null,
    /// <summary>
    /// What this image speaks — <c>["codes:m1"]</c> for the member-code firmware, sent LAST on
    /// every heartbeat (member-code §5.1). Absent from every older image, which reads as "nothing".
    /// </summary>
    [property: JsonPropertyName("caps")] string?[]? Caps = null)
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

/// <summary>
/// The three lists a court box's heartbeat body carries — its roster, the relays to restore
/// (null when the club has restore off) and the member-code sync — bundled for the parameter gate.
/// </summary>
internal sealed record CourtBoxLists(IReadOnlyList<string> Roster, IReadOnlyList<string>? Relays, MemberCodeSync? Codes = null);
