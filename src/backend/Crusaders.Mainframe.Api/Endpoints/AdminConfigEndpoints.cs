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
    IReadOnlyList<string>? ButtonMap = null);

public sealed record CreateCourtRequest(string Name, string CourtType, decimal SlicePriceCredits);
public sealed record UpdateCourtRequest(string? Name, decimal? SlicePriceCredits, bool? IsActive);
