using System.Text.Json;
using System.Text.RegularExpressions;

namespace Crusaders.Mainframe.Api.Webhooks;

/// <summary>
/// Single-brace placeholder substitution. <c>{name}</c> tokens in the template are looked up
/// against the event payload's flattened keys (top-level + everything under <c>data</c>).
/// Values are URL-encoded. Literal braces in the URL must be percent-encoded as <c>%7B</c> / <c>%7D</c>.
/// </summary>
public static class UrlTemplate
{
    private static readonly Regex Placeholder = new(@"\{([a-zA-Z_][a-zA-Z0-9_\.]*)\}", RegexOptions.Compiled);

    public sealed record RenderResult(bool Ok, string? Url, string? MissingVariable);

    public static IReadOnlyList<string> Variables(string template)
    {
        var seen = new HashSet<string>();
        foreach (Match m in Placeholder.Matches(template))
            if (m.Groups[1].Success) seen.Add(m.Groups[1].Value);
        return seen.ToArray();
    }

    public static RenderResult Render(string template, JsonElement eventEnvelope)
    {
        var values = Flatten(eventEnvelope);
        string? missing = null;
        var rendered = Placeholder.Replace(template, m =>
        {
            var key = m.Groups[1].Value;
            if (values.TryGetValue(key, out var v)) return Uri.EscapeDataString(v);
            missing ??= key;
            return m.Value;
        });
        return missing is null ? new(true, rendered, null) : new(false, null, missing);
    }

    /// <summary>
    /// Flattens the event envelope into a string-keyed dictionary. Top-level scalar fields are
    /// available by their name; everything inside the <c>data</c> object is also available by its
    /// short name. So <c>{event_id}</c>, <c>{tenant_slug}</c>, <c>{court_number}</c>, <c>{user_id}</c>
    /// all resolve from a standard envelope.
    /// </summary>
    private static Dictionary<string, string> Flatten(JsonElement root)
    {
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var prop in root.EnumerateObject())
        {
            if (prop.NameEquals("data") && prop.Value.ValueKind == JsonValueKind.Object)
            {
                foreach (var inner in prop.Value.EnumerateObject())
                    if (TryStringValue(inner.Value, out var s)) dict[inner.Name] = s;
            }
            else if (TryStringValue(prop.Value, out var s)) dict[prop.Name] = s;
        }
        return dict;
    }

    private static bool TryStringValue(JsonElement el, out string s)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.String: s = el.GetString() ?? ""; return true;
            case JsonValueKind.Number: s = el.GetRawText(); return true;
            case JsonValueKind.True: s = "true"; return true;
            case JsonValueKind.False: s = "false"; return true;
            default: s = ""; return false;
        }
    }
}
