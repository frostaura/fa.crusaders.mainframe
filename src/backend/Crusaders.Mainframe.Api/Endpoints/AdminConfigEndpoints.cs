using System.Text.Json;
using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Admin-only configuration endpoints: tenant-wide booking settings + court CRUD.
/// All mutations rewrite the tenant_settings JSON document or operate on the courts table.
/// </summary>
public static class AdminConfigEndpoints
{
    public static IEndpointRouteBuilder MapAdminConfigEndpoints(this IEndpointRouteBuilder app)
    {
        var settings = app.MapGroup("/api/v1/admin/settings").RequireAuthorization(p => p.RequireRole("admin"));

        settings.MapGet("/", async (MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settingsAccessor, CancellationToken ct) =>
            Results.Ok(await RenderSettingsAsync(db, tenant, settingsAccessor, ct)));

        settings.MapPut("/", async (
            UpdateSettingsRequest req, HttpContext ctx, MainframeDbContext db,
            AdminChangeRecorder recorder, CancellationToken ct) =>
        {
            // A snake-only key spelled camelCase is heard, not silently dropped (SettingsSpelling).
            var (adopted, spelling) = SettingsSpelling.Adopt(req);
            if (spelling is not null) return Results.BadRequest(spelling);
            req = adopted;
            var tenant = ctx.RequestServices.GetRequiredService<ITenantContext>();

            // The row is held from here to the commit (A4-1), so the version check, the
            // cross-key checks against the values in force and the write all see one document.
            await using var tx = await SettingsDocument.LockAsync(db, tenant.TenantId, ct);
            var settingsAccessor = ctx.RequestServices.GetRequiredService<TenantSettingsAccessor>();
            var current = await settingsAccessor.GetAsync(ct);

            var baseError = ValidateBookingKeys(req, current);
            if (baseError is not null) return Results.BadRequest(new { error = baseError });

            // The per-weekday map, strictly. Same posture as the button map: lenient when a
            // box or the booking engine reads a stored document later — a broken one must
            // never close the club — and strict here, because this is the one moment there
            // is a person to tell. The refusal names the day, since "operating hours
            // invalid" on a seven-row form says nothing about which row to fix.
            Dictionary<string, string>? hours = null;
            if (req.OperatingHours is not null)
            {
                if (!OperatingHours.TryParseWire(req.OperatingHours, out hours, out var badDay))
                {
                    return Results.BadRequest(new { error = "operating_hours_day_invalid", day = badDay });
                }
            }
            // The two settings that take money off a member were the only two on this PUT
            // with no bound at all. Both were accepted at any value and both reach the box
            // in the heartbeat config.
            //
            // Grace is capped at the hour the Settings field already declares: no-show
            // detection must stay reachable inside an operating day, and a grace window of
            // 4321 minutes (72 hours) meant `no_show_penalty` could never fire on a
            // 06:00-22:00 club — the sweep's own lookback expires first. Late-cancel is
            // capped at a day, also the field's own declared bound: beyond that every
            // cancellation is inside the window, so a member cancelling a fortnight ahead
            // paid the 30% penalty. Every other setting on this endpoint enforces exactly
            // the range its input declares; these two now do too.
            // (Both bounds are in ValidateBookingKeys, with the other six booking keys.)

            // Timezone was readable and not writable: GET served it, UpdateSettingsRequest
            // had no member for it, so a second club in another zone saw its whole booking
            // grid in South African wall-clock time with no correction short of an UPDATE
            // on the JSON column. Validated against the platform's IANA tzdb — the free-tier
            // dependency CLAUDE.md names — rather than a hand-kept list that would rot.
            if (req.Timezone is not null && !IsKnownTimezone(req.Timezone))
                return Results.BadRequest(new { error = "timezone_invalid" });

            // Strict here, lenient on read. This is the one moment an admin is standing
            // in front of the screen to be told what is wrong with their map; a box
            // reading a broken one later has nobody to ask and must keep working.
            ButtonMap? buttons = null;
            if (req.ButtonMap is not null)
            {
                if (!ButtonMap.TryParse(req.ButtonMap, out buttons, out var reason))
                    return Results.BadRequest(new { error = "button_map_invalid", message = reason });
            }

            var economicsError = ValidateEconomics(req);
            if (economicsError is not null) return Results.BadRequest(new { error = economicsError });

            // Every box and device refusal names the bounds (device-api.md §5, FA-2/BA-05): the
            // console reads its ranges from the GET's `bounds`, and a refusal that did not say what
            // IS accepted is how an admin was told "Allowed: 5-120" by one side and refused by the other.
            var deviceError = ValidateDeviceNumbers(req);
            if (deviceError is not null) return Results.BadRequest(DeviceSettings.Refusal(deviceError));

            var gateError = ValidateGateSettings(req);
            if (gateError is not null) return Results.BadRequest(DeviceSettings.Refusal(gateError));

            var doorError = ValidateDoorSettings(req);
            if (doorError is not null) return Results.BadRequest(new { error = doorError });

            var boxError = ValidateBoxSettings(req);
            if (boxError is not null) return Results.BadRequest(DeviceSettings.Refusal(boxError));

            // The device contract v3 keys (device-api.md §5, §6), under either spelling — see
            // UpdateSettingsRequest.Extra for why they are read from the unmatched keys.
            var (deviceV3Writes, deviceV3Refusal) = DeviceSettings.Parse(req.Extra);
            if (deviceV3Refusal is not null) return Results.BadRequest(deviceV3Refusal);

            // The realtime keys are validated ONCE, here, by the money lane's validator — it is
            // the one that answers with a refusal PAYLOAD naming the bound rather than a bare
            // error string, which is what stops an admin wondering why they cannot have a
            // minute. The control-board-only keys it does not know about are still checked by
            // ValidateLiveSettings beside it.
            var realtimeError = ValidateRealtime(req);
            if (realtimeError is not null) return Results.BadRequest(realtimeError);

            var liveError = ValidateLiveSettings(req) ?? ValidateNotifierSettings(req) ?? ValidatePlayerSettings(req) ?? ValidatePlaySettings(req);
            if (liveError is not null) return Results.BadRequest(new { error = liveError });
            var adminError = ValidateAdminSettings(req, current);
            if (adminError is not null) return Results.BadRequest(new { error = adminError });

            var limitsError = ValidateMemberLimits(req);
            if (limitsError is not null) return Results.BadRequest(new { error = limitsError });

            var codesError = ValidateMemberCodeSettings(req);
            if (codesError is not null) return Results.BadRequest(new { error = codesError });

            // Refused rather than coerced, on the same argument. A club that types an essay
            // into the symbol box is told so, rather than saving and silently getting an R.
            if (req.EffectiveCurrencySymbol is { } symbol && !CurrencySymbol.IsAcceptable(symbol))
            {
                return Results.BadRequest(new
                {
                    error = "currency_symbol_invalid",
                    max_length = CurrencySymbol.MaxLength,
                });
            }

            var row = await db.TenantSettings.FirstOrDefaultAsync(s => s.TenantId == tenant.TenantId, ct);
            if (row is null)
            {
                row = new TenantSettings { TenantId = tenant.TenantId, SettingsJson = "{}" };
                db.TenantSettings.Add(row);
            }
            var doc = ParseObject(row.SettingsJson);

            // A4-1: a page opened before somebody else's save is refused, with what is in force
            // now, rather than quietly putting that person's old values back.
            if (req.Version is { } seen && seen != SettingsDocument.VersionOf(doc))
            {
                return Results.Conflict(new
                {
                    error = SettingsDocument.Changed,
                    version = SettingsDocument.VersionOf(doc),
                    settings = await RenderSettingsAsync(db, tenant, settingsAccessor, ct),
                });
            }

            // Snapshotted BEFORE anything is written into `doc`, which is mutated in place.
            var before = new Dictionary<string, JsonElement>(doc, StringComparer.Ordinal);

            // The cue window must fit inside the forward window, and either may arrive
            // alone — so each is compared against the value that will actually be in
            // effect: the request's, else the stored one, else the canonical default.
            // Derived from the document already in hand rather than a second read of it.
            var effectiveCue = req.ActivationCueWindowMinutes
                ?? GetInt(doc, "activation_cue_window_minutes", TenantSettingsView.DefaultActivationCueWindowMinutes);
            var effectiveForward = req.ActivationForwardWindowMinutes
                ?? GetInt(doc, "activation_forward_window_minutes", TenantSettingsView.DefaultActivationForwardWindowMinutes);
            if (effectiveCue > effectiveForward)
            {
                return Results.BadRequest(new { error = "activation_cue_window_exceeds_forward_window" });
            }

            // A map is checked against every court box that would RUN it before it is
            // saved: the box's court list and the map are edited on different screens, and
            // a court button reaching past a box's list is a button that selects nothing.
            // A box with its own override is unaffected by the club's map and is not
            // consulted — that is what lets a four-court box and a one-court annex box
            // coexist (review #17). Refused with the box named so the admin knows which
            // one to fix, give more courts, or give its own map. Disabled boxes do not
            // count: a switched-off box runs no map.
            if (buttons is not null)
            {
                var boxes = await db.Devices
                    .Where(d => d.Kind == DeviceKind.CourtBox && d.Enabled)
                    .OrderBy(d => d.DeviceCode)
                    .ToListAsync(ct);
                foreach (var box in boxes)
                {
                    if (ButtonMap.FromJson(box.ButtonMapJson) is not null) continue;
                    if (buttons.FirstSelectionBeyond(box.CourtNumbers.Count) is { } index)
                    {
                        return Results.BadRequest(new
                        {
                            error = ButtonMap.SelectsCourtBeyondDeviceCourts,
                            device_code = box.DeviceCode,
                            court_index = index,
                            device_court_count = box.CourtNumbers.Count,
                        });
                    }
                }
            }

            WriteOptionalBookingKeys(doc, req);
            // Omitted means unchanged, like the economics and device keys below it.
            if (req.Timezone is not null) doc["timezone"] = ToElement(req.Timezone.Trim());
            // Same rule for the weekday map, and an EMPTY map is a real instruction rather
            // than a no-op: it means "every day follows the flat pair", which is the only
            // way back to the default once a club has named a day.
            if (hours is not null) doc["operating_hours"] = ToElement(hours);
            // Omitted means unchanged, not "reset to default": a screen that does not
            // yet edit the button map must not wipe one an admin set through another.
            if (buttons is not null) doc["button_map"] = ToElement(buttons.ToWire());
            WriteOptionalEconomics(doc, req);
            WriteOptionalDeviceNumbers(doc, req);
            WriteOptionalGateSettings(doc, req);
            WriteOptionalDoorSettings(doc, req);
            WriteOptionalBoxSettings(doc, req);
            foreach (var (key, value) in deviceV3Writes) doc[key] = value;
            WriteOptionalLiveSettings(doc, req);
            WriteOptionalNotifierSettings(doc, req);
            WriteOptionalPlayerSettings(doc, req);
            WriteOptionalPlaySettings(doc, req);
            WriteOptionalAdminSettings(doc, req);
            WriteOptionalMemberLimits(doc, req);
            WriteOptionalRealtime(doc, req);
            var phaseBefore = doc.TryGetValue(MemberCodeSettings.PhaseKey, out var storedPhase) && storedPhase.ValueKind == JsonValueKind.String
                ? storedPhase.GetString()
                : MemberCodeSettings.Legacy;
            WriteOptionalMemberCodeSettings(doc, req, ctx.User.Id() ?? Guid.Empty, DateTimeOffset.UtcNow);

            // FC-8 (device keys only): saving the walk-up maximum caps every minutes:N button above
            // it — the club's map and every box's own — so the setting finally governs what the box
            // offers, not only what the API sells.
            if (req.WalkUpMaxMinutes is { } walkUpCap) await CapButtonsAsync(db, doc, walkUpCap, ct);

            // D2-B19 — the diff of CHANGED KEYS ONLY, before the document is replaced.
            //
            // This endpoint wrote no record of any kind. Its sharpest form:
            // door_log_retention_days is the cutoff RetentionWorker DELETES audit rows
            // against, so lowering it to 7 destroys the club's door record and left no trace
            // of who lowered it. Changed keys only, because a whole-document before/after on
            // every save makes the record unreadable and stores the same thirty keys a
            // hundred times.
            KeepUnchangedValues(before, doc);
            var changed = ChangedKeys(before, doc);
            row.SettingsJson = JsonSerializer.Serialize(doc);
            // The column was written once, at construction, and never again — a dead audit
            // field on the one table that governs money and lights. Nothing reads it today,
            // which is exactly why it was never noticed: the first person to need "when did
            // this club last change its penalty policy" would have got the seed date and
            // believed it.
            row.UpdatedAt = DateTimeOffset.UtcNow;

            if (changed.Before.Count > 0 || changed.After.Count > 0)
            {
                // Staged, so the record and the change it describes flush together: a record
                // of a save that rolled back is worse than no record.
                await recorder.StageAsync(new AdminChange(
                    Action: AdminChangeActions.SettingsUpdated,
                    ActorUserId: ctx.User.Id() ?? Guid.Empty,
                    SubjectKind: AdminChangeSubjects.Setting,
                    SubjectLabel: "Club settings",
                    Before: changed.Before,
                    After: changed.After), ct);
            }

            await db.SaveChangesAsync(ct);
            if (tx is not null) await tx.CommitAsync(ct);

            await ApplyCutoffToLegacyCodesAsync(db, phaseBefore, req.MemberCodePhase?.Trim(), ct);
            return Results.Ok(new
            {
                saved = true,
                changed_keys = changed.After.Keys.ToList(),
                version = SettingsDocument.VersionOf(doc),
            });
        });

        // The courts moved to AdminCourtEndpoints (review round 4 wave B), with their change record.
        app.MapAdminCourtEndpoints();

        return app;
    }

