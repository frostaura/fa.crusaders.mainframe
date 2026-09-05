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
    /// Flattens the event envelope into a string-keyed dictionary.
    ///
    /// <para>
    /// Top-level scalar fields are available by their own name — <c>{id}</c>, <c>{type}</c>,
    /// <c>{tenant_id}</c>, <c>{tenant_slug}</c>, <c>{occurred_at}</c>,
    /// <c>{occurred_at_unix}</c> — and everything inside the <c>data</c> object by its short
    /// name, so <c>{court_number}</c> and <c>{booking_id}</c> resolve on the events that
    /// carry them and are a config error on the events that do not.
    /// </para>
    ///
    /// <para>
    /// <c>{event_id}</c> and <c>{event_type}</c> are aliases of <c>{id}</c> and
    /// <c>{type}</c>. Both were promised — here and in <c>docs/specs/webhooks.md</c>, under
    /// "always present, regardless of event" — and neither existed (original review A2-16):
    /// the envelope's fields have always been <c>id</c> and <c>type</c>, so a club that
    /// followed the documentation got a delivery refused as a missing variable, which is a
    /// config error and deliberately not retryable, so their endpoint simply stopped.
    /// Aliasing rather than renaming, because <c>id</c> and <c>type</c> are on the wire in
    /// every body delivered so far and in every signature computed over one.
    /// </para>
    ///
    /// <para>
    /// <c>actor</c> and <c>subject</c> are objects and are NOT flattened, so there is no
    /// <c>{user_id}</c> from the envelope — only from <c>data</c>, on events that carry one.
    /// The doc claimed otherwise; it was wrong in the same way and is not aliased, because
    /// two different user ids in one envelope have no single right answer.
    /// </para>
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

        // TryAdd, after everything: a `data.event_id` on some future event is that event's
        // own and must win over the alias.
        if (dict.TryGetValue("id", out var eventId)) dict.TryAdd("event_id", eventId);
        if (dict.TryGetValue("type", out var eventType)) dict.TryAdd("event_type", eventType);

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
