using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The settings PUT hears a snake-case-only key under its camelCase spelling too (pass 2, the
/// "2.x box settings camelCase" finding).
///
/// <para>
/// <b>Why.</b> <see cref="UpdateSettingsRequest"/> binds about seventy keys under
/// <c>[JsonPropertyName("snake_case")]</c> alone — the box's screen timings, the scan memory, the
/// clock trust, the fault cap and every key added since. A client that spelled one of them
/// camelCase (<c>lcdRevertSeconds</c>) was answered <c>{"saved": true}</c> and nothing changed:
/// the key fell into <see cref="UpdateSettingsRequest.Extra"/>, which only the v3 device reader
/// looks at. That is the silent no-op <c>Opening_the_settings_page_and_saving_it_changes_nothing</c>
/// exists to prevent, so every snake-only key now binds under both spellings, the rule the
/// door and admin keys already follow.
/// </para>
///
/// <para>
/// <b>Derived, not listed.</b> The table is read off the record by reflection, once: a key added
/// to the record snake-only is heard camelCase the day it lands, with nothing to remember. Two
/// spellings that disagree in one body are refused (<c>setting_spelled_twice</c>) rather than
/// one silently winning; the same value under both — what the console sends — is one value.
/// </para>
/// </summary>
public static class SettingsSpelling
{
    /// <summary>The refusal when one body carries a key under both spellings with different values.</summary>
    public const string SpelledTwice = "setting_spelled_twice";

    /// <summary>Each snake-only key, by its camelCase spelling (case-insensitive, as the web binder is).</summary>
    private static readonly Dictionary<string, (string Snake, PropertyInfo Property)> ByCamel = Build();

    /// <summary>How many keys bind under their snake spelling only — what a test holds the table to.</summary>
    public static int SnakeOnlyKeyCount => ByCamel.Count;

    /// <summary>The camelCase spelling of a snake_case key: <c>lcd_revert_seconds</c> → <c>lcdRevertSeconds</c>.</summary>
    public static string CamelOf(string snake)
    {
        var parts = snake.Split('_', StringSplitOptions.RemoveEmptyEntries);
        return parts[0] + string.Concat(parts.Skip(1).Select(p => char.ToUpperInvariant(p[0]) + p[1..]));
    }

    /// <summary>
    /// The request with every camelCase spelling of a snake-only key adopted, or a refusal. The
    /// adopted key stays in <c>Extra</c> too; nothing else reads a key the record already holds.
    /// </summary>
    public static (UpdateSettingsRequest Request, object? Refusal) Adopt(UpdateSettingsRequest req)
    {
        if (req.Extra is not { Count: > 0 } extra) return (req, null);
        UpdateSettingsRequest? copy = null;
        foreach (var (key, element) in extra)
        {
            if (!ByCamel.TryGetValue(key, out var target)) continue;
            object? value;
            try
            {
                value = element.Deserialize(target.Property.PropertyType, JsonSerializerOptions.Web);
            }
            catch (JsonException)
            {
                return (req, new { error = $"{target.Snake}_invalid" });
            }
            var bound = target.Property.GetValue(copy ?? req);
            if (bound is not null)
            {
                if (JsonSerializer.Serialize(bound, JsonSerializerOptions.Web) != JsonSerializer.Serialize(value, JsonSerializerOptions.Web)) return (req, new { error = SpelledTwice, key = target.Snake, spelling = key });
                continue;
            }
            copy ??= req with { };
            target.Property.SetValue(copy, value);
        }
        return (copy ?? req, null);
    }

    private static Dictionary<string, (string, PropertyInfo)> Build()
    {
        var properties = typeof(UpdateSettingsRequest).GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.CanWrite && p.GetIndexParameters().Length == 0)
            .ToList();
        // The name the web binder hears each property under: its attribute, else its camelCase name.
        var heard = new HashSet<string>(
            properties.Select(p => p.GetCustomAttribute<JsonPropertyNameAttribute>()?.Name ?? JsonNamingPolicy.CamelCase.ConvertName(p.Name)),
            StringComparer.OrdinalIgnoreCase);
        var table = new Dictionary<string, (string, PropertyInfo)>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in properties)
        {
            if (p.GetCustomAttribute<JsonPropertyNameAttribute>()?.Name is not { } snake || !snake.Contains('_')) continue;
            var camel = CamelOf(snake);
            if (heard.Contains(camel)) continue; // a camelCase twin already binds it
            table[camel] = (snake, p);
        }
        return table;
    }
}