    /// <summary>
    /// Bounds on the economics keys. Every one of them is a number a member is booked under,
    /// so the point is not tidiness — these are the values a form should never be able to
    /// submit. The slice price, the two conversion rates, the top-up block and the cap are
    /// retired (P13): bound on the request and ignored, never validated (§3.9).
    /// </summary>
    private static string? ValidateEconomics(UpdateSettingsRequest req)
    {
        if (req.MemberPerDayMaxMinutes is < 0 or > 1440) return "member_per_day_max_minutes_out_of_range";
        if (req.PeakAdvanceHoursForRegular is < 0 or > 336) return "peak_advance_hours_out_of_range";
        if (req.RetentionYears is < 1 or > 50) return "retention_years_out_of_range";
        if (req.NoShowLookbackDays is < 1 or > 365) return "no_show_lookback_days_out_of_range";

        if (req.PeakHours is not null && !TryParsePeakHours(req.PeakHours)) return "peak_hours_invalid";
        return null;
    }

    /// <summary>
    /// Bounds on the six court-box and identification keys (WI-2). The walk-up cap
    /// tops out at 90 because that is the relay bank's hard actuation cap — a tenant
    /// setting above it would sell minutes the lights cannot deliver. The cue ≤
    /// forward pair rule is checked in the handler against effective values, because
    /// either key may arrive alone.
    /// </summary>
    private static string? ValidateDeviceNumbers(UpdateSettingsRequest req)
    {
        if (req.WalkUpMaxMinutes is < 1 or > RelayHardCap.Minutes) return "walk_up_max_minutes_out_of_range";
        // The firmware's own bounds, not a wider policy one: bridgelogic::Cadence clamps
        // the interval into [15, 300] whatever the API sends, so accepting 600 here only
        // ever meant an admin reading 600 on the page while every box ran at 300 and the
        // fleet then read as offline for 40% of each interval. See HeartbeatCadence.
        if (req.HeartbeatSeconds is not null
            && (req.HeartbeatSeconds < HeartbeatCadence.MinSeconds || req.HeartbeatSeconds > HeartbeatCadence.MaxSeconds))
        {
            return "heartbeat_seconds_out_of_range";
        }
        // The four bounds are TenantSettingsView's own constants rather than literals here.
        // Two of them reach a door (BookingCodeWindow clamps on read against the same
        // numbers), and a bound an admin is refused at that differs from the bound the reader
        // enforces is the gap a hand-edited settings column walks through.
        if (req.ActivationForwardWindowMinutes is < 1 or > TenantSettingsView.MaxActivationForwardWindowMinutes)
        {
            return "activation_forward_window_minutes_out_of_range";
        }
        if (req.ActivationCueWindowMinutes is < 0 or > TenantSettingsView.MaxActivationCueWindowMinutes)
        {
            return "activation_cue_window_minutes_out_of_range";
        }
        if (req.QrLifetimeSeconds is < 15 or > 3600) return "qr_lifetime_seconds_out_of_range";
        if (req.RosterWindowMinutes is < TenantSettingsView.MinRosterWindowMinutes
            or > TenantSettingsView.MaxRosterWindowMinutes)
        {
            return "roster_window_minutes_out_of_range";
        }
        return null;
    }

    /// <summary>
    /// Bounds on the three door-gate settings.
    ///
    /// <para>
    /// Kept apart from <see cref="ValidateDeviceNumbers"/> rather than folded into it: that
    /// method is the six court-box NUMBERS, and one of these three is a string enum, so a
    /// reader looking for "what bounds gate_access_policy" would have to find it inside a
    /// method whose name says it does not handle it.
    /// </para>
    ///
    /// <para>
    /// The unlock bound is <c>GateAccess</c>'s own clamp, named once so the number an admin
    /// is refused at and the number the door is held open for cannot drift apart. The policy
    /// is checked against the closed set STRICTLY, which is the whole reason the read side is
    /// allowed to treat an unrecognised stored value as corruption rather than as a choice.
    /// </para>
    /// </summary>
    private static string? ValidateGateSettings(UpdateSettingsRequest req)
    {
        var unlock = req.EffectiveGateUnlockSeconds;
        if (unlock is not null && (unlock < GateAccess.MinUnlockSeconds || unlock > GateAccess.MaxUnlockSeconds))
        {
            return "gate_unlock_seconds_out_of_range";
        }
        if (req.EffectiveGateAccessPolicy is { } policy && !GateAccessPolicies.IsKnown(policy.Trim()))
        {
            return "gate_access_policy_invalid";
        }
        if (req.EffectiveGateEarlyEntryMinutes is < 0 or > GateAccess.MaxEarlyEntryMinutes)
        {
            return "gate_early_entry_minutes_out_of_range";
        }
        if (req.EffectiveDeviceAlertCooldownMinutes is { } cooldown
            && (cooldown < TenantSettingsView.MinDeviceAlertCooldownMinutes
                || cooldown > TenantSettingsView.MaxDeviceAlertCooldownMinutes))
        {
            return "device_alert_cooldown_minutes_out_of_range";
        }
        return null;
    }

    /// <summary>
    /// Bounds on the five Wave 1 door settings.
    ///
    /// <para>
    /// Kept apart from <see cref="ValidateGateSettings"/> for the same reason that one is kept
    /// apart from <see cref="ValidateDeviceNumbers"/>: those three answer "who may open a
    /// door", these five answer "what the club may read back about its doors and how a refused
    /// member reaches a person". The bounds are <see cref="DoorSettings"/>' own constants, so
    /// the number an admin is refused at and the number the reader clamps to cannot drift —
    /// and the retention one is the sharpest case of that rule in the tree, because the number
    /// it names is the cutoff a worker DELETES audit rows against.
    /// </para>
    ///
    /// <para>
    /// The two strings may be EMPTY, and emptiness is a real instruction: it is how a club
    /// takes a contact down. What is refused is a value past the length the reader will show,
    /// because a silently truncated phone number is a number a member dials wrong.
    /// </para>
    /// </summary>
    private static string? ValidateDoorSettings(UpdateSettingsRequest req)
    {
        if (req.EffectiveDoorLogRetentionDays is { } retention
            && (retention < DoorSettings.MinLogRetentionDays || retention > DoorSettings.MaxLogRetentionDays))
        {
            return "door_log_retention_days_out_of_range";
        }
        if (req.EffectiveDoorRefusalSpikeCount is { } count
            && (count < DoorSettings.MinRefusalSpikeCount || count > DoorSettings.MaxRefusalSpikeCount))
        {
            return "door_refusal_spike_count_out_of_range";
        }
        if (req.EffectiveDoorRefusalSpikeMinutes is { } minutes
            && (minutes < DoorSettings.MinRefusalSpikeMinutes || minutes > DoorSettings.MaxRefusalSpikeMinutes))
        {
            return "door_refusal_spike_minutes_out_of_range";
        }
        return ValidateClubContact(req);
    }

    /// <summary>
    /// The club's two public contact strings, which are the only settings in this tree that are
    /// PRINTED and DIALLED.
    ///
    /// <para>
    /// B10 / C12. Both accepted anything at all — the console's inputs are not inside a
    /// <c>&lt;form&gt;</c>, so no browser validation ran either — and the value is then printed
    /// on a door card that hangs on a wall and handed to a member outside a building at night
    /// as a <c>tel:</c> or <c>mailto:</c> link. "Ask at the desk" was a valid club phone number
    /// and it produced a link that dialled nothing. Length was bounded and shape was not, which
    /// is the half of the rule that catches a typo and not the half that catches a sentence.
    /// </para>
    ///
    /// <para>
    /// Too-long is answered before not-a-contact, so a pasted paragraph gets the refusal that
    /// names what is wrong with it. Split from <see cref="ValidateDoorSettings"/> rather than
    /// appended to it because the two together are past the complexity gate's branch ceiling —
    /// and because "is this a number a person could ring" is a different question from "is this
    /// integer inside its range". Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static string? ValidateClubContact(UpdateSettingsRequest req)
    {
        var phone = req.EffectiveClubContactPhone;
        var email = req.EffectiveClubContactEmail;

        if (phone is not null && phone.Trim().Length > DoorSettings.MaxContactPhoneLength)
        {
            return "club_contact_phone_too_long";
        }
        if (email is not null && email.Trim().Length > DoorSettings.MaxContactEmailLength)
        {
            return "club_contact_email_too_long";
        }
        if (!DoorSettings.IsPhone(phone)) return "club_contact_phone_invalid";
        if (!DoorSettings.IsEmail(email)) return "club_contact_email_invalid";

        return null;
    }

    /// <summary>
    /// Bounds on the nine numbers delivered to the court box's SCREEN.
    ///
    /// <para>
    /// Every bound is <see cref="BoxSettings"/>' own constant, so the number an admin is
    /// refused at and the number the reader clamps to cannot drift. That rule matters more
    /// here than anywhere else on this endpoint, because these values end up on a board in a
    /// cupboard: an admin who sets a 90-second revert, is answered <c>{"saved": true}</c>, and
    /// watches the box revert after 60 has been told something untrue about hardware they
    /// cannot inspect.
    /// </para>
    ///
    /// <para>
    /// The two booleans have no bounds to check — a boolean is already inside its range — and
    /// the cross-key invariant (<c>scan_memory_seconds &gt;= lcd_choice_seconds</c>) is NOT
    /// enforced here. It is enforced by the reader, which raises the memory to the hold, so a
    /// club that sets them the wrong way round gets the safe answer rather than a refusal
    /// about a relationship between two fields on two different rows of one form.
    /// </para>
    /// </summary>
    private static string? ValidateBoxSettings(UpdateSettingsRequest req)
    {
        if (OutOfRange(req.LcdRevertSeconds, BoxSettings.MinLcdRevertSeconds, BoxSettings.MaxLcdRevertSeconds))
            return "lcd_revert_seconds_out_of_range";
        if (OutOfRange(req.LcdChoiceSeconds, BoxSettings.MinLcdChoiceSeconds, BoxSettings.MaxLcdChoiceSeconds))
            return "lcd_choice_seconds_out_of_range";
        if (OutOfRange(req.LcdCardSeconds, BoxSettings.MinLcdCardSeconds, BoxSettings.MaxLcdCardSeconds))
            return "lcd_card_seconds_out_of_range";
        if (OutOfRange(req.LcdHintSeconds, BoxSettings.MinLcdHintSeconds, BoxSettings.MaxLcdHintSeconds))
            return "lcd_hint_seconds_out_of_range";
        if (OutOfRange(req.ScanMemorySeconds, BoxSettings.MinLcdChoiceSeconds, BoxSettings.MaxScanMemorySeconds))
            return "scan_memory_seconds_out_of_range";
        if (OutOfRange(req.ClockTrustMinutes, BoxSettings.MinClockTrustMinutes, BoxSettings.MaxClockTrustMinutes))
            return "clock_trust_minutes_out_of_range";
        if (OutOfRange(req.DeviceFaultMaxPerHour, BoxSettings.MinDeviceFaultMaxPerHour, BoxSettings.MaxDeviceFaultMaxPerHour))
            return "device_fault_max_per_hour_out_of_range";
        return null;
    }

