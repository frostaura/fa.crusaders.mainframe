using System.Text.Json;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>One bounded integer setting: its <c>tenant_settings</c> key, default and inclusive bounds.</summary>
public sealed record IntSetting(string Key, int Default, int Min, int Max)
{
    /// <summary>The camelCase spelling a PUT also binds (the endpoint's two-spelling rule).</summary>
    public string Camel => DeviceSettings.CamelOf(Key);

    public int Clamp(int raw) => Math.Clamp(raw, Min, Max);
}

/// <summary>One enumerated text setting (device-api.md §5): its key, default and closed set.</summary>
public sealed record TextChoice(string Key, string Default, string[] Values)
{
    public string Camel => DeviceSettings.CamelOf(Key);

    /// <summary>The value, or the default for anything outside the set ("unknown → no change" on the board; the server never sends one).</summary>
    public string Resolve(string? raw) => raw is not null && Values.Contains(raw, StringComparer.Ordinal) ? raw : Default;

    public bool Allows(string? raw) => raw is not null && Values.Contains(raw, StringComparer.Ordinal);
}

/// <summary>One enumerated integer setting (device-api.md §5): its key, default and closed set.</summary>
public sealed record IntChoice(string Key, int Default, int[] Values)
{
    public string Camel => DeviceSettings.CamelOf(Key);

    // Block bodies: lizard's C# parser mis-scopes an expression-bodied member holding a `{ }`
    // pattern into a global pseudo-function (memory/gotchas-build.md).
    public int Resolve(int? raw)
    {
        return raw.HasValue && Values.Contains(raw.Value) ? raw.Value : Default;
    }

    public bool Allows(int? raw)
    {
        return raw.HasValue && Values.Contains(raw.Value);
    }
}

/// <summary>
/// The device contract v3 settings (device-api.md §5, §6), raw as stored — read through
/// <see cref="DeviceSettings"/>, which clamps each one independently, exactly as the bridge does
/// with what it is sent: a bad value never costs its neighbours.
/// </summary>
public sealed record DeviceSettingsRaw(
    string LcdLayout,
    bool LcdMarqueeEnabled,
    IReadOnlyDictionary<string, int> Ints,
    IReadOnlyDictionary<string, string>? Texts = null)
{
    public static readonly DeviceSettingsRaw Defaults = new(
        DeviceSettings.Compact, DeviceSettings.DefaultMarqueeEnabled,
        DeviceSettings.StoredInts.ToDictionary(k => k, k => DeviceSettings.DefaultOf(k)),
        DeviceSettings.TextChoices.ToDictionary(c => c.Key, c => c.Default));

    /// <summary>The stored value of <paramref name="setting"/>, or its default.</summary>
    public int Raw(IntSetting setting) => Ints.TryGetValue(setting.Key, out var v) ? v : setting.Default;

    /// <summary>The stored value of an enumerated integer, or null when none is stored.</summary>
    public int? Raw(IntChoice setting) => Ints.TryGetValue(setting.Key, out var v) ? v : null;

    /// <summary>The stored value of an enumerated text, or null when none is stored.</summary>
    public string? Raw(TextChoice setting) => Texts is not null && Texts.TryGetValue(setting.Key, out var v) ? v : null;
}

/// <summary>
/// The v3 box and device settings (device-api.md §5, §6) and the bounds every box and device
/// setting is served with (§10, FA-2/BA-05: a client range that drifted from the server's).
///
/// <para>
/// <b>One table, three readers.</b> The heartbeat clamps from it, the settings PUT refuses
/// outside it and the settings GET serves it as <c>bounds</c>, so the number an admin is refused
/// at, the number the console offers and the number a box is sent cannot drift apart.
/// </para>
/// </summary>
public static class DeviceSettings
{
    public const string Compact = "compact";
    public const string Expanded = "expanded";
    public static readonly string[] Layouts = [Compact, Expanded];
    public const bool DefaultMarqueeEnabled = true;

    public const string LcdLayoutKey = "lcd_layout";
    public const string LcdMarqueeEnabledKey = "lcd_marquee_enabled";

