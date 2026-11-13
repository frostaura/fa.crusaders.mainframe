using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// A board's own display and hardware settings on the admin PATCH (device-api.md §5, §10, §12):
/// <c>lcd_layout</c>, <c>lcd_marquee_enabled</c> and the five <c>hw_*</c> keys, each THREE-valued
/// exactly like <c>button_map</c> — absent leaves it alone, JSON <c>null</c> returns the board to
/// the club's value, a value sets the board's own — plus <c>push_network</c>.
///
/// <para>
/// <b>Why per board.</b> The panel fitted, the relay module's trigger level, the backpack address
/// and the scanner are facts about one enclosure, and the Mega that drives them can never be
/// reflashed again. A club with two different builds needs each told the truth, and an admin who
/// set "expanded" on a box whose panel turns out to be a 16×2 must be able to put back compact
/// for that box alone, from the office, within one heartbeat.
/// </para>
/// </summary>
public static class DeviceBoardOverrides
{
    /// <summary>The PATCH keys this handles, snake_case (camelCase is accepted too).</summary>
    public static readonly string[] Keys =
    [
        DeviceSettings.LcdLayoutKey, DeviceSettings.LcdMarqueeEnabledKey,
        DeviceSettings.HwRelayActiveLevel.Key, DeviceSettings.HwLcdI2cAddress.Key, DeviceSettings.HwScannerBaud.Key,
        DeviceSettings.HwScannerLineEnd.Key, DeviceSettings.HwScannerGapMs.Key,
    ];

    public const string PushNetworkKey = "push_network";

    /// <summary>A parsed PATCH: the writes to make (each a setter and the change token it records) and whether to push the network.</summary>
    public sealed record Patch(IReadOnlyList<(string Token, Action<Device> Apply, Func<Device, bool> Differs)> Writes, bool PushNetwork)
    {
        public static readonly Patch Empty = new([], false);

        public bool Any => Writes.Count > 0 || PushNetwork;
    }

    /// <summary>Whether the request names any of these keys at all (refused on a door: a door has no LCD, no relays, no scanner settings).</summary>
    public static bool Mentions(IReadOnlyDictionary<string, JsonElement>? extra) =>
        extra is not null && Keys.Any(k => Find(extra, k) is not null);

    /// <summary>The patch, or the refusal payload for the first bad value (§5's codes and bounds).</summary>
    public static (Patch Patch, object? Refusal) Parse(IReadOnlyDictionary<string, JsonElement>? extra)
    {
        if (extra is null || extra.Count == 0) return (Patch.Empty, null);
        var writes = new List<(string, Action<Device>, Func<Device, bool>)>();

        if (Find(extra, DeviceSettings.LcdLayoutKey) is { } layout)
        {
            if (layout.ValueKind == JsonValueKind.Null) writes.Add(Write("lcd_layout", d => d.LcdLayoutOverride = null, d => d.LcdLayoutOverride is not null));
            else if (layout.ValueKind == JsonValueKind.String && DeviceSettings.Layouts.Contains(layout.GetString()))
            {
                var v = layout.GetString();
                writes.Add(Write("lcd_layout", d => d.LcdLayoutOverride = v, d => d.LcdLayoutOverride != v));
            }
            else return (Patch.Empty, new { error = "lcd_layout_invalid", values = DeviceSettings.Layouts });
        }

        if (Find(extra, DeviceSettings.LcdMarqueeEnabledKey) is { } marquee)
        {
            if (marquee.ValueKind == JsonValueKind.Null) writes.Add(Write("lcd_marquee_enabled", d => d.LcdMarqueeOverride = null, d => d.LcdMarqueeOverride is not null));
            else if (marquee.ValueKind is JsonValueKind.True or JsonValueKind.False)
            {
                var v = marquee.GetBoolean();
                writes.Add(Write("lcd_marquee_enabled", d => d.LcdMarqueeOverride = v, d => d.LcdMarqueeOverride != v));
            }
            else return (Patch.Empty, new { error = "lcd_marquee_enabled_invalid" });
        }

        if (ParseHardware(extra, writes) is { } refused) return (Patch.Empty, refused);

        var push = Find(extra, PushNetworkKey) is { ValueKind: JsonValueKind.True };
        return (new Patch(writes, push), null);
    }

