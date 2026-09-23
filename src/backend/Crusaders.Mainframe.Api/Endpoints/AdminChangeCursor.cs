namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// A page boundary in the change record: the instant and the id of the last row returned.
///
/// <para>
/// Keyed on <c>(OccurredAt, Id)</c>, which is exactly what <see cref="AdminChangeQuery.Apply"/>
/// orders by. Opaque on the wire so a console cannot construct one and cannot come to depend on
/// its shape, and a malformed one is a <c>400</c> rather than a silent page one — a console
/// that truncated a cursor would otherwise get page one back labelled as page nine.
/// </para>
/// </summary>
public sealed record AdminChangeCursor(DateTimeOffset At, Guid Id)
{
    public string Encode()
        => Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes($"{At.UtcTicks}:{Id:N}"));

    public static AdminChangeCursor? Parse(string? encoded)
    {
        if (string.IsNullOrWhiteSpace(encoded)) return null;
        try
        {
            var parts = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(encoded)).Split(':');
            if (parts.Length != 2) return null;
            if (!long.TryParse(parts[0], out var ticks) || !Guid.TryParseExact(parts[1], "N", out var id)) return null;

            // A well-formed number is not a representable instant. Negative or past year 9999
            // made the DateTimeOffset constructor throw ArgumentOutOfRangeException, which the
            // catch below did not name — a crafted cursor was a 500, not cursor_invalid.
            if (ticks < DateTimeOffset.MinValue.UtcTicks || ticks > DateTimeOffset.MaxValue.UtcTicks) return null;
            return new AdminChangeCursor(new DateTimeOffset(ticks, TimeSpan.Zero), id);
        }
        catch (FormatException)
        {
            return null;
        }
    }
}
