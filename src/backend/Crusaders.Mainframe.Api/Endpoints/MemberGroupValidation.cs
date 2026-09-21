using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Every refusal the group surface can answer, in one place — a <c>400 {"error":"code", …}</c>
/// with the figures its sentence needs.
///
/// <para>
/// <b>Strict here, lenient on read</b>, which is the posture the whole settings layer already
/// takes: this is the one moment there is a person standing in front of the screen to be told
/// what is wrong, and a group read back later has nobody to ask. <see cref="GroupRules"/> is what
/// clamps on the way out, and the bounds are its constants rather than literals here, so the
/// number an admin is refused at cannot drift from the number the reader enforces.
/// </para>
/// </summary>
public static class MemberGroupValidation
{
    /// <summary>The refusal, or null when the body is one the club can act on.</summary>
    public static IResult? Refuse(MemberGroupRequest req, bool forCreate)
    {
        if (forCreate || req.Name is not null)
        {
            var name = req.Name?.Trim() ?? "";
            if (name.Length < GroupRules.MinNameLength || name.Length > GroupRules.MaxNameLength)
            {
                return Bad("group_name_invalid", new { min = GroupRules.MinNameLength, max = GroupRules.MaxNameLength });
            }
        }
        if (req.Description is { } description && description.Trim().Length > GroupRules.MaxDescriptionLength)
        {
            return Bad("group_description_too_long", new { max = GroupRules.MaxDescriptionLength });
        }
        if (req.Status is { } status && !status.Trim().Equals("active", StringComparison.OrdinalIgnoreCase)
                                     && !status.Trim().Equals("archived", StringComparison.OrdinalIgnoreCase))
        {
            return Bad("group_status_invalid", new { valid = new[] { "active", "archived" } });
        }

        return RefusePricing(req.Pricing) ?? RefuseCaps(req.Caps) ?? RefuseWindows(req.Windows);
    }

    private static IResult? RefusePricing(GroupPricingRequest? pricing)
    {
        if (pricing is null) return null;

        var mode = pricing.Mode?.Trim();
        if (mode is not ("inherit_court" or "multiplier" or "flat_per_slice"))
        {
            return Bad("group_pricing_mode_invalid",
                new { valid = new[] { "inherit_court", "multiplier", "flat_per_slice" } });
        }

        // A field the mode does not use is refused rather than ignored: an admin who set a flat
        // price and then switched to inherit_court needs to know the price is not in force, and
        // silently keeping it is how a group ends up carrying two prices and honouring neither.
        if (mode != "multiplier" && pricing.MultiplierBps is not null)
        {
            return Bad("group_pricing_field_not_for_mode", new { field = "multiplier_bps", mode });
        }
        if (mode != "flat_per_slice" && pricing.FlatSlicePriceCredits is not null)
        {
            return Bad("group_pricing_field_not_for_mode", new { field = "flat_slice_price_credits", mode });
        }

        if (mode == "multiplier")
        {
            if (pricing.MultiplierBps is not { } bps || bps < GroupRules.MinMultiplierBps || bps > GroupRules.MaxMultiplierBps)
            {
                return Bad("group_multiplier_out_of_range",
                    new { min = GroupRules.MinMultiplierBps, max = GroupRules.MaxMultiplierBps });
            }
        }

        if (mode == "flat_per_slice")
        {
            if (pricing.FlatSlicePriceCredits is not { } flat
                || flat < MoneySettings.MinSlicePriceCredits
                || flat > MoneySettings.MaxSlicePriceCredits
                || !MoneySettings.IsWholeCents(flat))
            {
                return Bad("group_flat_price_invalid",
                    new { min = MoneySettings.MinSlicePriceCredits, max = MoneySettings.MaxSlicePriceCredits });
            }
        }

        return null;
    }

    private static IResult? RefuseCaps(GroupCapsRequest? caps)
    {
        if (caps is null) return null;

        // 0 is legal on both and means UNLIMITED, as it does everywhere in this codebase — so the
        // lower bound is 0 rather than 1, and an admin who wants "no cap for this group" has a
        // way to say it.
        if (caps.MaxSlotsPerDay is { } slots && (slots < 0 || slots > BookingLimits.MaxSlotsPerDayCeiling))
        {
            return Bad("group_max_slots_out_of_range", new { max = BookingLimits.MaxSlotsPerDayCeiling });
        }
        if (caps.MaxMinutesPerDay is { } minutes && (minutes < 0 || minutes > BookingLimits.MaxMinutesPerDayCeiling))
        {
            return Bad("group_max_minutes_out_of_range", new { max = BookingLimits.MaxMinutesPerDayCeiling });
        }
        if (caps.AdvanceBookingDays is { } days && (days < 0 || days > 365))
        {
            return Bad("group_advance_days_out_of_range", new { max = 365 });
        }
        return null;
    }