    private static object? ParseHardware(IReadOnlyDictionary<string, JsonElement> extra, List<(string, Action<Device>, Func<Device, bool>)> writes)
    {
        return ParseText(extra, writes, DeviceSettings.HwRelayActiveLevel, (d, v) => d.HwRelayActiveLevel = v, d => d.HwRelayActiveLevel)
            ?? ParseText(extra, writes, DeviceSettings.HwScannerLineEnd, (d, v) => d.HwScannerLineEnd = v, d => d.HwScannerLineEnd)
            ?? ParseChoice(extra, writes, DeviceSettings.HwLcdI2cAddress, (d, v) => d.HwLcdI2cAddress = v, d => d.HwLcdI2cAddress)
            ?? ParseChoice(extra, writes, DeviceSettings.HwScannerBaud, (d, v) => d.HwScannerBaud = v, d => d.HwScannerBaud)
            ?? ParseGap(extra, writes);
    }

    private static object? ParseText(
        IReadOnlyDictionary<string, JsonElement> extra, List<(string, Action<Device>, Func<Device, bool>)> writes,
        TextChoice choice, Action<Device, string?> set, Func<Device, string?> get)
    {
        if (Find(extra, choice.Key) is not { } e) return null;
        if (Text(e, choice) is not { } ok) return new { error = $"{choice.Key}_invalid", values = choice.Values };
        var v = ok.Value;
        writes.Add(Write(choice.Key, d => set(d, v), d => get(d) != v));
        return null;
    }

    private static object? ParseChoice(
        IReadOnlyDictionary<string, JsonElement> extra, List<(string, Action<Device>, Func<Device, bool>)> writes,
        IntChoice choice, Action<Device, int?> set, Func<Device, int?> get)
    {
        if (Find(extra, choice.Key) is not { } e) return null;
        if (Number(e, choice) is not { } ok) return new { error = $"{choice.Key}_invalid", values = choice.Values };
        var v = ok.Value;
        writes.Add(Write(choice.Key, d => set(d, v), d => get(d) != v));
        return null;
    }

    private static object? ParseGap(IReadOnlyDictionary<string, JsonElement> extra, List<(string, Action<Device>, Func<Device, bool>)> writes)
    {
        var gap = DeviceSettings.HwScannerGapMs;
        if (Find(extra, gap.Key) is not { } g) return null;
        int? v = null;
        if (g.ValueKind != JsonValueKind.Null)
        {
            if (g.ValueKind != JsonValueKind.Number || !g.TryGetInt32(out var n) || n < gap.Min || n > gap.Max) return DeviceSettings.OutOfRange(gap);
            v = n;
        }
        writes.Add(Write(gap.Key, d => d.HwScannerGapMs = v, d => d.HwScannerGapMs != v));
        return null;
    }

    /// <summary>A text choice: <c>(null)</c> for JSON null (the club's), the value when in the set, else null (a refusal).</summary>
    private static Holder<string?>? Text(JsonElement e, TextChoice c)
    {
        if (e.ValueKind == JsonValueKind.Null) return new Holder<string?>(null);
        return e.ValueKind == JsonValueKind.String && c.Allows(e.GetString()) ? new Holder<string?>(e.GetString()) : null;
    }

    private static Holder<int?>? Number(JsonElement e, IntChoice c)
    {
        if (e.ValueKind == JsonValueKind.Null) return new Holder<int?>(null);
        return e.ValueKind == JsonValueKind.Number && e.TryGetInt32(out var n) && c.Allows(n) ? new Holder<int?>(n) : null;
    }

    private sealed record Holder<T>(T Value);

    private static (string, Action<Device>, Func<Device, bool>) Write(string token, Action<Device> apply, Func<Device, bool> differs) =>
        (token, apply, differs);

    /// <summary>Applies the patch to the row; the change tokens of the fields that really changed.</summary>
    public static List<string> Apply(Device device, Patch patch)
    {
        var changed = new List<string>();
        foreach (var (token, apply, differs) in patch.Writes)
        {
            if (!differs(device)) continue;
            apply(device);
            changed.Add(token);
        }
        return changed;
    }

    private static JsonElement? Find(IReadOnlyDictionary<string, JsonElement> extra, string snake)
    {
        if (extra.TryGetValue(snake, out var v)) return v;
        return extra.TryGetValue(DeviceSettings.CamelOf(snake), out var c) ? c : null;
    }
}
