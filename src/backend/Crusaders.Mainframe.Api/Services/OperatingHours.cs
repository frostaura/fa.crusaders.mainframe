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
    public static readonly string[] DayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

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

    /// <summary>
    /// The map as the admin API sends and receives it: <c>{"mon":"06:00-22:00", …}</c>, only
    /// the days it names, in weekday order.
    ///
    /// <para>
    /// Rendered from the parsed map rather than echoed from the stored document, so what the
    /// settings screen shows is what <see cref="TenantSettingsView.HoursFor"/> reads. A day
    /// this type refused to parse is a day the engine does not honour, and echoing the raw
    /// text would have shown an admin hours the booking rule ignores — which is the shape of
    /// the defect this whole surface exists to close.
    /// </para>
    /// </summary>
    public Dictionary<string, string> ToWire()
    {
        var wire = new Dictionary<string, string>();
        for (var i = 0; i < DayKeys.Length; i++)
        {
            if (_byDay.TryGetValue((DayOfWeek)i, out var hours))
            {
                wire[DayKeys[i]] = $"{Format(hours.OpenMinute)}-{Format(hours.CloseMinute)}";
            }
        }
        return wire;
    }

    /// <summary>
    /// Strict parse of an admin-supplied map, for the one moment a person is standing in
    /// front of the screen to be told what is wrong with it.
    ///
    /// <para>
    /// Deliberately the opposite posture to <see cref="FromSettings"/>, which must never let
    /// a bad document close a club. Here a day that will not parse is refused and named, and
    /// what comes back is the normalised text that will be written — so the value stored is
    /// the value this type reads back, with no second opinion about formatting in between.
    /// </para>
    /// </summary>
    /// <param name="wire">Day key to <c>"HH:mm-HH:mm"</c>. An empty map clears the setting.</param>
    /// <param name="normalised">The document to store, keyed in weekday order.</param>
    /// <param name="badKey">The day that could not be read, or the unknown key that was sent.</param>
    public static bool TryParseWire(
        IReadOnlyDictionary<string, string> wire,
        out Dictionary<string, string> normalised,
        out string? badKey)
    {
        normalised = new Dictionary<string, string>();
        badKey = null;
        foreach (var (key, value) in wire)
        {
            var day = key.Trim().ToLowerInvariant();
            if (Array.IndexOf(DayKeys, day) < 0)
            {
                badKey = key;
                return false;
            }
            var range = ParseRange(value);
            if (range is null)
            {
                badKey = day;
                return false;
            }
            normalised[day] = $"{Format(range.Value.OpenMinute)}-{Format(range.Value.CloseMinute)}";
        }
        // Re-keyed in weekday order so a stored document reads the same whatever order the
        // form sent its rows in — a diff of two settings documents should be about hours.
        var ordered = new Dictionary<string, string>();
        foreach (var day in DayKeys)
        {
            if (normalised.TryGetValue(day, out var text)) ordered[day] = text;
        }
        normalised = ordered;
        return true;
    }

    private static string Format(int minute)
    {
        return $"{minute / 60:D2}:{minute % 60:D2}";
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