    /// <summary>
    /// Bounds on the error log's three and the three stream numbers only a CONTROL BOARD uses.
    ///
    /// <para>
    /// The four keys a member's wallet stream shares with it — the keep-alive and the three
    /// fallback numbers — are bounded once, in <see cref="ValidateRealtime"/>, which answers
    /// with a payload naming the bound rather than a bare code. Two validators over one key is
    /// how one of them silently stops being the one that runs.
    /// </para>
    /// </summary>
    private static string? ValidateLiveSettings(UpdateSettingsRequest req)
    {
        if (OutOfRange(req.DeviceErrorRetentionDays, MonitoringSettings.MinRetentionDays, MonitoringSettings.MaxRetentionDays))
            return "device_error_retention_days_out_of_range";
        if (OutOfRange(req.DeviceErrorMaxOpenRows, MonitoringSettings.MinMaxOpenRows, MonitoringSettings.MaxMaxOpenRows))
            return "device_error_max_open_rows_out_of_range";
        if (OutOfRange(req.DeviceErrorIngestPerMinute, MonitoringSettings.MinIngestPerMinute, MonitoringSettings.MaxIngestPerMinute))
            return "device_error_ingest_rate_out_of_range";
        if (OutOfRange(req.ControlBoardResyncSeconds, RealtimeSettings.MinResyncSeconds, RealtimeSettings.MaxResyncSeconds))
            return "control_board_resync_out_of_range";
        if (OutOfRange(req.ControlBoardStaleMultiplier, RealtimeSettings.MinStaleMultiplier, RealtimeSettings.MaxStaleMultiplier))
            return "control_board_stale_multiplier_out_of_range";
        if (OutOfRange(req.RealtimePollSecondsControlBoard, RealtimeSettings.MinPollSecondsControlBoard, RealtimeSettings.MaxPollSecondsControlBoard))
            return "realtime_poll_control_board_out_of_range";
        return null;
    }

    /// <summary>
    /// Bounds on the admin notifier's six (R23), from <see cref="AdminNotificationSettings"/>'
    /// own constants so the number an admin is refused at and the number the notifier clamps to
    /// cannot drift apart.
    /// </summary>
    private static string? ValidateNotifierSettings(UpdateSettingsRequest req)
    {
        if (OutOfRange(req.FaultSpikeCount, AdminNotificationSettings.MinFaultSpikeCount, AdminNotificationSettings.MaxFaultSpikeCount))
            return "fault_spike_count_out_of_range";
        if (OutOfRange(req.FaultSpikeMinutes, AdminNotificationSettings.MinFaultSpikeMinutes, AdminNotificationSettings.MaxFaultSpikeMinutes))
            return "fault_spike_minutes_out_of_range";
        if (OutOfRange(req.ApplicationReminderHours, AdminNotificationSettings.MinApplicationReminderHours, AdminNotificationSettings.MaxApplicationReminderHours))
            return "application_reminder_hours_out_of_range";
        if (OutOfRange(req.AdminNotificationRetentionDays, AdminNotificationSettings.MinRetentionDays, AdminNotificationSettings.MaxRetentionDays))
            return "admin_notification_retention_days_out_of_range";
        if (OutOfRange(req.TopUpFailureCooldownMinutes, AdminNotificationSettings.MinTopUpFailureCooldownMinutes, AdminNotificationSettings.MaxTopUpFailureCooldownMinutes))
            return "topup_failure_cooldown_minutes_out_of_range";
        if (OutOfRange(req.OverdraftCooldownMinutes, AdminNotificationSettings.MinOverdraftCooldownMinutes, AdminNotificationSettings.MaxOverdraftCooldownMinutes))
            return "overdraft_cooldown_minutes_out_of_range";
        return null;
    }

    /// <summary>
    /// Bounds on the players-and-splits ten (D11–D13), from <see cref="PlayerSettings"/>' own
    /// constants so the number refused here and the number clamped on read cannot drift apart.
    /// </summary>
    private static string? ValidatePlayerSettings(UpdateSettingsRequest req)
    {
        (int? Value, int Min, int Max, string Key)[] bounds =
        [
            (req.ShareLapseHours, PlayerSettings.MinShareLapseHours, PlayerSettings.MaxShareLapseHours, PlayerSettings.ShareLapseHoursKey),
            (req.ShareReminderHours, PlayerSettings.MinShareReminderHours, PlayerSettings.MaxShareReminderHours, PlayerSettings.ShareReminderHoursKey),
            (req.ShareReminderMax, PlayerSettings.MinShareReminderMax, PlayerSettings.MaxShareReminderMax, PlayerSettings.ShareReminderMaxKey),
            (req.PlayerNudgeLimit, PlayerSettings.MinNudgeLimit, PlayerSettings.MaxNudgeLimit, PlayerSettings.NudgeLimitKey),
            (req.DirectorySearchesPerMinute, PlayerSettings.MinDirectorySearchesPerMinute, PlayerSettings.MaxDirectorySearchesPerMinute, PlayerSettings.DirectorySearchesPerMinuteKey),
            (req.MemberQuietStartMinute, PlayerSettings.MinQuietMinute, PlayerSettings.MaxQuietMinute, PlayerSettings.QuietStartMinuteKey),
            (req.MemberQuietEndMinute, PlayerSettings.MinQuietMinute, PlayerSettings.MaxQuietMinute, PlayerSettings.QuietEndMinuteKey),
            (req.RecentPartnerDays, PlayerSettings.MinRecentPartnerDays, PlayerSettings.MaxRecentPartnerDays, PlayerSettings.RecentPartnerDaysKey),
            (req.MemberNotificationRetentionDays, PlayerSettings.MinNotificationRetentionDays, PlayerSettings.MaxNotificationRetentionDays, PlayerSettings.NotificationRetentionDaysKey),
            (req.PlayerInvitesPerBooking, PlayerSettings.MinInvitesPerBooking, PlayerSettings.MaxInvitesPerBooking, PlayerSettings.InvitesPerBookingKey),
        ];
        var bad = bounds.FirstOrDefault(b => OutOfRange(b.Value, b.Min, b.Max));
        return bad.Key is null ? null : $"{bad.Key}_out_of_range";
    }

    /// <summary>
    /// Bounds on the play seven (D14), from <see cref="PlaySettings"/>' own constants so the number
    /// refused here and the number clamped on read cannot drift apart.
    /// </summary>
    private static string? ValidatePlaySettings(UpdateSettingsRequest req)
    {
        var values = PlayValues(req);
        foreach (var (key, min, max) in PlaySettings.Bounds)
        {
            if (OutOfRange(values[key], min, max)) return $"{key}_out_of_range";
        }
        return null;
    }

    /// <summary>Same omitted-means-unchanged rule as the economics keys, for the play seven.</summary>
    private static void WriteOptionalPlaySettings(IDictionary<string, JsonElement> doc, UpdateSettingsRequest req)
    {
        foreach (var (key, value) in PlayValues(req))
        {
            if (value is { } v) doc[key] = ToElement(v);
        }
    }

    private static Dictionary<string, int?> PlayValues(UpdateSettingsRequest req)
    {
        // Block body for the lizard reason in memory/gotchas-build.md.
        var values = new Dictionary<string, int?>
        {
            [PlaySettings.AutoConfirmHoursKey] = req.ResultAutoConfirmHours,
            [PlaySettings.RecordDaysKey] = req.ResultRecordDays,
            [PlaySettings.RestEveryWeeksKey] = req.StreakRestEveryWeeks,
            [PlaySettings.RestCapKey] = req.StreakRestCap,
            [PlaySettings.PauseWeeksPerYearKey] = req.StreakPauseWeeksPerYear,
            [PlaySettings.EarlyBirdBeforeMinuteKey] = req.PlayEarlyBirdBeforeMinute,
            [PlaySettings.NightOwlFromMinuteKey] = req.PlayNightOwlFromMinute,
        };
        return values;
    }

    /// <summary>Same omitted-means-unchanged rule as the economics keys, for the players ten.</summary>
    private static void WriteOptionalPlayerSettings(IDictionary<string, JsonElement> doc, UpdateSettingsRequest req)
    {
        (int? Value, string Key)[] values =
        [
            (req.ShareLapseHours, PlayerSettings.ShareLapseHoursKey),
            (req.ShareReminderHours, PlayerSettings.ShareReminderHoursKey),
            (req.ShareReminderMax, PlayerSettings.ShareReminderMaxKey),
            (req.PlayerNudgeLimit, PlayerSettings.NudgeLimitKey),
            (req.DirectorySearchesPerMinute, PlayerSettings.DirectorySearchesPerMinuteKey),
            (req.MemberQuietStartMinute, PlayerSettings.QuietStartMinuteKey),
            (req.MemberQuietEndMinute, PlayerSettings.QuietEndMinuteKey),
            (req.RecentPartnerDays, PlayerSettings.RecentPartnerDaysKey),
            (req.MemberNotificationRetentionDays, PlayerSettings.NotificationRetentionDaysKey),
            (req.PlayerInvitesPerBooking, PlayerSettings.InvitesPerBookingKey),
        ];
        foreach (var (value, key) in values)
        {
            if (value is { } v) doc[key] = ToElement(v);
        }
    }

    /// <summary>Same omitted-means-unchanged rule as the economics keys, for the notifier's six.</summary>
    private static void WriteOptionalNotifierSettings(IDictionary<string, JsonElement> doc, UpdateSettingsRequest req)
    {
        if (req.FaultSpikeCount is { } count) doc["fault_spike_count"] = ToElement(count);
        if (req.FaultSpikeMinutes is { } minutes) doc["fault_spike_minutes"] = ToElement(minutes);
        if (req.ApplicationReminderHours is { } hours) doc["application_reminder_hours"] = ToElement(hours);
        if (req.AdminNotificationRetentionDays is { } days) doc["admin_notification_retention_days"] = ToElement(days);
        if (req.TopUpFailureCooldownMinutes is { } topUp) doc["topup_failure_cooldown_minutes"] = ToElement(topUp);
        if (req.OverdraftCooldownMinutes is { } overdraft) doc["overdraft_cooldown_minutes"] = ToElement(overdraft);
    }

    /// <summary>
    /// Whether a value the caller actually sent is outside its bounds. Absent is never out of
    /// range — omitted means unchanged.
    ///
    /// <para>
    /// Block body rather than an expression one: lizard's C# parser reads the <c>{</c> of the
    /// property pattern as the end of a function and dumps the rest of the file into a
    /// <i>global</i> pseudo-function whose reported length trips <c>-L 200</c>. See
    /// <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static bool OutOfRange(int? value, int min, int max)
    {
        if (value is not { } v) return false;
        return v < min || v > max;
    }

    /// <summary>Same omitted-means-unchanged rule as the economics keys, for the box's nine.</summary>
    private static void WriteOptionalBoxSettings(IDictionary<string, JsonElement> doc, UpdateSettingsRequest req)
    {
        if (req.LcdRevertSeconds is { } revert) doc["lcd_revert_seconds"] = ToElement(revert);
        if (req.LcdChoiceSeconds is { } choice) doc["lcd_choice_seconds"] = ToElement(choice);
        if (req.LcdCardSeconds is { } card) doc["lcd_card_seconds"] = ToElement(card);
        if (req.LcdHintSeconds is { } hint) doc["lcd_hint_seconds"] = ToElement(hint);
        if (req.ScanMemorySeconds is { } memory) doc["scan_memory_seconds"] = ToElement(memory);
        if (req.ClockTrustMinutes is { } trust) doc["clock_trust_minutes"] = ToElement(trust);
        if (req.RelayRestoreEnabled is { } restore) doc["relay_restore_enabled"] = ToElement(restore);
        if (req.DeviceFaultReporting is { } reporting) doc["device_fault_reporting"] = ToElement(reporting);
        if (req.DeviceFaultMaxPerHour is { } faults) doc["device_fault_max_per_hour"] = ToElement(faults);
    }

