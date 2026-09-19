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
        {
            var row = await db.TenantSettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == tenant.TenantId, ct);
            var doc = row is null ? new Dictionary<string, JsonElement>() : ParseObject(row.SettingsJson);

            // Defaults come from TenantSettingsAccessor, never from literals here.
            //
            // They used to be written twice and had drifted: this endpoint answered 30
            // minutes and 50 credits where the engine used 15 and 8. On a tenant with
            // no explicit value that is not a cosmetic difference — the admin screen
            // reads back what it was shown and PUTs it, so opening the settings page
            // and pressing save doubled every slice and repriced every court, silently.
            var defaults = await settingsAccessor.GetAsync(ct);

            return Results.Ok(new
            {
                slice_minutes = GetInt(doc, "slice_minutes", defaults.SliceMinutes),
                slice_price_credits = GetDecimal(doc, "slice_price_credits", defaults.DefaultSlicePriceCredits),   // the default for a NEW court; existing courts carry their own
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
                credits_per_zar_regular = GetDecimal(doc, "credits_per_zar_regular", defaults.CreditsPerZarRegular),
                credits_per_zar_league = GetDecimal(doc, "credits_per_zar_league", defaults.CreditsPerZarLeague),
                topup_block_zar = GetDecimal(doc, "topup_block_zar", defaults.TopupBlockZar),
                topup_max_zar_per_member = GetDecimal(doc, "topup_max_zar_per_member", defaults.TopupMaxZarPerMember),
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
            });
        });

        settings.MapPut("/", async (
            UpdateSettingsRequest req, MainframeDbContext db, ITenantContext tenant, CancellationToken ct) =>
        {
            if (req.AdvanceBookingDays < 0 || req.AdvanceBookingDays > 365)
                return Results.BadRequest(new { error = "advance_booking_days_out_of_range" });
            if (req.SliceMinutes is < 5 or > 240)
                return Results.BadRequest(new { error = "slice_minutes_out_of_range" });
            if (req.DayStartMinute < 0 || req.DayEndMinute > 24 * 60 || req.DayStartMinute >= req.DayEndMinute)
                return Results.BadRequest(new { error = "operating_hours_invalid" });

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
            if (req.PenaltyPct is < 0 or > 100)
                return Results.BadRequest(new { error = "penalty_pct_out_of_range" });

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
            if (req.GraceWindowMinutes is < 0 or > 60)
                return Results.BadRequest(new { error = "grace_window_minutes_out_of_range" });
            if (req.PenaltyWindowMinutes is < 0 or > 1440)
                return Results.BadRequest(new { error = "penalty_window_minutes_out_of_range" });

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

            var deviceError = ValidateDeviceNumbers(req);
            if (deviceError is not null) return Results.BadRequest(new { error = deviceError });

            var gateError = ValidateGateSettings(req);
            if (gateError is not null) return Results.BadRequest(new { error = gateError });

            var row = await db.TenantSettings.FirstOrDefaultAsync(s => s.TenantId == tenant.TenantId, ct);
            if (row is null)
            {
                row = new TenantSettings { TenantId = tenant.TenantId, SettingsJson = "{}" };
                db.TenantSettings.Add(row);
            }
            var doc = ParseObject(row.SettingsJson);

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

            doc["slice_minutes"] = ToElement(req.SliceMinutes);
            doc["slice_price_credits"] = ToElement(req.SlicePriceCredits);
            doc["advance_booking_days"] = ToElement(req.AdvanceBookingDays);
            doc["day_start_minute"] = ToElement(req.DayStartMinute);
            doc["day_end_minute"] = ToElement(req.DayEndMinute);
            doc["penalty_pct"] = ToElement(req.PenaltyPct);
            doc["grace_window_minutes"] = ToElement(req.GraceWindowMinutes);
            doc["penalty_window_minutes"] = ToElement(req.PenaltyWindowMinutes);
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
            row.SettingsJson = JsonSerializer.Serialize(doc);
            // The column was written once, at construction, and never again — a dead audit
            // field on the one table that governs money and lights. Nothing reads it today,
            // which is exactly why it was never noticed: the first person to need "when did
            // this club last change its penalty policy" would have got the seed date and
            // believed it.
            row.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { saved = true });
        });

        var courts = app.MapGroup("/api/v1/admin/courts").RequireAuthorization(p => p.RequireRole("admin"));

        courts.MapGet("/", async (MainframeDbContext db, CancellationToken ct) =>
        {
            var list = await db.Courts.OrderBy(c => c.CourtNumber).ToListAsync(ct);
            return Results.Ok(list.Select(c => new
            {
                id = c.Id,
                court_number = c.CourtNumber,
                name = c.Name,
                court_type = c.CourtType.ToString(),
                slice_price_credits = c.SlicePriceCredits,
                is_active = c.IsActive,
            }));
        });

        courts.MapPost("/", async (
            CreateCourtRequest req, MainframeDbContext db, ITenantContext tenant,
            TenantSettingsAccessor settingsAccessor, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.Name)) return Results.BadRequest(new { error = "name_required" });
            if (req.SlicePriceCredits < 0) return Results.BadRequest(new { error = "price_negative" });

            // The tenant's slice_price_credits is the default for a new court, and until now
            // it was the default for nothing at all: every charge in the system reads
            // court.SlicePriceCredits, and the setting was only ever read back to render the
            // settings screen and written straight out again. The seed ships the setting at
            // 8.00 and the courts at 50.00, so an admin looking at that number was looking at
            // a price 6.25x away from what members actually pay, and editing it changed
            // nobody's bill. Giving it one real job is what makes it honest.
            var settings = await settingsAccessor.GetAsync(ct);
            var priceCredits = req.SlicePriceCredits ?? settings.DefaultSlicePriceCredits;

            var maxNo = await db.Courts.IgnoreQueryFilters().Where(c => c.TenantId == tenant.TenantId).MaxAsync(c => (int?)c.CourtNumber, ct) ?? 0;
            var court = new Court
            {
                TenantId = tenant.TenantId,
                CourtNumber = maxNo + 1,
                Name = req.Name.Trim(),
                CourtType = Enum.TryParse<CourtType>(req.CourtType, true, out var t) ? t : CourtType.Squash,
                SlicePriceCredits = priceCredits,
                IsActive = true,
            };
            db.Courts.Add(court);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { id = court.Id, court_number = court.CourtNumber });
        });

        courts.MapPatch("/{id:guid}", async (Guid id, UpdateCourtRequest req, MainframeDbContext db, CancellationToken ct) =>
        {
            var court = await db.Courts.FirstOrDefaultAsync(c => c.Id == id, ct);
            if (court is null) return Results.NotFound();
            if (req.Name is not null) court.Name = req.Name.Trim();
            if (req.SlicePriceCredits is not null)
            {
                if (req.SlicePriceCredits < 0) return Results.BadRequest(new { error = "price_negative" });
                court.SlicePriceCredits = req.SlicePriceCredits.Value;
            }
            if (req.IsActive is not null) court.IsActive = req.IsActive.Value;
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { saved = true });
        });

        courts.MapDelete("/{id:guid}", async (Guid id, MainframeDbContext db, CancellationToken ct) =>
        {
            var court = await db.Courts.FirstOrDefaultAsync(c => c.Id == id, ct);
            if (court is null) return Results.NotFound();
            // Soft delete: deactivate so historical bookings stay coherent.
            court.IsActive = false;
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { deactivated = true });
        });

        return app;
    }

    /// <summary>
    /// Bounds on the nine economics keys. Every one of them is a number a member is
    /// charged by or booked under, so the point is not tidiness — a conversion rate of
    /// zero makes every top-up worthless, and a negative one credits the member for
    /// paying. These are the values a form should never be able to submit.
    /// </summary>
    private static string? ValidateEconomics(UpdateSettingsRequest req)
    {
        if (req.CreditsPerZarRegular is <= 0 or > 1000) return "credits_per_zar_regular_out_of_range";
        if (req.CreditsPerZarLeague is <= 0 or > 1000) return "credits_per_zar_league_out_of_range";
        if (req.TopupBlockZar is <= 0 or > 100000) return "topup_block_zar_out_of_range";
        if (req.TopupMaxZarPerMember is not null && req.TopupBlockZar is not null
            && req.TopupMaxZarPerMember < req.TopupBlockZar)
        {
            // A cap below the block size means no top-up is ever legal, which reads to a
            // member as the payment page being broken.
            return "topup_max_below_block";
        }
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
        if (req.ActivationForwardWindowMinutes is < 1 or > 1440) return "activation_forward_window_minutes_out_of_range";
        if (req.ActivationCueWindowMinutes is < 0 or > 1440) return "activation_cue_window_minutes_out_of_range";
        if (req.QrLifetimeSeconds is < 15 or > 3600) return "qr_lifetime_seconds_out_of_range";
        if (req.RosterWindowMinutes is < 5 or > 1440) return "roster_window_minutes_out_of_range";
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
        return null;
    }

    /// <summary>Same omitted-means-unchanged rule as the economics keys, for the three gate settings.</summary>
    private static void WriteOptionalGateSettings(IDictionary<string, JsonElement> doc, UpdateSettingsRequest req)
    {
        if (req.EffectiveGateUnlockSeconds is { } unlock) doc["gate_unlock_seconds"] = ToElement(unlock);
        if (req.EffectiveGateAccessPolicy is { } policy) doc[GateAccessPolicies.Key] = ToElement(policy.Trim());
        if (req.EffectiveGateEarlyEntryMinutes is { } early) doc["gate_early_entry_minutes"] = ToElement(early);
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
        if (req.CreditsPerZarRegular is not null) doc["credits_per_zar_regular"] = ToElement(req.CreditsPerZarRegular);
        if (req.CreditsPerZarLeague is not null) doc["credits_per_zar_league"] = ToElement(req.CreditsPerZarLeague);
        if (req.TopupBlockZar is not null) doc["topup_block_zar"] = ToElement(req.TopupBlockZar);
        if (req.TopupMaxZarPerMember is not null) doc["topup_max_zar_per_member"] = ToElement(req.TopupMaxZarPerMember);
        if (req.MemberPerDayMaxMinutes is not null) doc["member_per_day_max_minutes"] = ToElement(req.MemberPerDayMaxMinutes);
        if (req.PeakHours is not null) doc["peak_hours"] = ToElement(req.PeakHours.Trim());
        if (req.PeakAdvanceHoursForRegular is not null) doc["peak_advance_hours_for_regular"] = ToElement(req.PeakAdvanceHoursForRegular);
        if (req.RetentionYears is not null) doc["retention_years"] = ToElement(req.RetentionYears);
        if (req.NoShowLookbackDays is not null) doc["no_show_lookback_days"] = ToElement(req.NoShowLookbackDays);
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

    private static Dictionary<string, JsonElement> ParseObject(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new();
        using var doc = JsonDocument.Parse(json);
        var dict = new Dictionary<string, JsonElement>();
        foreach (var p in doc.RootElement.EnumerateObject()) dict[p.Name] = p.Value.Clone();
        return dict;
    }
    private static JsonElement ToElement<T>(T value) => JsonSerializer.SerializeToElement(value);
    private static int GetInt(IReadOnlyDictionary<string, JsonElement> d, string k, int fallback)
        => d.TryGetValue(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : fallback;
    private static decimal GetDecimal(IReadOnlyDictionary<string, JsonElement> d, string k, decimal fallback)
        => d.TryGetValue(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDecimal() : fallback;
    private static string GetString(IReadOnlyDictionary<string, JsonElement> d, string k, string fallback)
        => d.TryGetValue(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? fallback : fallback;
}

public sealed record UpdateSettingsRequest(
    int SliceMinutes,
    decimal SlicePriceCredits,
    int AdvanceBookingDays,
    int DayStartMinute,
    int DayEndMinute,
    decimal PenaltyPct,
    int GraceWindowMinutes,
    int PenaltyWindowMinutes,
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
    decimal? CreditsPerZarRegular = null,
    decimal? CreditsPerZarLeague = null,
    decimal? TopupBlockZar = null,
    decimal? TopupMaxZarPerMember = null,
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
    [property: JsonPropertyName("gate_early_entry_minutes")] int? GateEarlyEntryMinutesSnake = null)
{
    /// <summary>The release the club asked for, under either spelling, or null when neither arrived.</summary>
    public int? EffectiveGateUnlockSeconds => GateUnlockSeconds ?? GateUnlockSecondsSnake;

    /// <summary>The policy the club asked for, under either spelling.</summary>
    public string? EffectiveGateAccessPolicy => GateAccessPolicy ?? GateAccessPolicySnake;

    /// <summary>The entry window the club asked for, under either spelling.</summary>
    public int? EffectiveGateEarlyEntryMinutes => GateEarlyEntryMinutes ?? GateEarlyEntryMinutesSnake;
}

/// <summary>
/// A new court. <c>SlicePriceCredits</c> is optional: left out, the court is priced at the
/// tenant's <c>slice_price_credits</c> default.
/// </summary>
public sealed record CreateCourtRequest(string Name, string CourtType, decimal? SlicePriceCredits);
public sealed record UpdateCourtRequest(string? Name, decimal? SlicePriceCredits, bool? IsActive);