    public static readonly IntSetting LcdMarqueeStepMs = new("lcd_marquee_step_ms", 400, 250, 1000);
    public static readonly IntSetting LcdLandingPageSeconds = new("lcd_landing_page_seconds", 4, 2, 15);
    public static readonly IntSetting LcdScreenCeilingSeconds = new("lcd_screen_ceiling_seconds", 60, 15, 120);
    public static readonly IntSetting LcdLandingDwellSeconds = new("lcd_landing_dwell_seconds", 3, 0, 10);
    public static readonly IntSetting LcdAfterLightsOnSeconds = new("lcd_after_lights_on_seconds", 15, 5, 60);
    public static readonly IntSetting LcdReinitSeconds = new("lcd_reinit_seconds", 60, 30, 600);
    public static readonly IntSetting RelayAuthorisationCapMinutes = new("relay_authorisation_cap_minutes", 240, 90, 720);
    public static readonly IntSetting RelayReconcileMinSeconds = new("relay_reconcile_min_seconds", 60, 30, 600);
    public static readonly IntSetting PowerRestoreTrustMinutes = new("device_power_restore_trust_minutes", 20, 0, 120);
    public static readonly IntSetting NetFallbackMinutes = new("device_net_fallback_minutes", 10, 3, 60);

    /// <summary>§6: hours the old key stays valid once every <c>key:1</c> board is on the new one.</summary>
    public static readonly IntSetting KeyGraceHours = new("device_key_grace_hours", 168, 1, 720);

    // ---- §12: the hardware facts a frozen Mega no longer has compiled in. Each has a per-board
    //      override on the device row (three-valued on the PATCH, like button_map). ----

    public const string RelayHigh = "high";
    public const string RelayLow = "low";
    public const string LineEndAuto = "auto";
    public const string LineEndCrlf = "crlf";

    /// <summary>The level the Mega drives "on" at. Default high (the 2.1.0 build); a wrong one fails DARK.</summary>
    public static readonly TextChoice HwRelayActiveLevel = new("hw_relay_active_level", RelayHigh, [RelayHigh, RelayLow]);

    /// <summary>The LCD backpack's I2C address: 0 probes; else a PCF8574 (0x20–0x27) or PCF8574A (0x38–0x3F) address.</summary>
    public static readonly IntChoice HwLcdI2cAddress = new("hw_lcd_i2c_address", 0,
        [0, 32, 33, 34, 35, 36, 37, 38, 39, 56, 57, 58, 59, 60, 61, 62, 63]);

    /// <summary>The scanner's UART rate: 0 auto-detects while idle.</summary>
    public static readonly IntChoice HwScannerBaud = new("hw_scanner_baud", 0, [0, 9600, 19200, 38400, 57600, 115200]);

    /// <summary>How a scan line ends: auto (CR, LF or an idle gap) or CR/LF only.</summary>
    public static readonly TextChoice HwScannerLineEnd = new("hw_scanner_line_end", LineEndAuto, [LineEndAuto, LineEndCrlf]);

    /// <summary>The idle gap that ends a suffix-less scan line.</summary>
    public static readonly IntSetting HwScannerGapMs = new("hw_scanner_gap_ms", 150, 50, 500);

    /// <summary>The two enumerated text settings the server validates as a closed set (the layout is the third).</summary>
    public static readonly TextChoice[] TextChoices = [HwRelayActiveLevel, HwScannerLineEnd];

    /// <summary>The two enumerated integer settings.</summary>
    public static readonly IntChoice[] IntChoices = [HwLcdI2cAddress, HwScannerBaud];

    /// <summary>The ten v3 numbers the heartbeat's <c>config</c> carries, in the wire's order (§5).</summary>
    public static readonly IntSetting[] HeartbeatInts =
    [
        LcdMarqueeStepMs, LcdLandingPageSeconds, LcdScreenCeilingSeconds, LcdLandingDwellSeconds,
        LcdAfterLightsOnSeconds, LcdReinitSeconds, RelayAuthorisationCapMinutes, RelayReconcileMinSeconds,
        PowerRestoreTrustMinutes, NetFallbackMinutes,
    ];

    /// <summary>Every v3 ranged integer setting: the heartbeat's ten, the key grace and the scanner gap.</summary>
    public static readonly IntSetting[] V3Ints = [.. HeartbeatInts, KeyGraceHours, HwScannerGapMs];

    /// <summary>Every integer key the raw view keeps: the ranged ones and the enumerated ones.</summary>
    public static readonly string[] StoredInts = [.. V3Ints.Select(s => s.Key), .. IntChoices.Select(c => c.Key)];

    /// <summary>The default of a stored integer key.</summary>
    public static int DefaultOf(string key) =>
        V3Ints.FirstOrDefault(s => s.Key == key)?.Default ?? IntChoices.First(c => c.Key == key).Default;