    /// <summary>
    /// Same omitted-means-unchanged rule, for the error log's three and the three stream
    /// numbers only a control board uses. The four shared with the wallet stream are written
    /// once, by <see cref="WriteOptionalRealtime"/>.
    /// </summary>
    private static void WriteOptionalLiveSettings(IDictionary<string, JsonElement> doc, UpdateSettingsRequest req)
    {
        if (req.DeviceErrorRetentionDays is { } days) doc["device_error_retention_days"] = ToElement(days);
        if (req.DeviceErrorMaxOpenRows is { } rows) doc["device_error_max_open_rows"] = ToElement(rows);
        if (req.DeviceErrorIngestPerMinute is { } rate) doc["device_error_ingest_per_minute"] = ToElement(rate);
        if (req.ControlBoardResyncSeconds is { } resync) doc["control_board_resync_seconds"] = ToElement(resync);
        if (req.ControlBoardStaleMultiplier is { } stale) doc["control_board_stale_multiplier"] = ToElement(stale);
        if (req.RealtimePollSecondsControlBoard is { } board) doc["realtime_poll_seconds_control_board"] = ToElement(board);
    }

    /// <summary>
    /// Bounds on the eight booking keys, each only when sent (A4-1), and the one cross-key rule
    /// among them — the day starts before it ends — against the value in force for the other.
    /// </summary>
    private static string? ValidateBookingKeys(UpdateSettingsRequest req, TenantSettingsView current)
    {
        if (req.AdvanceBookingDays is < 0 or > 365) return "advance_booking_days_out_of_range";
        if (req.SliceMinutes is < 5 or > 240) return "slice_minutes_out_of_range";
        if (req.DayStartMinute is not null || req.DayEndMinute is not null)
        {
            var start = req.DayStartMinute ?? current.DayStartMinute;
            var end = req.DayEndMinute ?? current.DayEndMinute;
            if (start < 0 || end > 24 * 60 || start >= end) return "operating_hours_invalid";
        }
        if (req.PenaltyPct is < 0 or > 100) return "penalty_pct_out_of_range";
        if (req.GraceWindowMinutes is < 0 or > 60) return "grace_window_minutes_out_of_range";
        if (req.PenaltyWindowMinutes is < 0 or > 1440) return "penalty_window_minutes_out_of_range";
        return null;
    }

    /// <summary>The eight booking keys, written only when sent — omitted means unchanged (A4-1).</summary>
    private static void WriteOptionalBookingKeys(IDictionary<string, JsonElement> doc, UpdateSettingsRequest req)
    {
        if (req.SliceMinutes is { } slice) doc["slice_minutes"] = ToElement(slice);
        if (req.AdvanceBookingDays is { } advance) doc["advance_booking_days"] = ToElement(advance);
        if (req.DayStartMinute is { } start) doc["day_start_minute"] = ToElement(start);
        if (req.DayEndMinute is { } end) doc["day_end_minute"] = ToElement(end);
        if (req.PenaltyPct is { } penalty) doc["penalty_pct"] = ToElement(penalty);
        if (req.GraceWindowMinutes is { } grace) doc["grace_window_minutes"] = ToElement(grace);
        if (req.PenaltyWindowMinutes is { } window) doc["penalty_window_minutes"] = ToElement(window);
    }

    /// <summary>
    /// A value sent back that MEANS what is stored keeps the stored form (A4-1), so it is not
    /// "changed" on the record and the document's version does not move. The stored
    /// <c>operating_hours</c> is Postgres' spelling of the map, the sent one the serialiser's,
    /// and the raw-text diff below reported it changed on every save.
    /// </summary>
    private static void KeepUnchangedValues(
        IReadOnlyDictionary<string, JsonElement> before, IDictionary<string, JsonElement> doc)
    {
        foreach (var (key, was) in before)
        {
            if (doc.TryGetValue(key, out var now) && SettingsDocument.SameValue(was, now)) doc[key] = was;
        }
    }

    /// <summary>
    /// The keys whose values differ between the stored document and the one about to replace
    /// it, as two parallel maps.
    ///
    /// <para>
    /// Compared on RAW JSON TEXT rather than on parsed values. Two <c>JsonElement</c>s are
    /// reference-compared by <c>Equals</c>, so a structural comparison would report every key
    /// as changed on every save — which is the unreadable whole-document record this method
    /// exists to avoid, arriving through the back door.
    /// </para>
    ///
    /// <para>
    /// A key that was REMOVED appears in <c>Before</c> and not in <c>After</c>, which is what
    /// lets the diff renderer draw "was 90, now not set" rather than dropping it silently.
    /// </para>
    /// </summary>
    private static (Dictionary<string, object?> Before, Dictionary<string, object?> After) ChangedKeys(
        IReadOnlyDictionary<string, JsonElement> before, IReadOnlyDictionary<string, JsonElement> after)
    {
        var wasChanged = new Dictionary<string, object?>(StringComparer.Ordinal);
        var isChanged = new Dictionary<string, object?>(StringComparer.Ordinal);

        foreach (var key in before.Keys.Concat(after.Keys).Distinct(StringComparer.Ordinal))
        {
            var had = before.TryGetValue(key, out var was) ? was.GetRawText() : null;
            var has = after.TryGetValue(key, out var now) ? now.GetRawText() : null;
            if (had == has) continue;

            if (had is not null) wasChanged[key] = JsonSerializer.Deserialize<object?>(had);
            if (has is not null) isChanged[key] = JsonSerializer.Deserialize<object?>(has);
        }

        return (wasChanged, isChanged);
    }

    private static string? ValidateAdminSettings(UpdateSettingsRequest req, TenantSettingsView current)
    {
        if (req.EffectiveAdminBulkMaxItems is { } items
            && (items < BulkSettings.MinMaxItems || items > BulkSettings.MaxMaxItems))
        {
            return "admin_bulk_max_items_out_of_range";
        }

        if (req.EffectiveScheduleMaxRowsPerChange is { } rows
            && (rows < ScheduleSettings.MinMaxRowsPerChange || rows > ScheduleSettings.MaxMaxRowsPerChange))
        {
            return "schedule_max_rows_out_of_range";
        }

        if (req.EffectiveScheduleWorkerIntervalSeconds is { } tick
            && (tick < ScheduleSettings.MinWorkerIntervalSeconds || tick > ScheduleSettings.MaxWorkerIntervalSeconds))
        {
            return "schedule_worker_interval_out_of_range";
        }

        if (req.EffectiveMemberTraceMaxEvents is { } events
            && (events < TraceSettings.MinMaxEvents || events > TraceSettings.MaxMaxEvents))
        {
            return "member_trace_max_events_out_of_range";
        }

        return ValidateScheduleHorizon(req, current);
    }

    /// <summary>
    /// The materialisation horizon, and the one CROSS-FIELD rule in this lane.
    ///
    /// <para>
    /// Split out of <see cref="ValidateAdminSettings"/> for the complexity gate, and it earns
    /// its own method anyway: the other three bounds are independent numbers, while this one is
    /// a RELATIONSHIP between two keys that are edited from different screens. The failure of
    /// the pair — a member booking fourteen days out into a league night the materialiser has
    /// not written yet — appears weeks later, on the night, as a member holding a paid court the
    /// club promised to a division.
    /// </para>
    /// </summary>
    private static string? ValidateScheduleHorizon(UpdateSettingsRequest req, TenantSettingsView current)
    {
        var sentHorizon = req.EffectiveScheduleMaterialisationDays;
        if (sentHorizon is { } asked
            && (asked < ScheduleSettings.MinMaterialisationDays || asked > ScheduleSettings.MaxMaterialisationDays))
        {
            return "schedule_materialisation_days_out_of_range";
        }
        if (sentHorizon is null && req.AdvanceBookingDays is null) return null;

        // Either key may now arrive alone (A4-1), so each is compared with the value that will
        // be in force: the request's, else the stored one.
        var horizon = sentHorizon ?? ScheduleSettings.MaterialisationDays(current);
        var advance = req.AdvanceBookingDays ?? current.AdvanceBookingDays;
        return horizon < advance ? ScheduleSettings.AdvanceDaysExceedHorizon : null;
    }

    private static void WriteOptionalAdminSettings(IDictionary<string, JsonElement> doc, UpdateSettingsRequest req)
    {
        if (req.EffectiveAdminBulkMaxItems is { } items) doc["admin_bulk_max_items"] = ToElement(items);
        if (req.EffectiveScheduleMaterialisationDays is { } horizon)
            doc["schedule_materialisation_days"] = ToElement(horizon);
        if (req.EffectiveScheduleMaxRowsPerChange is { } rows) doc["schedule_max_rows_per_change"] = ToElement(rows);
        if (req.EffectiveScheduleWorkerIntervalSeconds is { } tick)
            doc["schedule_worker_interval_seconds"] = ToElement(tick);

        // Written as a real JSON boolean, never a string: TenantSettingsAccessor.TryBool
        // accepts true/false only, and a coerced "false" would leave a club that believed it
        // had switched the trace OFF with it on — the one direction that key must never fail in.
        if (req.EffectiveMemberTraceEnabled is { } traceOn)
            doc["member_trace_enabled"] = ToElement(traceOn);
        if (req.EffectiveMemberTraceMaxEvents is { } events)
            doc["member_trace_max_events"] = ToElement(events);
    }

    /// <summary>Same omitted-means-unchanged rule as the economics keys, for the five door settings.</summary>
    private static void WriteOptionalDoorSettings(IDictionary<string, JsonElement> doc, UpdateSettingsRequest req)
    {
        if (req.EffectiveDoorLogRetentionDays is { } retention) doc["door_log_retention_days"] = ToElement(retention);
        if (req.EffectiveDoorRefusalSpikeCount is { } count) doc["door_refusal_spike_count"] = ToElement(count);
        if (req.EffectiveDoorRefusalSpikeMinutes is { } minutes) doc["door_refusal_spike_minutes"] = ToElement(minutes);
        if (req.EffectiveClubContactPhone is { } phone) doc["club_contact_phone"] = ToElement(phone.Trim());
        if (req.EffectiveClubContactEmail is { } email) doc["club_contact_email"] = ToElement(email.Trim());
    }

    /// <summary>
    /// Bounds on the five keys that decide how much of a club day one member may hold
    /// (GOAL items 3 and 19).
    ///
    /// <para>
    /// The bounds are <see cref="BookingLimits"/>' own constants rather than literals here, for
    /// the reason the door block already records: a bound an admin is refused at that differs
    /// from the bound the reader clamps to is the gap a hand-edited column walks through.
    /// </para>
    ///
    /// <para>
    /// <b>Zero is legal on both caps and means unlimited</b> — that is what it has always meant
    /// in <c>CheckPerDayCapAsync</c> — so the lower bound is 0 rather than 1, and the refusal
    /// an admin gets for -1 says out-of-range rather than pretending 0 is invalid.
    /// </para>
    /// </summary>
    private static string? ValidateMemberLimits(UpdateSettingsRequest req)
    {
        if (req.EffectiveMemberMaxSlotsPerDay is < 0 or > BookingLimits.MaxSlotsPerDayCeiling)
        {
            return "member_max_slots_per_day_out_of_range";
        }
        if (req.EffectiveSameDayRelaxationWindowMinutes is < 0 or > BookingLimits.MaxSameDayRelaxationWindowMinutes)
        {
            return "same_day_relaxation_window_out_of_range";
        }
        return null;
    }

    /// <summary>
    /// Bounds on the four real-time keys (GOAL item 8).
    ///
    /// <para>
    /// This one returns a BODY rather than a code, because the keep-alive's ceiling is the one
    /// bound in this file whose number is not self-explanatory: 55 seconds exists because
    /// nginx's <c>proxy_read_timeout</c> default is 60 and the file sets none, so a keep-alive
    /// at 60 is a stream the proxy closes before the server ever speaks on it. An admin told
    /// only "out of range" would reasonably try 60 next.
    /// </para>
    /// </summary>
    private static object? ValidateRealtime(UpdateSettingsRequest req)
    {
        if (req.EffectiveSseKeepaliveSeconds is { } keepalive
            && (keepalive < RealtimeSettings.MinKeepaliveSeconds || keepalive > RealtimeSettings.MaxKeepaliveSeconds))
        {
            return new
            {
                error = "sse_keepalive_seconds_out_of_range",
                min_seconds = RealtimeSettings.MinKeepaliveSeconds,
                max_seconds = RealtimeSettings.MaxKeepaliveSeconds,
                because = "proxy_idle_timeout_60s",
            };
        }
        if (req.EffectiveRealtimeFallbackAfterFailures is { } failures
            && (failures < RealtimeSettings.MinFallbackAfterFailures
                || failures > RealtimeSettings.MaxFallbackAfterFailures))
        {
            return new { error = "realtime_fallback_after_failures_out_of_range" };
        }
        if (req.EffectiveRealtimeFallbackWindowSeconds is { } window
            && (window < RealtimeSettings.MinFallbackWindowSeconds
                || window > RealtimeSettings.MaxFallbackWindowSeconds))
        {
            return new { error = "realtime_fallback_window_out_of_range" };
        }
        if (req.EffectiveRealtimePollSecondsWallet is { } poll
            && (poll < RealtimeSettings.MinPollSecondsWallet || poll > RealtimeSettings.MaxPollSecondsWallet))
        {
            return new { error = "realtime_poll_wallet_out_of_range" };
        }
        return null;
    }

