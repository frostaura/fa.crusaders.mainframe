using System.Text.Json;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Strongly-typed view over the tenant_settings JSON document.
/// Hard-defaults match the Crusaders working assumptions in the client blueprint Rev 2.
/// </summary>
public sealed class TenantSettingsAccessor
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;

    public TenantSettingsAccessor(MainframeDbContext db, ITenantContext tenant)
    { _db = db; _tenant = tenant; }

    public async Task<TenantSettingsView> GetAsync(CancellationToken ct)
    {
        var row = await _db.TenantSettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == _tenant.TenantId, ct);
        var json = row?.SettingsJson ?? "{}";
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        int sliceMinutes = TryInt(root, "slice_minutes", 15);                       // Blueprint B.4 — 15-minute default for Crusaders.
        decimal slicePrice = TryDecimal(root, "slice_price_credits", 8m);                // Now read as credits per slice.
        decimal penaltyPct = TryDecimal(root, "penalty_pct", 30m);
        int graceMin = TryInt(root, "grace_window_minutes", 5);
        int penaltyMin = TryInt(root, "penalty_window_minutes", 15);
        int advanceDays = TryInt(root, "advance_booking_days", 14);
        int dayStartMinute = TryInt(root, "day_start_minute", 6 * 60);   // 06:00 default — matches AdminConfigEndpoints.
        int dayEndMinute = TryInt(root, "day_end_minute", 22 * 60);      // 22:00 default — matches AdminConfigEndpoints.
        string tz = TryString(root, "timezone", "Africa/Johannesburg");

        // Phase 8 additions per client blueprint Rev 2.
        decimal creditsPerZarRegular = TryDecimal(root, "credits_per_zar_regular", 1.6m);    // A.8 — R100 → 160 credits.
        decimal creditsPerZarLeague = TryDecimal(root, "credits_per_zar_league", 2.4m);      // A.8 — R100 → 240 credits.
        decimal topupBlockZar = TryDecimal(root, "topup_block_zar", 100m);                   // A.3 — block of R100.
        decimal topupMaxZarPerMember = TryDecimal(root, "topup_max_zar_per_member", 1000m);  // A.3 — R1000 cap.
        int memberPerDayMaxMinutes = TryInt(root, "member_per_day_max_minutes", 60);         // A.4 / B.3 — 60 minutes per day per member.
        string peakHours = TryString(root, "peak_hours", "16:00-19:00");                     // A.12 — peak window.
        int peakAdvanceHoursForRegular = TryInt(root, "peak_advance_hours_for_regular", 1);  // A.12 — Regular members may grab a still-empty peak slot within 1h of start.
        int retentionYears = TryInt(root, "retention_years", 2);                             // D.1 — 2-year retention.
        int noShowLookbackDays = TryInt(root, "no_show_lookback_days", 7);                   // How far back the no-show sweep reaches; bounds a first-run backlog.

        return new TenantSettingsView(
            sliceMinutes, slicePrice, penaltyPct, graceMin, penaltyMin, advanceDays, tz,
            creditsPerZarRegular, creditsPerZarLeague,
            topupBlockZar, topupMaxZarPerMember,
            memberPerDayMaxMinutes,
            peakHours, peakAdvanceHoursForRegular,
            retentionYears,
            dayStartMinute, dayEndMinute,
            noShowLookbackDays);
    }

    private static int TryInt(JsonElement root, string name, int fallback)
        => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : fallback;
    private static decimal TryDecimal(JsonElement root, string name, decimal fallback)
        => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDecimal() : fallback;
    private static string TryString(JsonElement root, string name, string fallback)
        => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? fallback : fallback;
}

public sealed record TenantSettingsView(
    int SliceMinutes,
    decimal DefaultSlicePriceCredits,           // Unit is credits per blueprint A.8/A.9. Legacy field name kept.
    decimal PenaltyPct,
    int GraceWindowMinutes,
    int PenaltyWindowMinutes,
    int AdvanceBookingDays,
    string Timezone,
    decimal CreditsPerZarRegular,
    decimal CreditsPerZarLeague,
    decimal TopupBlockZar,
    decimal TopupMaxZarPerMember,
    int MemberPerDayMaxMinutes,
    string PeakHoursRange,
    int PeakAdvanceHoursForRegular,
    int RetentionYears,
    int DayStartMinute,
    int DayEndMinute,
    int NoShowLookbackDays)
{
    /// <summary>Returns credits-per-rand for a given member class. Defaults to <see cref="CreditsPerZarRegular"/> if unknown.</summary>
    public decimal ConversionRateFor(Crusaders.Mainframe.Api.Domain.MemberClass cls)
        => cls == Crusaders.Mainframe.Api.Domain.MemberClass.LeagueOrSenior ? CreditsPerZarLeague : CreditsPerZarRegular;

    /// <summary>Parses <see cref="PeakHoursRange"/> ("16:00-19:00") into TimeOnly bounds. Returns null on malformed input.</summary>
    public (TimeOnly start, TimeOnly end)? PeakHours()
    {
        var parts = PeakHoursRange.Split('-');
        if (parts.Length != 2) return null;
        if (!TimeOnly.TryParse(parts[0].Trim(), out var s) || !TimeOnly.TryParse(parts[1].Trim(), out var e)) return null;
        return (s, e);
    }
}