    /// <summary>
    /// The 2.x box and device settings, with the bounds their validators have always enforced —
    /// listed here so the GET can serve them (they are not re-validated from this table: their
    /// own validators, which these mirror, stay where they are and a test pins the two equal).
    /// </summary>
    public static IReadOnlyList<IntSetting> LegacyInts { get; } =
    [
        new("lcd_revert_seconds", BoxSettings.DefaultLcdRevertSeconds, BoxSettings.MinLcdRevertSeconds, BoxSettings.MaxLcdRevertSeconds),
        new("lcd_choice_seconds", BoxSettings.DefaultLcdChoiceSeconds, BoxSettings.MinLcdChoiceSeconds, BoxSettings.MaxLcdChoiceSeconds),
        new("lcd_card_seconds", BoxSettings.DefaultLcdCardSeconds, BoxSettings.MinLcdCardSeconds, BoxSettings.MaxLcdCardSeconds),
        new("lcd_hint_seconds", BoxSettings.DefaultLcdHintSeconds, BoxSettings.MinLcdHintSeconds, BoxSettings.MaxLcdHintSeconds),
        new("scan_memory_seconds", BoxSettings.DefaultScanMemorySeconds, BoxSettings.MinLcdChoiceSeconds, BoxSettings.MaxScanMemorySeconds),
        new("clock_trust_minutes", BoxSettings.DefaultClockTrustMinutes, BoxSettings.MinClockTrustMinutes, BoxSettings.MaxClockTrustMinutes),
        new("device_fault_max_per_hour", BoxSettings.DefaultDeviceFaultMaxPerHour, BoxSettings.MinDeviceFaultMaxPerHour, BoxSettings.MaxDeviceFaultMaxPerHour),
        new("walk_up_max_minutes", TenantSettingsView.DefaultWalkUpMaxMinutes, 1, RelayHardCap.Minutes),
        new("heartbeat_seconds", TenantSettingsView.DefaultHeartbeatSeconds, HeartbeatCadence.MinSeconds, HeartbeatCadence.MaxSeconds),
        new("activation_forward_window_minutes", TenantSettingsView.DefaultActivationForwardWindowMinutes, 1, TenantSettingsView.MaxActivationForwardWindowMinutes),
        new("activation_cue_window_minutes", TenantSettingsView.DefaultActivationCueWindowMinutes, 0, TenantSettingsView.MaxActivationCueWindowMinutes),
        new("qr_lifetime_seconds", TenantSettingsView.DefaultQrLifetimeSeconds, 15, 3600),
        new("roster_window_minutes", TenantSettingsView.DefaultRosterWindowMinutes, TenantSettingsView.MinRosterWindowMinutes, TenantSettingsView.MaxRosterWindowMinutes),
        new("gate_unlock_seconds", TenantSettingsView.DefaultGateUnlockSeconds, GateAccess.MinUnlockSeconds, GateAccess.MaxUnlockSeconds),
        new("gate_early_entry_minutes", TenantSettingsView.DefaultGateEarlyEntryMinutes, 0, GateAccess.MaxEarlyEntryMinutes),
        new("device_alert_cooldown_minutes", TenantSettingsView.DefaultDeviceAlertCooldownMinutes, TenantSettingsView.MinDeviceAlertCooldownMinutes, TenantSettingsView.MaxDeviceAlertCooldownMinutes),
    ];

    /// <summary>
    /// An existing validator's bare <c>"&lt;key&gt;_out_of_range"</c> code, in the shape §5 fixes for
    /// every box and device setting — with the bounds, so the console can say what IS accepted.
    /// A code for a key not in this table comes back as it was.
    /// </summary>
    public static object Refusal(string error)
    {
        const string suffix = "_out_of_range";
        if (!error.EndsWith(suffix, StringComparison.Ordinal)) return new { error };
        var key = error[..^suffix.Length];
        var setting = LegacyInts.Concat(V3Ints).FirstOrDefault(s => s.Key == key);
        return setting is null ? new { error } : OutOfRange(setting);
    }