    /// <summary>Same omitted-means-unchanged rule as the economics keys, for the member-limit block.</summary>
    private static void WriteOptionalMemberLimits(IDictionary<string, JsonElement> doc, UpdateSettingsRequest req)
    {
        if (req.EffectiveMemberMaxSlotsPerDay is { } slots) doc["member_max_slots_per_day"] = ToElement(slots);
        if (req.EffectiveSameDayCapRelaxation is { } relax) doc["same_day_cap_relaxation"] = ToElement(relax);
        if (req.EffectiveSameDayRelaxationWindowMinutes is { } window) doc["same_day_relaxation_window_minutes"] = ToElement(window);
        if (req.EffectiveWalkUpHonoursDayCap is { } walkUp) doc["walk_up_honours_day_cap"] = ToElement(walkUp);
        if (req.EffectiveMemberGroupsEnabled is { } groups) doc["member_groups_enabled"] = ToElement(groups);
    }

    /// <summary>Same omitted-means-unchanged rule as the economics keys, for the real-time block.</summary>
    private static void WriteOptionalRealtime(IDictionary<string, JsonElement> doc, UpdateSettingsRequest req)
    {
        if (req.EffectiveSseKeepaliveSeconds is { } keepalive) doc["sse_keepalive_seconds"] = ToElement(keepalive);
        if (req.EffectiveRealtimeFallbackAfterFailures is { } failures) doc["realtime_fallback_after_failures"] = ToElement(failures);
        if (req.EffectiveRealtimeFallbackWindowSeconds is { } window) doc["realtime_fallback_window_seconds"] = ToElement(window);
        if (req.EffectiveRealtimePollSecondsWallet is { } poll) doc["realtime_poll_seconds_wallet"] = ToElement(poll);
        if (req.EffectiveCurrencySymbol is { } symbol) doc[CurrencySymbol.Key] = ToElement(symbol.Trim());
    }

    /// <summary>Same omitted-means-unchanged rule as the economics keys, for the gate block.</summary>
    private static void WriteOptionalGateSettings(IDictionary<string, JsonElement> doc, UpdateSettingsRequest req)
    {
        if (req.EffectiveGateUnlockSeconds is { } unlock) doc["gate_unlock_seconds"] = ToElement(unlock);
        if (req.EffectiveGateAccessPolicy is { } policy) doc[GateAccessPolicies.Key] = ToElement(policy.Trim());
        if (req.EffectiveGateEarlyEntryMinutes is { } early) doc["gate_early_entry_minutes"] = ToElement(early);
        if (req.EffectiveDeviceAlertCooldownMinutes is { } cooldown) doc["device_alert_cooldown_minutes"] = ToElement(cooldown);
    }

    /// <summary>
    /// Whether the platform's IANA tzdb knows this zone id.
    ///
    /// <para>
    /// Block body rather than an expression one, and the id is trimmed here so the check and
    /// the write agree on what was validated. <c>TryFindSystemTimeZoneById</c> is
    /// case-insensitive and accepts Windows ids on Windows, which is fine: the value is only
    /// ever read back through <c>TimeZoneInfo</c>.
    /// </para>
    /// </summary>
    private static bool IsKnownTimezone(string id)
    {
        var trimmed = id.Trim();
        return trimmed.Length > 0 && TimeZoneInfo.TryFindSystemTimeZoneById(trimmed, out _);
    }

    private static bool TryParsePeakHours(string range)
    {
        var parts = range.Split('-');
        return parts.Length == 2
            && TimeOnly.TryParse(parts[0].Trim(), out var start)
            && TimeOnly.TryParse(parts[1].Trim(), out var end)
            && start < end;
    }

    /// <summary>
    /// Writes only the economics keys the caller actually sent.
    ///
    /// <para>
    /// Omitted means unchanged, never "reset to default". The booking-settings form and
    /// the economics form are different screens, and a save from one must not silently
    /// revert the other — which is exactly what a wholesale write would do the first time
    /// somebody edited the slice length.
    /// </para>
    /// </summary>
    private static void WriteOptionalEconomics(IDictionary<string, JsonElement> doc, UpdateSettingsRequest req)
    {
        if (req.MemberPerDayMaxMinutes is not null) doc["member_per_day_max_minutes"] = ToElement(req.MemberPerDayMaxMinutes);
        if (req.PeakHours is not null) doc["peak_hours"] = ToElement(req.PeakHours.Trim());
        if (req.PeakAdvanceHoursForRegular is not null) doc["peak_advance_hours_for_regular"] = ToElement(req.PeakAdvanceHoursForRegular);
        if (req.RetentionYears is not null) doc["retention_years"] = ToElement(req.RetentionYears);
        if (req.NoShowLookbackDays is not null) doc["no_show_lookback_days"] = ToElement(req.NoShowLookbackDays);
    }

    private static string? ValidateMemberCodeSettings(UpdateSettingsRequest req)
    {
        if (req.MemberCodePhase is { } phase && !MemberCodeSettings.IsKnownPhase(phase.Trim()))
            return "member_code_phase_invalid";
        if (OutOfRange(req.MemberCodeCutoffDays, MemberCodeSettings.MinCutoffDays, MemberCodeSettings.MaxCutoffDays))
            return "member_code_cutoff_days_out_of_range";
        return null;
    }

    /// <summary>
    /// The rollout override (member-code §8, §13).
    ///
    /// <list type="bullet">
    /// <item><b>Forward by hand</b> is stamped the way the automatic move would have stamped it —
    /// without a cut-over instant a club set to <c>v1</c> by hand would never reach its cut-off —
    /// and clears any hold: the administrator has said the road is open again.</item>
    /// <item><b>Backward</b> sets the hold (who, when), which the heartbeat's automatic move
    /// respects: before it, a club rolled back because v1 misbehaved was moved forward again by the
    /// very next heartbeat, since every board still spoke <c>codes:m1</c>. Back to <c>v1</c>
    /// restamps the cut-over at now and clears the cut-off, so the fourteen-day clock restarts
    /// rather than firing at once; back to <c>legacy</c> clears both.</item>
    /// <item><c>member_code_manual_hold</c> sets or clears the hold without moving the phase.</item>
    /// </list>
    /// </summary>
    private static void WriteOptionalMemberCodeSettings(
        IDictionary<string, JsonElement> doc, UpdateSettingsRequest req, Guid actor, DateTimeOffset at)
    {
        if (req.MemberCodeCutoffDays is { } days) doc[MemberCodeSettings.CutoffDaysKey] = ToElement(days);
        var now = ToElement(at.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture));

        if (req.MemberCodePhase is { } raw)
        {
            var phase = raw.Trim();
            var before = doc.TryGetValue(MemberCodeSettings.PhaseKey, out var stored) && stored.ValueKind == JsonValueKind.String
                ? stored.GetString()
                : MemberCodeSettings.Legacy;
            var from = MemberCodeSettings.Rank(MemberCodeSettings.IsKnownPhase(before) ? before : MemberCodeSettings.Legacy);
            var to = MemberCodeSettings.Rank(phase);
            doc[MemberCodeSettings.PhaseKey] = ToElement(phase);

            if (to < from)
            {
                SetHold(doc, actor, now);
                doc.Remove(MemberCodeSettings.CutoffAtKey);
                if (phase == MemberCodeSettings.V1) doc[MemberCodeSettings.CutoverAtKey] = now;
                else doc.Remove(MemberCodeSettings.CutoverAtKey);
            }
            else if (to > from)
            {
                ClearHold(doc);
                if (phase != MemberCodeSettings.Legacy && !doc.ContainsKey(MemberCodeSettings.CutoverAtKey)) doc[MemberCodeSettings.CutoverAtKey] = now;
                if (phase == MemberCodeSettings.V1Only && !doc.ContainsKey(MemberCodeSettings.CutoffAtKey)) doc[MemberCodeSettings.CutoffAtKey] = now;
            }
        }

