using System.Text.Json;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// When the club is open, per weekday — <c>tenant_settings.operating_hours</c>.
///
/// <para>
/// The setting has existed since the first seed and was read by nothing: the only two
/// references in the tree were the seeder that writes it and a validation string. So the
/// club's stated Saturday close of 20:00 was decoration, the grid was drawn from a single
/// flat pair, and <see cref="BookingService"/> consulted neither — it sold 03:00 on a
/// Sunday, took the money, and then could not show the member the slot they had bought.
/// </para>
///
/// <para>
/// Lenient on read, on purpose. A settings document somebody hand-edited into nonsense
/// must not close the club: an unparseable day is simply absent from the map, and
/// <see cref="TenantSettingsView.HoursFor"/> falls back to the flat default for it. Same
/// posture as <see cref="ButtonMap.FromSettings"/>, and for the same reason.
/// </para>
/// </summary>
public sealed class OperatingHours
{
    /// <summary>No per-weekday map configured — every day falls back to the flat default.</summary>
    public static readonly OperatingHours Empty = new(new Dictionary<DayOfWeek, (int, int)>());

    private readonly IReadOnlyDictionary<DayOfWeek, (int OpenMinute, int CloseMinute)> _byDay;

    private OperatingHours(IReadOnlyDictionary<DayOfWeek, (int, int)> byDay) => _byDay = byDay;

    /// <summary>The keys the settings document uses, in <see cref="DayOfWeek"/> order.</summary>
    private static readonly string[] DayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

    /// <summary>Open and close for one weekday, minutes past local midnight, or null if this map does not name it.</summary>
    public (int OpenMinute, int CloseMinute)? For(DayOfWeek day)
        => _byDay.TryGetValue(day, out var hours) ? hours : null;

    /// <summary>True when this map names no weekday at all.</summary>
    public bool IsEmpty => _byDay.Count == 0;

    /// <summary>Reads the <c>operating_hours</c> object off a settings document. Never throws.</summary>
    public static OperatingHours FromSettings(JsonElement root)
    {
        if (!root.TryGetProperty("operating_hours", out var node) || node.ValueKind != JsonValueKind.Object)
        {
            return Empty;
        }

        var byDay = new Dictionary<DayOfWeek, (int, int)>();
        for (var i = 0; i < DayKeys.Length; i++)
        {
            if (!node.TryGetProperty(DayKeys[i], out var value) || value.ValueKind != JsonValueKind.String)
            {
                continue;
            }
            var range = ParseRange(value.GetString());
            if (range is not null)
            {
                byDay[(DayOfWeek)i] = range.Value;
            }
        }
        return byDay.Count == 0 ? Empty : new OperatingHours(byDay);
    }

    /// <summary>Parses <c>"07:00-20:00"</c> into minutes past midnight. Returns null on anything else.</summary>
    private static (int OpenMinute, int CloseMinute)? ParseRange(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var parts = text.Split('-');
        if (parts.Length != 2) return null;
        if (!TimeOnly.TryParse(parts[0].Trim(), out var open)) return null;
        if (!TimeOnly.TryParse(parts[1].Trim(), out var close)) return null;
        var openMinute = (open.Hour * 60) + open.Minute;
        var closeMinute = (close.Hour * 60) + close.Minute;
        // A close at or before the open is not an overnight club, it is a typo — and
        // reading it as "open until tomorrow" would sell the small hours, which is the
        // very thing this type exists to stop.
        if (closeMinute <= openMinute) return null;
        return (openMinute, closeMinute);
    }
}
