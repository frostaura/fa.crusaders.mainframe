using System.Text.Json;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>One field that changed, with both sides already in words.</summary>
public sealed record AdminChangeField(string Field, string Label, string? Before, string? After);

/// <summary>
/// Turns a row's stored <c>BeforeJson</c>/<c>AfterJson</c> into the sentence-shaped list a
/// volunteer admin reads.
///
/// <para>
/// <b>Rendered on the SERVER, and that is the whole point of the field.</b> The stored form of
/// a league night's start is <c>1080</c>, and an admin auditing their own club cannot be handed
/// minutes past midnight and asked to divide. The same argument the refusal messages already
/// carry — "every refusal carries the figures its sentence needs, so the client never has to
/// compose a number" — applied to the record.
/// </para>
///
/// <para>
/// <b>Changed keys only, because that is what the writers store.</b> A whole-document
/// before/after on every settings save makes the record unreadable and stores the same thirty
/// keys a hundred times. The diff below is therefore over the union of the two objects' keys
/// and does not need the rest of the document to decide what moved.
/// </para>
/// </summary>
public static class AdminChangeDiff
{
    /// <summary>Minutes in a day, the ceiling a minutes-past-midnight field may carry.</summary>
    private const int MinutesPerDay = 1440;

    private static readonly string[] WeekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    /// <summary>
    /// Every field that differs between the two stored objects, in the order the "after" object
    /// declares them, with anything only in "before" appended.
    ///
    /// <para>
    /// A malformed or absent document yields an empty list rather than throwing: this is a READ
    /// of a table that is never deleted, so a row written by an older version of the code must
    /// still render. A record that 500s on its own oldest rows is not a record.
    /// </para>
    /// </summary>
    public static IReadOnlyList<AdminChangeField> Of(string? beforeJson, string? afterJson)
    {
        var before = Parse(beforeJson);
        var after = Parse(afterJson);
        if (before.Count == 0 && after.Count == 0) return [];

        var fields = new List<AdminChangeField>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var (key, value) in after)
        {
            seen.Add(key);
            before.TryGetValue(key, out var previous);
            var renderedBefore = Render(key, previous);
            var renderedAfter = Render(key, value);
            if (renderedBefore != renderedAfter)
            {
                fields.Add(new AdminChangeField(key, Label(key), renderedBefore, renderedAfter));
            }
        }

        foreach (var (key, value) in before)
        {
            if (seen.Contains(key)) continue;
            var renderedBefore = Render(key, value);
            if (renderedBefore is not null)
            {
                fields.Add(new AdminChangeField(key, Label(key), renderedBefore, null));
            }
        }

        return fields;
    }

    private static Dictionary<string, JsonElement> Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object) return [];
            return document.RootElement.EnumerateObject()
                .ToDictionary(p => p.Name, p => p.Value.Clone(), StringComparer.Ordinal);
        }
        catch (JsonException)
        {
            return [];
        }
    }

    /// <summary>
    /// The field's name as a person writes it: <c>start_minute</c> becomes "Start".
    ///
    /// <para>
    /// The <c>_minute</c>/<c>_minutes</c> suffix is dropped because the VALUE beside it already
    /// says "18:00" or "20 minutes" — "Start minute: 18:00" reads as a mistake.
    /// </para>
    /// </summary>
    public static string Label(string field)
    {
        var name = field;
        if (name.EndsWith("_minute", StringComparison.Ordinal)) name = name[..^"_minute".Length];
        var words = name.Replace('_', ' ').Trim();
        return words.Length == 0 ? field : char.ToUpperInvariant(words[0]) + words[1..];
    }

    /// <summary>
    /// One stored value in words, or null when the field was not set.
    ///
    /// <para>
    /// Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    public static string? Render(string field, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Undefined:
            case JsonValueKind.Null:
                return null;
            case JsonValueKind.True:
                return "yes";
            case JsonValueKind.False:
                return "no";
            case JsonValueKind.String:
                return value.GetString();
            case JsonValueKind.Array:
                return string.Join(", ", value.EnumerateArray().Select(e => Render(field, e) ?? "—"));
            case JsonValueKind.Object:
                return value.GetRawText();
        }

        return value.ValueKind == JsonValueKind.Number ? Number(field, value) : value.GetRawText();
    }

    /// <summary>
    /// A NUMBER in the words its field name implies — <c>start_minute</c> as a clock,
    /// <c>*_minutes</c> as a duration, <c>days_of_week</c> as weekday names.
    ///
    /// <para>
    /// Split out of <see cref="Render"/> because the two do different jobs: that one decides
    /// what KIND of value this is, this one decides what a number MEANS here. Keeping them in
    /// one method put both decisions past the complexity gate and made either harder to read.
    /// </para>
    /// </summary>
    private static string? Number(string field, JsonElement value)
    {
        if (field.EndsWith("_minute", StringComparison.Ordinal)
            && value.TryGetInt32(out var minute) && minute is >= 0 and <= MinutesPerDay)
        {
            // 1440 is the end of the day, and "24:00" is what a club means by it — rendering
            // it as 00:00 would put a league night's end before its start on screen.
            return minute == MinutesPerDay ? "24:00" : $"{minute / 60:D2}:{minute % 60:D2}";
        }

        if (field.EndsWith("_minutes", StringComparison.Ordinal) && value.TryGetInt32(out var span))
        {
            return span == 1 ? "1 minute" : $"{span} minutes";
        }

        if (field is "days_of_week" && value.TryGetInt32(out var mask) && mask is > 0 and < 128)
        {
            return string.Join(", ", Enumerable.Range(0, 7)
                .Where(d => (mask & (1 << d)) != 0)
                .Select(d => WeekdayNames[d]));
        }

        return value.GetRawText();
    }

    private static string? Render(string field, JsonElement? value)
        => value is { } element ? Render(field, element) : null;
}