        if (req.MemberCodeManualHold is true) SetHold(doc, actor, now);
        else if (req.MemberCodeManualHold is false) ClearHold(doc);
    }

    /// <summary>
    /// The cut-off by hand ends every legacy code, as the automatic one does (§8 step 4); a
    /// rollback OUT of <c>v1_only</c> gives back the ones it ended that are still in date.
    /// </summary>
    private static async Task ApplyCutoffToLegacyCodesAsync(
        MainframeDbContext db, string? phaseBefore, string? phaseAfter, CancellationToken ct)
    {
        if (phaseAfter is null || phaseAfter == phaseBefore) return;
        if (phaseAfter == MemberCodeSettings.V1Only)
        {
            await MemberCodeRollout.ExpireLegacyCodesAsync(db, DateTimeOffset.UtcNow, ct);
        }
        else if (phaseBefore == MemberCodeSettings.V1Only)
        {
            await MemberCodeRollout.RestoreLegacyCodesAsync(db, DateTimeOffset.UtcNow, ct);
        }
    }

    private static void SetHold(IDictionary<string, JsonElement> doc, Guid actor, JsonElement now)
    {
        doc[MemberCodeSettings.HoldKey] = ToElement(true);
        doc[MemberCodeSettings.HoldByKey] = ToElement(actor.ToString());
        doc[MemberCodeSettings.HoldAtKey] = now;
    }

    private static void ClearHold(IDictionary<string, JsonElement> doc)
    {
        doc.Remove(MemberCodeSettings.HoldKey);
        doc.Remove(MemberCodeSettings.HoldByKey);
        doc.Remove(MemberCodeSettings.HoldAtKey);
    }

    /// <summary>Same omitted-means-unchanged rule as the economics keys, for the six device numbers.</summary>
    private static void WriteOptionalDeviceNumbers(IDictionary<string, JsonElement> doc, UpdateSettingsRequest req)
    {
        if (req.WalkUpMaxMinutes is not null) doc["walk_up_max_minutes"] = ToElement(req.WalkUpMaxMinutes);
        if (req.HeartbeatSeconds is not null) doc["heartbeat_seconds"] = ToElement(req.HeartbeatSeconds);
        if (req.ActivationForwardWindowMinutes is not null) doc["activation_forward_window_minutes"] = ToElement(req.ActivationForwardWindowMinutes);
        if (req.ActivationCueWindowMinutes is not null) doc["activation_cue_window_minutes"] = ToElement(req.ActivationCueWindowMinutes);
        if (req.QrLifetimeSeconds is not null) doc["qr_lifetime_seconds"] = ToElement(req.QrLifetimeSeconds);
        if (req.RosterWindowMinutes is not null) doc["roster_window_minutes"] = ToElement(req.RosterWindowMinutes);
    }

    /// <summary>The settings document as the console reads it — the GET, and the current values a stale save is answered with.</summary>
    private static async Task<object> RenderSettingsAsync(
        MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settingsAccessor, CancellationToken ct)
    {
        var row = await db.TenantSettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == tenant.TenantId, ct);
        var doc = row is null ? new Dictionary<string, JsonElement>() : ParseObject(row.SettingsJson);

        // Defaults come from TenantSettingsAccessor, never from literals here.
        //
        // They used to be written twice and had drifted: this endpoint answered 30
        // minutes and a slice price of 50 where the engine used 15 and 8. On a tenant with
        // no explicit value that is not a cosmetic difference — the admin screen
        // reads back what it was shown and PUTs it, so opening the settings page
        // and pressing save doubled every slice and repriced every court, silently.
        var defaults = await settingsAccessor.GetAsync(ct);

        // The device contract v3 settings (device-api.md §5, §6), clamped, appended as top-level
        // keys like every other setting, and the bounds of every box and device setting — the
        // console takes its ranges from `bounds` and nowhere else (FA-2/BA-05).
        var rendered = JsonSerializer.SerializeToNode(RenderSettingsBody(row, doc, defaults))!.AsObject();
        foreach (var (key, value) in DeviceSettings.Render(defaults)) rendered[key] = JsonSerializer.SerializeToNode(value);
        rendered["bounds"] = JsonSerializer.SerializeToNode(DeviceSettings.Bounds());
        return rendered;
    }

    private static object RenderSettingsBody(
        TenantSettings? row, Dictionary<string, JsonElement> doc, TenantSettingsView defaults)
    {
        return new
        {
            // The document's version (A4-1): send it back with a save, and a save made from a
            // page opened before somebody else's is refused 409 instead of reverting it.
            version = SettingsDocument.VersionOf(row?.SettingsJson),
            slice_minutes = GetInt(doc, "slice_minutes", defaults.SliceMinutes),
            advance_booking_days = GetInt(doc, "advance_booking_days", defaults.AdvanceBookingDays),
            day_start_minute = GetInt(doc, "day_start_minute", defaults.DayStartMinute),
            day_end_minute = GetInt(doc, "day_end_minute", defaults.DayEndMinute),

            // The per-weekday map the engine has read since it existed, and this
            // endpoint never served. A club could not change its opening hours: the
            // screen offered only the flat pair above, the seeder names all seven days,
            // so every save of "Day starts 09:00" reported success and changed nothing
            // any member could see. Rendered from the parsed map, not echoed from the
            // stored document, so the hours shown are the hours BookingService enforces.
            operating_hours = defaults.OperatingHours.ToWire(),
            penalty_pct = GetDecimal(doc, "penalty_pct", defaults.PenaltyPct),
            grace_window_minutes = GetInt(doc, "grace_window_minutes", defaults.GraceWindowMinutes),
            penalty_window_minutes = GetInt(doc, "penalty_window_minutes", defaults.PenaltyWindowMinutes),
            timezone = GetString(doc, "timezone", defaults.Timezone),
            button_map = defaults.Buttons.ToWire(),

            // The nine keys the engine has always read and this endpoint never
            // showed. They govern what a member is charged and when they may book,
            // and until now the only way to change one was to edit a JSON column in
            // the database by hand — on a live money system, with no audit trail and
            // no validation.
            // The slice price, the regular conversion rate, the top-up block and the cap are not
            // served (P13): a booking costs its length in minutes and packages have no cap.
            member_per_day_max_minutes = GetInt(doc, "member_per_day_max_minutes", defaults.MemberPerDayMaxMinutes),
            peak_hours = GetString(doc, "peak_hours", defaults.PeakHoursRange),
            peak_advance_hours_for_regular = GetInt(doc, "peak_advance_hours_for_regular", defaults.PeakAdvanceHoursForRegular),
            retention_years = GetInt(doc, "retention_years", defaults.RetentionYears),
            no_show_lookback_days = GetInt(doc, "no_show_lookback_days", defaults.NoShowLookbackDays),

            // The court-box and identification numbers (WI-2). Same rule as the
            // economics keys: defaults come from TenantSettingsAccessor, never
            // from literals here.
            walk_up_max_minutes = GetInt(doc, "walk_up_max_minutes", defaults.WalkUpMaxMinutes),
            heartbeat_seconds = GetInt(doc, "heartbeat_seconds", defaults.HeartbeatSeconds),
            activation_forward_window_minutes = GetInt(doc, "activation_forward_window_minutes", defaults.ActivationForwardWindowMinutes),
            activation_cue_window_minutes = GetInt(doc, "activation_cue_window_minutes", defaults.ActivationCueWindowMinutes),
            qr_lifetime_seconds = GetInt(doc, "qr_lifetime_seconds", defaults.QrLifetimeSeconds),
            roster_window_minutes = GetInt(doc, "roster_window_minutes", defaults.RosterWindowMinutes),

            // The three door-gate numbers. The policy is rendered from the PARSED value
            // rather than echoed from the stored document, for the same reason
            // operating_hours is: a settings screen reads a value, shows it to a person
            // and PUTs back whatever it was shown, so showing a stored value the engine
            // does not honour would let the page report a policy that is not in force.
            gate_unlock_seconds = GetInt(doc, "gate_unlock_seconds", defaults.GateUnlockSeconds),
            gate_access_policy = defaults.GateAccessPolicy,
            gate_early_entry_minutes = GetInt(doc, "gate_early_entry_minutes", defaults.GateEarlyEntryMinutes),

            // Always present, never conditional: the console's settings type requires it
            // and carries no client-side default, so an omitted key would be a page that
            // cannot render rather than a page that falls back.
            device_alert_cooldown_minutes = GetInt(
                doc, "device_alert_cooldown_minutes", defaults.DeviceAlertCooldownMinutes),

            // The five Wave 1 door settings, always present for the same reason the
            // cooldown above is: the console's settings type carries no client-side
            // default, so an omitted key is a page that cannot render rather than one that
            // falls back.
            //
            // Rendered from the CLAMPED values, not echoed from the stored document, on
            // the same argument operating_hours and gate_access_policy already make here:
            // a settings screen reads a value, shows it to a person and PUTs back whatever
            // it was shown, so showing a number the engine does not honour would let the
            // page report a retention the worker is not deleting against.
            door_log_retention_days = DoorSettings.LogRetentionDays(defaults),
            door_refusal_spike_count = DoorSettings.RefusalSpikeCount(defaults),
            door_refusal_spike_minutes = DoorSettings.RefusalSpikeMinutes(defaults),
            club_contact_phone = DoorSettings.ContactPhone(defaults) ?? "",
            club_contact_email = DoorSettings.ContactEmail(defaults) ?? "",

            // The box's nine, the error log's three and the streams' seven — rendered from
            // the CLAMPED values for the reason operating_hours, gate_access_policy and the
            // door numbers already are: a settings screen reads a value, shows it to a
            // person and PUTs back whatever it was shown, so showing a number the engine
            // does not honour would let the page report a timeout the box is not running
            // and a retention the worker is not deleting against.
            lcd_revert_seconds = BoxSettings.LcdRevertSeconds(defaults),
            lcd_choice_seconds = BoxSettings.LcdChoiceSeconds(defaults),
            lcd_card_seconds = BoxSettings.LcdCardSeconds(defaults),
            lcd_hint_seconds = BoxSettings.LcdHintSeconds(defaults),
            scan_memory_seconds = BoxSettings.ScanMemorySeconds(defaults),
            clock_trust_minutes = BoxSettings.ClockTrustMinutes(defaults),
            relay_restore_enabled = BoxSettings.RelayRestoreEnabled(defaults),
            device_fault_reporting = BoxSettings.DeviceFaultReporting(defaults),
            device_fault_max_per_hour = BoxSettings.DeviceFaultMaxPerHour(defaults),

            device_error_retention_days = MonitoringSettings.RetentionDays(defaults),
            device_error_max_open_rows = MonitoringSettings.MaxOpenRows(defaults),
            device_error_ingest_per_minute = MonitoringSettings.IngestPerMinute(defaults),

            // The admin notifier's six (R23), from the clamped readers for the same reason.
            fault_spike_count = AdminNotificationSettings.FaultSpikeCount(defaults),
            fault_spike_minutes = AdminNotificationSettings.FaultSpikeMinutes(defaults),
            application_reminder_hours = AdminNotificationSettings.ApplicationReminderHours(defaults),
            admin_notification_retention_days = AdminNotificationSettings.RetentionDays(defaults),
            topup_failure_cooldown_minutes = AdminNotificationSettings.TopUpFailureCooldownMinutes(defaults),
            overdraft_cooldown_minutes = AdminNotificationSettings.OverdraftCooldownMinutes(defaults),

            // Players and splits (D11–D13), from the clamped readers for the same reason.
            share_lapse_hours = PlayerSettings.ShareLapseHours(defaults),
            share_reminder_hours = PlayerSettings.ShareReminderHours(defaults),
            share_reminder_max = PlayerSettings.ShareReminderMax(defaults),
            player_nudge_limit = PlayerSettings.NudgeLimit(defaults),
            directory_searches_per_minute = PlayerSettings.DirectorySearchesPerMinute(defaults),
            member_quiet_start_minute = PlayerSettings.QuietStartMinute(defaults),
            member_quiet_end_minute = PlayerSettings.QuietEndMinute(defaults),
            recent_partner_days = PlayerSettings.RecentPartnerDays(defaults),
            member_notification_retention_days = PlayerSettings.NotificationRetentionDays(defaults),
            player_invites_per_booking = PlayerSettings.InvitesPerBooking(defaults),

            // Play (D14), from the clamped readers for the same reason.
            result_autoconfirm_hours = PlaySettings.AutoConfirmHours(defaults),
            result_record_days = PlaySettings.RecordDays(defaults),
            streak_rest_every_weeks = PlaySettings.RestEveryWeeks(defaults),
            streak_rest_cap = PlaySettings.RestCap(defaults),
            streak_pause_weeks_per_year = PlaySettings.PauseWeeksPerYear(defaults),
            play_early_bird_before_minute = PlaySettings.EarlyBirdBeforeMinute(defaults),
            play_night_owl_from_minute = PlaySettings.NightOwlFromMinute(defaults),

            sse_keepalive_seconds = (int)RealtimeSettings.KeepAlive(defaults).TotalSeconds,
            control_board_resync_seconds = RealtimeSettings.ResyncSeconds(defaults),
            control_board_stale_multiplier = RealtimeSettings.StaleMultiplier(defaults),
            realtime_fallback_after_failures = RealtimeSettings.FallbackAfterFailures(defaults),
            realtime_fallback_window_seconds = RealtimeSettings.FallbackWindowSeconds(defaults),
            realtime_poll_seconds_wallet = RealtimeSettings.PollSecondsWallet(defaults),
            realtime_poll_seconds_control_board = RealtimeSettings.PollSecondsControlBoard(defaults),

            // The four BE-ADMIN keys, rendered from the CLAMPED readers rather than
            // echoed out of the stored document — otherwise the settings page round-trips
            // a number the engine does not honour, which is the defect
            // AdminSettingsHttpTests.Opening_the_settings_page_and_saving_it_changes_nothing
            // is named for.
            admin_bulk_max_items = BulkSettings.MaxItems(defaults),
            schedule_materialisation_days = ScheduleSettings.MaterialisationDays(defaults),
            schedule_max_rows_per_change = ScheduleSettings.MaxRowsPerChange(defaults),
            schedule_worker_interval_seconds = (int)ScheduleSettings.WorkerInterval(defaults).TotalSeconds,

            // The two night-trace keys, from TraceSettings for the same reason.
            member_trace_enabled = TraceSettings.Enabled(defaults),
            member_trace_max_events = TraceSettings.MaxEvents(defaults),

            // GOAL items 3 and 19. Rendered from the CLAMPED values for the same reason
            // operating_hours, gate_access_policy and the door numbers are: the settings
            // screen reads a value, shows it to a person and PUTs back whatever it was
            // shown, so a number the engine does not honour would let the page report a cap
            // that is not being enforced.
            member_max_slots_per_day = BookingLimits.MaxSlotsPerDay(defaults),
            same_day_cap_relaxation = defaults.SameDayCapRelaxation,
            same_day_relaxation_window_minutes = BookingLimits.SameDayRelaxationWindowMinutes(defaults),
            walk_up_honours_day_cap = defaults.WalkUpHonoursDayCap,
            member_groups_enabled = defaults.MemberGroupsEnabled,

            // The club's money symbol. Rendered from the RESOLVED value, like
            // operating_hours and gate_access_policy: a settings page that showed a symbol
            // the product will not print would report a choice that is not in force.
            currency_symbol = CurrencySymbol.For(defaults),

            // The member-code rollout (§8). The two instants are server-written and read-only.
            member_code_phase = MemberCodeSettings.Phase(defaults),
            member_code_cutover_at = defaults.MemberCodeCutoverAt,
            member_code_cutoff_at = defaults.MemberCodeCutoffAt,
            member_code_cutoff_days = MemberCodeSettings.CutoffDays(defaults),
            member_code_manual_hold = defaults.MemberCodeManualHold,
            member_code_manual_hold_by = defaults.MemberCodeManualHoldBy,
            member_code_manual_hold_at = defaults.MemberCodeManualHoldAt,
        };
    }

    private static Dictionary<string, JsonElement> ParseObject(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new();
        using var doc = JsonDocument.Parse(json);
        var dict = new Dictionary<string, JsonElement>();
        foreach (var p in doc.RootElement.EnumerateObject()) dict[p.Name] = p.Value.Clone();
        return dict;
    }
    private static JsonElement ToElement<T>(T value) => JsonSerializer.SerializeToElement(value);

    /// <summary>
    /// FC-8: every <c>minutes:N</c> button above <paramref name="cap"/> lowered to it, in the club's
    /// map (in <paramref name="doc"/>) and in every court box's own override, in the same save.
    /// </summary>
    private static async Task CapButtonsAsync(MainframeDbContext db, Dictionary<string, JsonElement> doc, int cap, CancellationToken ct)
    {
        var root = JsonSerializer.SerializeToElement(doc);
        var club = ButtonMap.FromSettings(root);
        var capped = club.CappedAt(cap);
        if (!ReferenceEquals(capped, club)) doc["button_map"] = ToElement(capped.ToWire());

        var boxes = await db.Devices.Where(d => d.Kind == DeviceKind.CourtBox && d.ButtonMapJson != null).ToListAsync(ct);
        foreach (var box in boxes)
        {
            if (ButtonMap.FromJson(box.ButtonMapJson) is not { } own) continue;
            var lowered = own.CappedAt(cap);
            if (!ReferenceEquals(lowered, own)) box.ButtonMapJson = lowered.ToJson();
        }
    }
    /// <summary>
    /// An integer out of the stored document, or the default.
    ///
    /// <para>
    /// <b><c>TryGetInt32</c>, not <c>GetInt32</c> — the same defect as
    /// <see cref="TenantSettingsAccessor"/>'s, in the second of the two places that read this
    /// column.</b> The kind check only proves the value is a NUMBER; <c>GetInt32</c> then
    /// throws <c>FormatException</c> on <c>15.5</c> and <c>OverflowException</c> past
    /// <c>int.MaxValue</c>. A hand-edited or restored-from-backup document therefore made the
    /// SETTINGS PAGE ITSELF answer 500 — which is the one screen an admin would go to in order
    /// to fix it. Falling back leaves the page usable and the wrong value visible.
    /// </para>
    /// </summary>
    private static int GetInt(IReadOnlyDictionary<string, JsonElement> d, string k, int fallback)
    {
        if (!d.TryGetValue(k, out var v) || v.ValueKind != JsonValueKind.Number) return fallback;
        return v.TryGetInt32(out var parsed) ? parsed : fallback;
    }

    /// <summary>A decimal out of the stored document, or the default. <c>TryGetDecimal</c> for the reason <see cref="GetInt"/> gives.</summary>
    private static decimal GetDecimal(IReadOnlyDictionary<string, JsonElement> d, string k, decimal fallback)
    {
        if (!d.TryGetValue(k, out var v) || v.ValueKind != JsonValueKind.Number) return fallback;
        return v.TryGetDecimal(out var parsed) ? parsed : fallback;
    }
    private static string GetString(IReadOnlyDictionary<string, JsonElement> d, string k, string fallback)
        => d.TryGetValue(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? fallback : fallback;
}

