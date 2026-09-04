using System.Globalization;
using System.Text.Json;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// What each physical button on a court box does.
///
/// <para>
/// The box has eight buttons wired to fixed pins, and the wiring cannot change —
/// it is screwed into a cupboard and the club is not rewiring it. What the buttons
/// <i>mean</i>, though, is a decision the club changes its mind about: which four
/// select courts, which four select durations, whether one of them turns a court
/// off instead. So the meaning is a tenant setting and the firmware learns it on
/// the heartbeat, rather than a <c>constexpr</c> that needs a person with a laptop
/// standing at the box.
/// </para>
///
/// <para>
/// <b>The index is the physical button, always.</b> Position 0 is the button on
/// pin 22 whatever it now does. That is what makes remapping meaningful: an admin
/// who swaps courts A and C is changing two entries, not rewiring anything, and
/// the firmware needs no notion of which button "should" be a court.
/// </para>
/// </summary>
public abstract record ButtonAction
{
    /// <summary>Nothing. A button the club has decided not to use.</summary>
    public sealed record None : ButtonAction;

    /// <summary>Select a court, 0-3 for A-D.</summary>
    public sealed record SelectCourt(int CourtIndex) : ButtonAction;

    /// <summary>Ask for this many minutes on the selected court.</summary>
    public sealed record GrantMinutes(int Minutes) : ButtonAction;

    /// <summary>Release the selected court early.</summary>
    public sealed record TurnOff : ButtonAction;

    /// <summary>
    /// The wire form: <c>court:A</c>, <c>minutes:45</c>, <c>off</c>, <c>none</c>.
    ///
    /// <para>
    /// Strings rather than a nested object because this crosses to a device with no
    /// JSON parser worth the flash. A short token an 8-bit part can compare with
    /// <c>memcmp</c> is worth more here than a shape that reads well in a browser.
    /// </para>
    /// </summary>
    public string ToWire() => this switch
    {
        SelectCourt c => $"court:{(char)('A' + c.CourtIndex)}",
        GrantMinutes m => $"minutes:{m.Minutes.ToString(CultureInfo.InvariantCulture)}",
        TurnOff => "off",
        _ => "none",
    };
}

/// <summary>
/// The eight-entry map, parsed and validated.
/// </summary>
public sealed class ButtonMap
{
    /// <summary>Physical buttons on a court box. Fixed by the wiring.</summary>
    public const int ButtonCount = 8;

    /// <summary>The longest court time a single button may grant, as a guard rail.
    /// Not a policy — a club that wants three hours can set 180 — but a typo that
    /// reads 6000 would leave a court's lights on for four days.</summary>
    public const int MaxGrantMinutes = 240;

    /// <summary>Relays on a court box: A–D. A box drives at most this many courts.</summary>
    public const int MaxCourtsPerBox = 4;

    /// <summary>
    /// The error an admin is shown when the button map and a box's court list disagree,
    /// from whichever screen they were editing. One constant, because the same
    /// contradiction is refused from two places and a UI matching on the string must
    /// not have to know which one raised it.
    /// </summary>
    public const string SelectsCourtBeyondDeviceCourts = "button_map_selects_court_beyond_device_courts";

    public IReadOnlyList<ButtonAction> Actions { get; }

    private ButtonMap(IReadOnlyList<ButtonAction> actions) => Actions = actions;

    /// <summary>
    /// The wiring's original meaning: courts A-D, then 15/30/45/60 minutes.
    ///
    /// <para>
    /// Chosen so a club that never touches this setting gets exactly what the
    /// hand-built box already did. A default that differed would silently change
    /// the behaviour of every box on the first deploy.
    /// </para>
    /// </summary>
    public static ButtonMap Default() => new(new ButtonAction[]
    {
        new ButtonAction.SelectCourt(0),
        new ButtonAction.SelectCourt(1),
        new ButtonAction.SelectCourt(2),
        new ButtonAction.SelectCourt(3),
        new ButtonAction.GrantMinutes(15),
        new ButtonAction.GrantMinutes(30),
        new ButtonAction.GrantMinutes(45),
        new ButtonAction.GrantMinutes(60),
    });