    /// <summary>
    /// The <c>bounds</c> object the settings GET serves: <c>{"&lt;key&gt;": {"min": n, "max": n}}</c>
    /// for every number, <c>{"values": [...]}</c> for the layout. Keyed in snake_case, as the GET is.
    /// </summary>
    public static Dictionary<string, object> Bounds()
    {
        var bounds = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var s in LegacyInts.Concat(V3Ints)) bounds[s.Key] = new { min = s.Min, max = s.Max };
        bounds[LcdLayoutKey] = new { values = Layouts };
        foreach (var c in TextChoices) bounds[c.Key] = new { values = c.Values };
        foreach (var c in IntChoices) bounds[c.Key] = new { values = c.Values };
        return bounds;
    }

    // ---- Readers: clamped, each independently ----

    public static int Value(TenantSettingsView s, IntSetting setting) => setting.Clamp(s.Device.Raw(setting));

    /// <summary>The club's layout, compact for anything not exactly one of the two (§5: compact on any doubt).</summary>
    public static string ClubLayout(TenantSettingsView s) => NormaliseLayout(s.Device.LcdLayout);

    public static string NormaliseLayout(string? layout) => layout == Expanded ? Expanded : Compact;

    public static bool ClubMarquee(TenantSettingsView s) => s.Device.LcdMarqueeEnabled;

    /// <summary>This board's layout: its own override, else the club's (§5, resolved before sending).</summary>
    public static string LayoutFor(Domain.Device device, TenantSettingsView s) =>
        device.LcdLayoutOverride is not null ? NormaliseLayout(device.LcdLayoutOverride) : ClubLayout(s);

    public static bool MarqueeFor(Domain.Device device, TenantSettingsView s) =>
        device.LcdMarqueeOverride ?? ClubMarquee(s);

    // ---- Reading the stored document ----

    /// <summary>The raw v3 values out of a settings document — "what the column says", as the accessor's contract is.</summary>
    public static DeviceSettingsRaw Read(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return DeviceSettingsRaw.Defaults;
        var layout = root.TryGetProperty(LcdLayoutKey, out var l) && l.ValueKind == JsonValueKind.String ? l.GetString() ?? Compact : Compact;
        var marquee = root.TryGetProperty(LcdMarqueeEnabledKey, out var m) && m.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? m.GetBoolean()
            : DefaultMarqueeEnabled;
        var ints = StoredInts.ToDictionary(key => key, key => ReadInt(root, key), StringComparer.Ordinal);
        var texts = TextChoices.ToDictionary(c => c.Key, c => ReadText(root, c), StringComparer.Ordinal);
        return new DeviceSettingsRaw(layout, marquee, ints, texts);
    }

    private static int ReadInt(JsonElement root, string key)
    {
        return root.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : DefaultOf(key);
    }

    private static string ReadText(JsonElement root, TextChoice c)
    {
        return root.TryGetProperty(c.Key, out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() ?? c.Default : c.Default;
    }

    // ---- The settings PUT ----

    /// <summary>A refusal in the shape §5 fixes: <c>{"error": "&lt;key&gt;_out_of_range", "min": n, "max": n}</c>.</summary>
    public static object OutOfRange(IntSetting s)
    {
        return new { error = $"{s.Key}_out_of_range", min = s.Min, max = s.Max };
    }

    /// <summary>
    /// Validates the v3 keys a PUT carries, under either spelling, and returns the writes to make
    /// (omitted means unchanged) — or the refusal payload for the first bad one.
    /// </summary>
    public static (Dictionary<string, JsonElement> Writes, object? Refusal) Parse(IReadOnlyDictionary<string, JsonElement>? extra)
    {
        var writes = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        if (extra is null || extra.Count == 0) return (writes, null);
        var refusal = ParseDisplay(extra, writes) ?? ParseChoices(extra, writes) ?? ParseRanges(extra, writes);
        return (writes, refusal);
    }

    private static object? ParseDisplay(IReadOnlyDictionary<string, JsonElement> extra, Dictionary<string, JsonElement> writes)
    {
        if (Find(extra, LcdLayoutKey) is { } layout)
        {
            if (layout.ValueKind != JsonValueKind.String || !Layouts.Contains(layout.GetString()))
            {
                return new { error = $"{LcdLayoutKey}_invalid", values = Layouts };
            }
            writes[LcdLayoutKey] = layout.Clone();
        }

        if (Find(extra, LcdMarqueeEnabledKey) is { } marquee)
        {
            if (marquee.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return new { error = $"{LcdMarqueeEnabledKey}_invalid" };
            writes[LcdMarqueeEnabledKey] = marquee.Clone();
        }
        return null;
    }

    private static object? ParseChoices(IReadOnlyDictionary<string, JsonElement> extra, Dictionary<string, JsonElement> writes)
    {
        foreach (var c in TextChoices)
        {
            if (Find(extra, c.Key) is not { } text) continue;
            if (text.ValueKind != JsonValueKind.String || !c.Allows(text.GetString())) return new { error = $"{c.Key}_invalid", values = c.Values };
            writes[c.Key] = text.Clone();
        }

        foreach (var c in IntChoices)
        {
            if (Find(extra, c.Key) is not { } number) continue;
            if (number.ValueKind != JsonValueKind.Number || !number.TryGetInt32(out var n) || !c.Allows(n)) return new { error = $"{c.Key}_invalid", values = c.Values };
            writes[c.Key] = number.Clone();
        }
        return null;
    }

    private static object? ParseRanges(IReadOnlyDictionary<string, JsonElement> extra, Dictionary<string, JsonElement> writes)
    {
        foreach (var s in V3Ints)
        {
            if (Find(extra, s.Key) is not { } value) continue;
            if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var n) || n < s.Min || n > s.Max) return OutOfRange(s);
            writes[s.Key] = value.Clone();
        }
        return null;
    }

    /// <summary>The value under <paramref name="snake"/> or its camelCase spelling; snake wins when both arrive. Null when absent or JSON null.</summary>
    private static JsonElement? Find(IReadOnlyDictionary<string, JsonElement> extra, string snake)
    {
        if (extra.TryGetValue(snake, out var v) && v.ValueKind != JsonValueKind.Null) return v;
        return extra.TryGetValue(CamelOf(snake), out var c) && c.ValueKind != JsonValueKind.Null ? c : null;
    }

    /// <summary><c>lcd_marquee_step_ms</c> → <c>lcdMarqueeStepMs</c>.</summary>
    public static string CamelOf(string snake)
    {
        var parts = snake.Split('_');
        return parts[0] + string.Concat(parts.Skip(1).Select(p => p.Length == 0 ? p : char.ToUpperInvariant(p[0]) + p[1..]));
    }

    /// <summary>The clamped v3 values for the settings GET, in the §5 order, after the 2.x box keys.</summary>
    public static IEnumerable<KeyValuePair<string, object>> Render(TenantSettingsView s)
    {
        yield return new(LcdLayoutKey, ClubLayout(s));
        yield return new(LcdMarqueeEnabledKey, ClubMarquee(s));
        foreach (var setting in V3Ints) yield return new(setting.Key, Value(s, setting));
        yield return new(HwRelayActiveLevel.Key, HwRelayActiveLevel.Resolve(s.Device.Raw(HwRelayActiveLevel)));
        yield return new(HwLcdI2cAddress.Key, HwLcdI2cAddress.Resolve(s.Device.Raw(HwLcdI2cAddress)));
        yield return new(HwScannerBaud.Key, HwScannerBaud.Resolve(s.Device.Raw(HwScannerBaud)));
        yield return new(HwScannerLineEnd.Key, HwScannerLineEnd.Resolve(s.Device.Raw(HwScannerLineEnd)));
    }

    /// <summary>
    /// The v3 keys of a <c>hb:3</c> box's heartbeat <c>config</c>, in the wire's order (§5): the
    /// twelve display keys, then the five hardware keys — each RESOLVED for this board (its own
    /// override, else the club's), each clamped or closed-set independently. <c>button_map</c>
    /// follows them, written by the caller.
    /// </summary>
    public static IEnumerable<KeyValuePair<string, object>> HeartbeatConfig(Domain.Device device, TenantSettingsView s)
    {
        yield return new(LcdLayoutKey, LayoutFor(device, s));
        yield return new(LcdMarqueeEnabledKey, MarqueeFor(device, s));
        foreach (var setting in HeartbeatInts) yield return new(setting.Key, Value(s, setting));
        yield return new(HwRelayActiveLevel.Key, HwRelayActiveLevel.Resolve(device.HwRelayActiveLevel ?? s.Device.Raw(HwRelayActiveLevel)));
        yield return new(HwLcdI2cAddress.Key, HwLcdI2cAddress.Resolve(device.HwLcdI2cAddress ?? s.Device.Raw(HwLcdI2cAddress)));
        yield return new(HwScannerBaud.Key, HwScannerBaud.Resolve(device.HwScannerBaud ?? s.Device.Raw(HwScannerBaud)));
        yield return new(HwScannerLineEnd.Key, HwScannerLineEnd.Resolve(device.HwScannerLineEnd ?? s.Device.Raw(HwScannerLineEnd)));
        yield return new(HwScannerGapMs.Key, device.HwScannerGapMs.HasValue ? HwScannerGapMs.Clamp(device.HwScannerGapMs.Value) : Value(s, HwScannerGapMs));
    }
}