public sealed record UpdateSettingsRequest(
    // The eight booking keys, optional since review round 4 (A4-1) like every key below them:
    // omitted means unchanged. They were required, so the console had to send the whole page,
    // and a page opened before a colleague's save put the colleague's old values back.
    int? SliceMinutes = null,
    /// <summary>RETIRED (P13): bound and ignored whatever it holds — see <see cref="CreditsPerZarRegular"/>.</summary>
    JsonElement SlicePriceCredits = default,
    int? AdvanceBookingDays = null,
    int? DayStartMinute = null,
    int? DayEndMinute = null,
    decimal? PenaltyPct = null,
    int? GraceWindowMinutes = null,
    int? PenaltyWindowMinutes = null,
    IReadOnlyList<string>? ButtonMap = null,

    /// <summary>
    /// The tenant's IANA zone. Optional on the same omitted-means-unchanged terms as the
    /// keys below; it drives the whole booking grid (<c>ScheduleDay.timezone</c>) and was
    /// served by GET while this record had no member for it, so it could not be set.
    /// </summary>
    string? Timezone = null,

    /// <summary>
    /// The per-weekday opening hours, <c>{"mon":"06:00-22:00", …}</c>. Optional on the same
    /// omitted-means-unchanged terms as everything below; an empty map clears it, so every
    /// weekday falls back to <see cref="DayStartMinute"/>/<see cref="DayEndMinute"/>.
    /// </summary>
    IReadOnlyDictionary<string, string>? OperatingHours = null,

    // The nine economics keys. All nullable, all optional: omitted means unchanged, so a
    // screen that edits only booking settings cannot revert an economics change made from
    // another one.
    /// <summary>
    /// RETIRED (P13, minutes as the unit of account), with <see cref="SlicePriceCredits"/>,
    /// <see cref="CreditsPerZarLeague"/>, <see cref="TopupBlockZar"/> and
    /// <see cref="TopupMaxZarPerMember"/>. Still bound, and ignored whatever they hold, so an
    /// older PWA that sends the whole page back saves it instead of being refused for settings
    /// that no longer exist (<c>memory/decisions-backend-hygiene.md</c>). Delete the bindings
    /// once no supported PWA build can send them.
    /// </summary>
    JsonElement CreditsPerZarRegular = default,
    JsonElement CreditsPerZarLeague = default,
    JsonElement TopupBlockZar = default,
    JsonElement TopupMaxZarPerMember = default,
    int? MemberPerDayMaxMinutes = null,
    string? PeakHours = null,
    int? PeakAdvanceHoursForRegular = null,
    int? RetentionYears = null,
    int? NoShowLookbackDays = null,

    // The six court-box / identification keys (WI-2). Optional on the same
    // omitted-means-unchanged terms as the economics keys.
    int? WalkUpMaxMinutes = null,
    int? HeartbeatSeconds = null,
    int? ActivationForwardWindowMinutes = null,
    int? ActivationCueWindowMinutes = null,
    int? QrLifetimeSeconds = null,
    int? RosterWindowMinutes = null,

    // The three door-gate keys, on the same omitted-means-unchanged terms. The policy is the
    // one string enum on this endpoint; it is validated against the closed set and refused
    // rather than coerced, because the read side treats an unrecognised stored value as
    // corruption and narrows the door in response.
    int? GateUnlockSeconds = null,
    string? GateAccessPolicy = null,
    int? GateEarlyEntryMinutes = null,

    /// <summary>
    /// How long the peripheral sweep waits before mailing about the same board again. Not a
    /// door number — it governs court boxes too — but it binds under both spellings like the
    /// three above, because it is edited on the same screen and the cost of a client picking
    /// the wrong spelling is the same silent no-op.
    /// </summary>
    int? DeviceAlertCooldownMinutes = null,

    // ---- and the same three under their snake_case names ----
    //
    // This endpoint is asymmetric and always has been: the GET answers snake_case and the
    // PUT binds camelCase, because the application configures no naming policy and the
    // browser client absorbs the difference in its own save mapper. That asymmetry is
    // survivable only while both sides agree on which way round it goes, and the cost of
    // disagreeing is not an error — it is `null`, which this endpoint reads as
    // "omitted, leave unchanged". A client that sent the wrong spelling would get
    // `{"saved": true}` and no change, which is the silent-write failure
    // `Opening_the_settings_page_and_saving_it_changes_nothing` exists to prevent.
    //
    // For a door that is worth removing rather than documenting, so both spellings bind and
    // the reader below takes whichever arrived. The precedent is `HeartbeatRequest`'s
    // running_version/firmware_version pair, and the reasoning is the same one: taking both
    // means a client on either convention is heard, rather than silently ignored.
    [property: JsonPropertyName("gate_unlock_seconds")] int? GateUnlockSecondsSnake = null,
    [property: JsonPropertyName("gate_access_policy")] string? GateAccessPolicySnake = null,
    [property: JsonPropertyName("gate_early_entry_minutes")] int? GateEarlyEntryMinutesSnake = null,
    [property: JsonPropertyName("device_alert_cooldown_minutes")] int? DeviceAlertCooldownMinutesSnake = null,

    // ---- The five Wave 1 door settings, under both spellings ----
    //
    // Same asymmetry, same cost, same remedy as the four above. These five are read by the
    // club log, by the tile's signals, by the member's page and by the retention worker, and
    // the one a silent no-op would hurt most is door_log_retention_days: an admin who narrows
    // it from 90 days to 30 and is answered {"saved": true} believes the club has stopped
    // holding a record it is still holding.
    int? DoorLogRetentionDays = null,
    int? DoorRefusalSpikeCount = null,
    int? DoorRefusalSpikeMinutes = null,
    string? ClubContactPhone = null,
    string? ClubContactEmail = null,
    [property: JsonPropertyName("door_log_retention_days")] int? DoorLogRetentionDaysSnake = null,
    [property: JsonPropertyName("door_refusal_spike_count")] int? DoorRefusalSpikeCountSnake = null,
    [property: JsonPropertyName("door_refusal_spike_minutes")] int? DoorRefusalSpikeMinutesSnake = null,
    [property: JsonPropertyName("club_contact_phone")] string? ClubContactPhoneSnake = null,
    [property: JsonPropertyName("club_contact_email")] string? ClubContactEmailSnake = null,

    // ---- The box's screen, the error log, and the control board's own stream numbers ----
    //
    // Snake-case only. The two-spelling burden above exists because those keys shipped
    // camelCase first and a club's console was already sending them; nothing has ever sent
    // these, so binding one spelling is the whole cost of never having to read the other.
    // The four keys a MEMBER's stream also uses are further down, under both spellings,
    // because the member console was already sending them camelCase.
    [property: JsonPropertyName("lcd_revert_seconds")] int? LcdRevertSeconds = null,
    [property: JsonPropertyName("lcd_choice_seconds")] int? LcdChoiceSeconds = null,
    [property: JsonPropertyName("lcd_card_seconds")] int? LcdCardSeconds = null,
    [property: JsonPropertyName("lcd_hint_seconds")] int? LcdHintSeconds = null,
    [property: JsonPropertyName("scan_memory_seconds")] int? ScanMemorySeconds = null,
    [property: JsonPropertyName("clock_trust_minutes")] int? ClockTrustMinutes = null,
    [property: JsonPropertyName("relay_restore_enabled")] bool? RelayRestoreEnabled = null,
    [property: JsonPropertyName("device_fault_reporting")] bool? DeviceFaultReporting = null,
    [property: JsonPropertyName("device_fault_max_per_hour")] int? DeviceFaultMaxPerHour = null,

    [property: JsonPropertyName("device_error_retention_days")] int? DeviceErrorRetentionDays = null,
    [property: JsonPropertyName("device_error_max_open_rows")] int? DeviceErrorMaxOpenRows = null,
    [property: JsonPropertyName("device_error_ingest_per_minute")] int? DeviceErrorIngestPerMinute = null,

    // The admin notifier's six (R23). Snake-case only, for the reason the block above gives:
    // nothing has ever sent them under another spelling.
    [property: JsonPropertyName("fault_spike_count")] int? FaultSpikeCount = null,
    [property: JsonPropertyName("fault_spike_minutes")] int? FaultSpikeMinutes = null,
    [property: JsonPropertyName("application_reminder_hours")] int? ApplicationReminderHours = null,
    [property: JsonPropertyName("admin_notification_retention_days")] int? AdminNotificationRetentionDays = null,
    [property: JsonPropertyName("topup_failure_cooldown_minutes")] int? TopUpFailureCooldownMinutes = null,
    [property: JsonPropertyName("overdraft_cooldown_minutes")] int? OverdraftCooldownMinutes = null,

    // Players and splits (D11–D13). Snake-case only, for the reason the blocks above give.
    [property: JsonPropertyName("share_lapse_hours")] int? ShareLapseHours = null,
    [property: JsonPropertyName("share_reminder_hours")] int? ShareReminderHours = null,
    [property: JsonPropertyName("share_reminder_max")] int? ShareReminderMax = null,
    [property: JsonPropertyName("player_nudge_limit")] int? PlayerNudgeLimit = null,
    [property: JsonPropertyName("directory_searches_per_minute")] int? DirectorySearchesPerMinute = null,
    [property: JsonPropertyName("member_quiet_start_minute")] int? MemberQuietStartMinute = null,
    [property: JsonPropertyName("member_quiet_end_minute")] int? MemberQuietEndMinute = null,
    [property: JsonPropertyName("recent_partner_days")] int? RecentPartnerDays = null,
    [property: JsonPropertyName("member_notification_retention_days")] int? MemberNotificationRetentionDays = null,
    [property: JsonPropertyName("player_invites_per_booking")] int? PlayerInvitesPerBooking = null,

    // Play (D14). Snake-case only, for the reason the blocks above give.
    [property: JsonPropertyName("result_autoconfirm_hours")] int? ResultAutoConfirmHours = null,
    [property: JsonPropertyName("result_record_days")] int? ResultRecordDays = null,
    [property: JsonPropertyName("streak_rest_every_weeks")] int? StreakRestEveryWeeks = null,
    [property: JsonPropertyName("streak_rest_cap")] int? StreakRestCap = null,
    [property: JsonPropertyName("streak_pause_weeks_per_year")] int? StreakPauseWeeksPerYear = null,
    [property: JsonPropertyName("play_early_bird_before_minute")] int? PlayEarlyBirdBeforeMinute = null,
    [property: JsonPropertyName("play_night_owl_from_minute")] int? PlayNightOwlFromMinute = null,

    [property: JsonPropertyName("control_board_resync_seconds")] int? ControlBoardResyncSeconds = null,
    [property: JsonPropertyName("control_board_stale_multiplier")] int? ControlBoardStaleMultiplier = null,
    [property: JsonPropertyName("realtime_poll_seconds_control_board")] int? RealtimePollSecondsControlBoard = null,

    // ---- The four BE-ADMIN keys, under both spellings ----
    //
    // Same asymmetry and same remedy as the nine above. The one a silent no-op would hurt
    // most here is schedule_materialisation_days: a horizon narrowed below
    // advance_booking_days lets a member book into a league night that has not been written
    // yet, and nobody finds out until the night itself.
    int? AdminBulkMaxItems = null,
    int? ScheduleMaterialisationDays = null,
    int? ScheduleMaxRowsPerChange = null,
    int? ScheduleWorkerIntervalSeconds = null,
    [property: JsonPropertyName("admin_bulk_max_items")] int? AdminBulkMaxItemsSnake = null,
    [property: JsonPropertyName("schedule_materialisation_days")] int? ScheduleMaterialisationDaysSnake = null,
    [property: JsonPropertyName("schedule_max_rows_per_change")] int? ScheduleMaxRowsPerChangeSnake = null,
    [property: JsonPropertyName("schedule_worker_interval_seconds")] int? ScheduleWorkerIntervalSecondsSnake = null,

    // ---- The two night-trace keys ----
    //
    // The first is a KILL SWITCH on the most surveillance-capable surface in the product, so
    // it is editable from the settings screen like every other club decision rather than
    // being a deployment flag nobody at the club can reach.
    bool? MemberTraceEnabled = null,
    int? MemberTraceMaxEvents = null,
    [property: JsonPropertyName("member_trace_enabled")] bool? MemberTraceEnabledSnake = null,
    [property: JsonPropertyName("member_trace_max_events")] int? MemberTraceMaxEventsSnake = null,

    // ---- GOAL items 3, 19, 8 and 12, under both spellings ----
    //
    // Same asymmetry, same cost, same remedy as the door keys above: the GET answers snake_case
    // and the PUT binds camelCase, and a client on the wrong side of that gets {"saved":true}
    // and no change. The one a silent no-op would hurt most here is member_max_slots_per_day —
    // an admin who lowers it and is told it saved believes the club is enforcing a cap it is
    // not.
    int? MemberMaxSlotsPerDay = null,
    bool? SameDayCapRelaxation = null,
    int? SameDayRelaxationWindowMinutes = null,
    bool? WalkUpHonoursDayCap = null,
    bool? MemberGroupsEnabled = null,
    int? SseKeepaliveSeconds = null,
    int? RealtimeFallbackAfterFailures = null,
    int? RealtimeFallbackWindowSeconds = null,
    int? RealtimePollSecondsWallet = null,
    [property: JsonPropertyName("member_max_slots_per_day")] int? MemberMaxSlotsPerDaySnake = null,
    [property: JsonPropertyName("same_day_cap_relaxation")] bool? SameDayCapRelaxationSnake = null,
    [property: JsonPropertyName("same_day_relaxation_window_minutes")] int? SameDayRelaxationWindowMinutesSnake = null,
    [property: JsonPropertyName("walk_up_honours_day_cap")] bool? WalkUpHonoursDayCapSnake = null,
    [property: JsonPropertyName("member_groups_enabled")] bool? MemberGroupsEnabledSnake = null,
    [property: JsonPropertyName("sse_keepalive_seconds")] int? SseKeepaliveSecondsSnake = null,
    [property: JsonPropertyName("realtime_fallback_after_failures")] int? RealtimeFallbackAfterFailuresSnake = null,
    [property: JsonPropertyName("realtime_fallback_window_seconds")] int? RealtimeFallbackWindowSecondsSnake = null,
    [property: JsonPropertyName("realtime_poll_seconds_wallet")] int? RealtimePollSecondsWalletSnake = null,
    /// <summary>
    /// RETIRED (P10) — the thumbs/marks glyph choice the PWA no longer draws. Still bound, and
    /// ignored whatever it holds, so an older PWA that sends it back with the rest of the page
    /// saves the page instead of being refused for a setting that no longer exists.
    /// </summary>
    string? ActionGlyphs = null,
    [property: JsonPropertyName("action_glyphs")] string? ActionGlyphsSnake = null,
    string? CurrencySymbol = null,
    [property: JsonPropertyName("currency_symbol")] string? CurrencySymbolSnake = null,
    /// <summary>
    /// The member-code rollout phase (member-code §8) — how an administrator rolls a club BACK,
    /// or forward early. The server moves it forward on its own; this is the override.
    /// </summary>
    [property: JsonPropertyName("member_code_phase")] string? MemberCodePhase = null,
    /// <summary>Days from the cut-over to the cut-off, 14 to 365.</summary>
    [property: JsonPropertyName("member_code_cutoff_days")] int? MemberCodeCutoffDays = null,
    /// <summary>
    /// Sets (true) or clears (false) the administrator's hold on the automatic rollout without
    /// moving the phase. A backward phase move sets it on its own; a forward one clears it.
    /// </summary>
    [property: JsonPropertyName("member_code_manual_hold")] bool? MemberCodeManualHold = null,

    /// <summary>
    /// The <c>version</c> the GET answered, sent back with a save (A4-1). When it no longer
    /// names the stored document the save is refused <c>409 settings_changed</c> with the
    /// current values, and nothing is written. Absent means "no check" — an older console
    /// still saves, now with only the keys it sends.
    /// </summary>
    string? Version = null)
{
    /// <summary>
    /// Every key this record has no member for — which is where the device contract v3 settings
    /// (device-api.md §5, §6) are read from, under either spelling, by <see cref="DeviceSettings.Parse"/>.
    /// Fourteen keys × two spellings as positional members would double the surface of a record
    /// that is already the endpoint's longest; one table-driven reader keeps the bounds, the
    /// validation and the GET's <c>bounds</c> in one place.
    /// </summary>
    [System.Text.Json.Serialization.JsonExtensionData]
    public Dictionary<string, JsonElement>? Extra { get; init; }

    /// <summary>The money symbol the club asked for, under either spelling.</summary>
    public string? EffectiveCurrencySymbol => CurrencySymbol ?? CurrencySymbolSnake;

    /// <summary>The slot cap the club asked for, under either spelling.</summary>
    public int? EffectiveMemberMaxSlotsPerDay => MemberMaxSlotsPerDay ?? MemberMaxSlotsPerDaySnake;

    /// <summary>Whether the club wants blueprint B.3's same-day relaxation, under either spelling.</summary>
    public bool? EffectiveSameDayCapRelaxation => SameDayCapRelaxation ?? SameDayCapRelaxationSnake;

    /// <summary>How close to start the relaxation reaches, under either spelling.</summary>
    public int? EffectiveSameDayRelaxationWindowMinutes
        => SameDayRelaxationWindowMinutes ?? SameDayRelaxationWindowMinutesSnake;

    /// <summary>Whether a walk-up is refused by the day cap, under either spelling.</summary>
    public bool? EffectiveWalkUpHonoursDayCap => WalkUpHonoursDayCap ?? WalkUpHonoursDayCapSnake;

    /// <summary>Whether member groups are consulted at all, under either spelling.</summary>
    public bool? EffectiveMemberGroupsEnabled => MemberGroupsEnabled ?? MemberGroupsEnabledSnake;

    /// <summary>The stream keep-alive the club asked for, under either spelling.</summary>
    public int? EffectiveSseKeepaliveSeconds => SseKeepaliveSeconds ?? SseKeepaliveSecondsSnake;

    /// <summary>The stream-failure tolerance the club asked for, under either spelling.</summary>
    public int? EffectiveRealtimeFallbackAfterFailures
        => RealtimeFallbackAfterFailures ?? RealtimeFallbackAfterFailuresSnake;

    /// <summary>How long a degraded client stays degraded, under either spelling.</summary>
    public int? EffectiveRealtimeFallbackWindowSeconds
        => RealtimeFallbackWindowSeconds ?? RealtimeFallbackWindowSecondsSnake;

    /// <summary>The wallet poll cadence the club asked for, under either spelling.</summary>
    public int? EffectiveRealtimePollSecondsWallet => RealtimePollSecondsWallet ?? RealtimePollSecondsWalletSnake;

    /// <summary>Whether the club wants the night trace on, under either spelling.</summary>
    public bool? EffectiveMemberTraceEnabled => MemberTraceEnabled ?? MemberTraceEnabledSnake;

    /// <summary>The trace's page ceiling as asked for, under either spelling.</summary>
    public int? EffectiveMemberTraceMaxEvents => MemberTraceMaxEvents ?? MemberTraceMaxEventsSnake;

    /// <summary>The bulk ceiling the club asked for, under either spelling.</summary>
    public int? EffectiveAdminBulkMaxItems => AdminBulkMaxItems ?? AdminBulkMaxItemsSnake;

    /// <summary>The materialisation horizon the club asked for, under either spelling.</summary>
    public int? EffectiveScheduleMaterialisationDays
        => ScheduleMaterialisationDays ?? ScheduleMaterialisationDaysSnake;

    /// <summary>The per-change row cap the club asked for, under either spelling.</summary>
    public int? EffectiveScheduleMaxRowsPerChange => ScheduleMaxRowsPerChange ?? ScheduleMaxRowsPerChangeSnake;

    /// <summary>The worker tick the club asked for, under either spelling.</summary>
    public int? EffectiveScheduleWorkerIntervalSeconds
        => ScheduleWorkerIntervalSeconds ?? ScheduleWorkerIntervalSecondsSnake;

    /// <summary>The release the club asked for, under either spelling, or null when neither arrived.</summary>
    public int? EffectiveGateUnlockSeconds => GateUnlockSeconds ?? GateUnlockSecondsSnake;

    /// <summary>The policy the club asked for, under either spelling.</summary>
    public string? EffectiveGateAccessPolicy => GateAccessPolicy ?? GateAccessPolicySnake;

    /// <summary>The entry window the club asked for, under either spelling.</summary>
    public int? EffectiveGateEarlyEntryMinutes => GateEarlyEntryMinutes ?? GateEarlyEntryMinutesSnake;

    /// <summary>The alert cooldown the club asked for, under either spelling.</summary>
    public int? EffectiveDeviceAlertCooldownMinutes => DeviceAlertCooldownMinutes ?? DeviceAlertCooldownMinutesSnake;

    /// <summary>The door-log retention the club asked for, under either spelling.</summary>
    public int? EffectiveDoorLogRetentionDays => DoorLogRetentionDays ?? DoorLogRetentionDaysSnake;

    /// <summary>The refusal-spike threshold the club asked for, under either spelling.</summary>
    public int? EffectiveDoorRefusalSpikeCount => DoorRefusalSpikeCount ?? DoorRefusalSpikeCountSnake;

    /// <summary>The refusal-spike window the club asked for, under either spelling.</summary>
    public int? EffectiveDoorRefusalSpikeMinutes => DoorRefusalSpikeMinutes ?? DoorRefusalSpikeMinutesSnake;

    /// <summary>The club's contact phone as asked for, under either spelling. An empty string clears it.</summary>
    public string? EffectiveClubContactPhone => ClubContactPhone ?? ClubContactPhoneSnake;

    /// <summary>The club's contact email as asked for, under either spelling. An empty string clears it.</summary>
    public string? EffectiveClubContactEmail => ClubContactEmail ?? ClubContactEmailSnake;
}

/// <summary>A new court. No price (P13): a booking costs its length in minutes.</summary>
public sealed record CreateCourtRequest(string Name, string CourtType);
public sealed record UpdateCourtRequest(string? Name, bool? IsActive);