    private static IResult? RefuseWindows(IReadOnlyList<GroupWindowRequest>? windows)
    {
        if (windows is null) return null;
        if (windows.Count > GroupRules.MaxWindowsPerGroup)
        {
            return Bad("group_windows_too_many", new { max = GroupRules.MaxWindowsPerGroup });
        }

        var parsed = new List<(DayOfWeek Day, int Start, int End)>(windows.Count);
        foreach (var window in windows)
        {
            var dayIndex = Array.FindIndex(
                OperatingHours.DayKeys, k => k.Equals(window.Day?.Trim(), StringComparison.OrdinalIgnoreCase));
            if (dayIndex < 0) return Bad("group_window_day_invalid", new { day = window.Day });

            if (!TimeOnly.TryParse(window.Start?.Trim(), out var start)
                || !TryParseEnd(window.End?.Trim(), out var endMinute)
                || (int)start.ToTimeSpan().TotalMinutes >= endMinute)
            {
                return Bad("group_window_range_invalid", new { day = window.Day });
            }

            parsed.Add(((DayOfWeek)dayIndex, (int)start.ToTimeSpan().TotalMinutes, endMinute));
        }

        foreach (var byDay in parsed.GroupBy(w => w.Day))
        {
            if (byDay.Count() > GroupRules.MaxWindowsPerDay)
            {
                return Bad("group_windows_too_many",
                    new { day = OperatingHours.DayKeys[(int)byDay.Key], max = GroupRules.MaxWindowsPerDay });
            }

            // Overlapping windows on one day are refused rather than merged: merged, they read
            // back as something the admin did not type, and a screen that shows a different shape
            // from the one that was saved is the silent-write failure this repo has been bitten by.
            var ordered = byDay.OrderBy(w => w.Start).ToList();
            for (var i = 1; i < ordered.Count; i++)
            {
                if (ordered[i].Start < ordered[i - 1].End)
                {
                    return Bad("group_windows_overlap", new { day = OperatingHours.DayKeys[(int)byDay.Key] });
                }
            }
        }

        return null;
    }

    /// <summary>
    /// <c>HH:mm</c>, and <c>24:00</c> — which <c>TimeOnly</c> cannot hold and which is the only
    /// way to say "until midnight" in a half-open convention without naming 23:59.
    /// </summary>
    private static bool TryParseEnd(string? text, out int minutes)
    {
        minutes = 0;
        if (text is "24:00") { minutes = 1440; return true; }
        if (!TimeOnly.TryParse(text, out var value)) return false;
        minutes = (int)value.ToTimeSpan().TotalMinutes;
        return minutes > 0;
    }

    /// <summary>The window rows a validated request produces. Only called after <see cref="Refuse"/> returns null.</summary>
    public static IEnumerable<MemberGroupWindow> Windows(MemberGroupRequest req, Guid tenantId, Guid groupId)
    {
        foreach (var window in req.Windows ?? [])
        {
            var dayIndex = Array.FindIndex(
                OperatingHours.DayKeys, k => k.Equals(window.Day?.Trim(), StringComparison.OrdinalIgnoreCase));
            TimeOnly.TryParse(window.Start?.Trim(), out var start);
            TryParseEnd(window.End?.Trim(), out var endMinute);

            yield return new MemberGroupWindow
            {
                TenantId = tenantId,
                GroupId = groupId,
                DayOfWeek = (DayOfWeek)dayIndex,
                StartMinute = (int)start.ToTimeSpan().TotalMinutes,
                EndMinute = endMinute,
            };
        }
    }

    private static IResult Bad(string error, object figures)
        => Results.BadRequest(Merge(error, figures));

    /// <summary>
    /// The refusal body: the code, plus whatever figures its sentence needs. Composed rather than
    /// anonymous-typed per call so every refusal on this surface has the same shape.
    /// </summary>
    private static Dictionary<string, object?> Merge(string error, object figures)
    {
        var body = new Dictionary<string, object?> { ["error"] = error };
        foreach (var property in figures.GetType().GetProperties())
        {
            body[ToSnake(property.Name)] = property.GetValue(figures);
        }
        return body;
    }

    private static string ToSnake(string name)
        => string.Concat(name.Select((c, i) => char.IsUpper(c) && i > 0 ? "_" + char.ToLowerInvariant(c) : char.ToLowerInvariant(c).ToString()));
}