    /// <summary>
    /// Reads the map out of the settings document, falling back to
    /// <see cref="Default"/> for anything missing or malformed.
    ///
    /// <para>
    /// Lenient on read and strict on write, deliberately. A settings document that
    /// somebody hand-edited into nonsense must not stop every court box in the club
    /// from working; <see cref="TryParse"/> is where a bad map is refused, at the
    /// point an admin is standing there to be told.
    /// </para>
    /// </summary>
    public static ButtonMap FromSettings(JsonElement root)
    {
        if (!root.TryGetProperty("button_map", out var value) || value.ValueKind != JsonValueKind.Array)
        {
            return Default();
        }

        var wire = new List<string>(ButtonCount);
        foreach (var element in value.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.String) return Default();
            wire.Add(element.GetString() ?? "none");
        }

        return TryParse(wire, out var map, out _) ? map! : Default();
    }

    /// <summary>
    /// Validates a proposed map. <paramref name="error"/> names the first problem in
    /// a form an admin screen can show.
    /// </summary>
    public static bool TryParse(IReadOnlyList<string> wire, out ButtonMap? map, out string? error)
    {
        map = null;
        error = null;

        if (wire.Count != ButtonCount)
        {
            error = $"button_map must have exactly {ButtonCount} entries, one per physical button";
            return false;
        }

        var actions = new ButtonAction[ButtonCount];
        for (var i = 0; i < ButtonCount; i++)
        {
            if (!TryParseAction(wire[i], out var action, out var reason))
            {
                error = $"button {i + 1}: {reason}";
                return false;
            }
            actions[i] = action!;
        }

        // A map with no way to choose a court cannot start a walk-up, and a map with
        // no duration cannot finish one. Both are almost certainly a half-finished
        // edit rather than an intention, and both leave the box's buttons inert.
        if (!actions.Any(a => a is ButtonAction.SelectCourt))
        {
            error = "at least one button must select a court";
            return false;
        }
        if (!actions.Any(a => a is ButtonAction.GrantMinutes))
        {
            error = "at least one button must grant minutes";
            return false;
        }

        map = new ButtonMap(actions);
        return true;
    }

    private static bool TryParseAction(string? wire, out ButtonAction? action, out string? reason)
    {
        action = null;
        reason = null;
        var text = (wire ?? string.Empty).Trim();

        if (text.Length == 0 || string.Equals(text, "none", StringComparison.OrdinalIgnoreCase))
        {
            action = new ButtonAction.None();
            return true;
        }
        if (string.Equals(text, "off", StringComparison.OrdinalIgnoreCase))
        {
            action = new ButtonAction.TurnOff();
            return true;
        }

        if (text.StartsWith("court:", StringComparison.OrdinalIgnoreCase))
        {
            var letter = text["court:".Length..].Trim().ToUpperInvariant();
            if (letter.Length != 1 || letter[0] < 'A' || letter[0] > 'D')
            {
                reason = "court must be A, B, C or D";
                return false;
            }
            action = new ButtonAction.SelectCourt(letter[0] - 'A');
            return true;
        }

        if (text.StartsWith("minutes:", StringComparison.OrdinalIgnoreCase))
        {
            var digits = text["minutes:".Length..].Trim();
            if (!int.TryParse(digits, NumberStyles.None, CultureInfo.InvariantCulture, out var minutes)
                || minutes < 1 || minutes > MaxGrantMinutes)
            {
                reason = $"minutes must be between 1 and {MaxGrantMinutes}";
                return false;
            }
            action = new ButtonAction.GrantMinutes(minutes);
            return true;
        }

        reason = "expected court:<A-D>, minutes:<n>, off or none";
        return false;
    }

    public IReadOnlyList<string> ToWire() => Actions.Select(a => a.ToWire()).ToList();

    /// <summary>
    /// The first court index a <see cref="ButtonAction.SelectCourt"/> button names that a
    /// box driving <paramref name="courtCount"/> courts has no relay for — or null when
    /// every court button lands on a wired court.
    ///
    /// <para>
    /// The map and a device's court list are edited on different admin screens, and a
    /// <c>court:C</c> button on a box whose list has two entries is a button that selects
    /// nothing. Refused at write time from <i>both</i> screens — saving the map is
    /// checked against every box, and assigning a box its courts is checked against the
    /// current map — because that is the moment a human is present to be told. The
    /// heartbeat, which used to log a warning for this, now sends a pair it can trust.
    /// </para>
    /// </summary>
    public int? FirstSelectionBeyond(int courtCount)
    {
        foreach (var action in Actions)
        {
            if (action is ButtonAction.SelectCourt c && c.CourtIndex >= courtCount) return c.CourtIndex;
        }
        return null;
    }
}
