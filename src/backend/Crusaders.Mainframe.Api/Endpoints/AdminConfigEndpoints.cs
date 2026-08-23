using System.Text.Json;
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
                slice_price_credits = GetDecimal(doc, "slice_price_credits", defaults.DefaultSlicePriceCredits),
                advance_booking_days = GetInt(doc, "advance_booking_days", defaults.AdvanceBookingDays),
                day_start_minute = GetInt(doc, "day_start_minute", defaults.DayStartMinute),
                day_end_minute = GetInt(doc, "day_end_minute", defaults.DayEndMinute),
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
            });
        });

        settings.MapPut("/", async (UpdateSettingsRequest req, MainframeDbContext db, ITenantContext tenant, CancellationToken ct) =>
        {
            if (req.AdvanceBookingDays < 0 || req.AdvanceBookingDays > 365)
                return Results.BadRequest(new { error = "advance_booking_days_out_of_range" });
            if (req.SliceMinutes is < 5 or > 240)
                return Results.BadRequest(new { error = "slice_minutes_out_of_range" });
            if (req.DayStartMinute < 0 || req.DayEndMinute > 24 * 60 || req.DayStartMinute >= req.DayEndMinute)
                return Results.BadRequest(new { error = "operating_hours_invalid" });
            if (req.PenaltyPct is < 0 or > 100)
                return Results.BadRequest(new { error = "penalty_pct_out_of_range" });

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

            var row = await db.TenantSettings.FirstOrDefaultAsync(s => s.TenantId == tenant.TenantId, ct);
            if (row is null)
            {
                row = new TenantSettings { TenantId = tenant.TenantId, SettingsJson = "{}" };
                db.TenantSettings.Add(row);
            }
            var doc = ParseObject(row.SettingsJson);
            doc["slice_minutes"] = ToElement(req.SliceMinutes);
            doc["slice_price_credits"] = ToElement(req.SlicePriceCredits);
            doc["advance_booking_days"] = ToElement(req.AdvanceBookingDays);
            doc["day_start_minute"] = ToElement(req.DayStartMinute);
            doc["day_end_minute"] = ToElement(req.DayEndMinute);
            doc["penalty_pct"] = ToElement(req.PenaltyPct);
            doc["grace_window_minutes"] = ToElement(req.GraceWindowMinutes);
            doc["penalty_window_minutes"] = ToElement(req.PenaltyWindowMinutes);
            // Omitted means unchanged, not "reset to default": a screen that does not
            // yet edit the button map must not wipe one an admin set through another.
            if (buttons is not null) doc["button_map"] = ToElement(buttons.ToWire());
            WriteOptionalEconomics(doc, req);
            row.SettingsJson = JsonSerializer.Serialize(doc);
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

        courts.MapPost("/", async (CreateCourtRequest req, MainframeDbContext db, ITenantContext tenant, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.Name)) return Results.BadRequest(new { error = "name_required" });
            if (req.SlicePriceCredits < 0) return Results.BadRequest(new { error = "price_negative" });
            var maxNo = await db.Courts.IgnoreQueryFilters().Where(c => c.TenantId == tenant.TenantId).MaxAsync(c => (int?)c.CourtNumber, ct) ?? 0;
            var court = new Court
            {
                TenantId = tenant.TenantId,
                CourtNumber = maxNo + 1,
                Name = req.Name.Trim(),
                CourtType = Enum.TryParse<CourtType>(req.CourtType, true, out var t) ? t : CourtType.Squash,
                SlicePriceCredits = req.SlicePriceCredits,
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
    int? NoShowLookbackDays = null);

public sealed record CreateCourtRequest(string Name, string CourtType, decimal SlicePriceCredits);
public sealed record UpdateCourtRequest(string? Name, decimal? SlicePriceCredits, bool? IsActive);
