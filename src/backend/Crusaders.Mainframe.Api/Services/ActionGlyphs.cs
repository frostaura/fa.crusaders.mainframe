namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Which pair of glyphs a confirm/decline button wears — GOAL item 12, and ruling 4.
///
/// <para>
/// <b>Thumbs by default, and the default is not a style preference.</b> The founder asked for
/// thumbs by name, the club is South African, and a thumbs-up reads there as plain agreement.
/// The audience is members and volunteer admins who are not good with technology, for whom a
/// picture of a hand is a shorter read than a tick.
/// </para>
///
/// <para>
/// <b>It does not govern destructive confirms.</b> A thumbs-up on "Delete these six bookings" is
/// the wrong affordance whichever glyph set the club runs: a destructive action wears its own
/// icon — a bin, a lock — and the danger treatment. That is the frontend's rule; this setting is
/// only the confirm/decline PAIR, and saying so here is what stops it being read as a licence.
/// </para>
///
/// <para>
/// Unrecognised values fall back to the default rather than failing closed, because unlike a
/// door policy this decides an ICON. A club with a typo in this key gets thumbs and a working
/// button, not a screen it cannot use.
/// </para>
/// </summary>
public static class ActionGlyphs
{
    /// <summary>The settings key.</summary>
    public const string Key = "action_glyphs";

    /// <summary>Thumbs up / thumbs down. The default.</summary>
    public const string Thumbs = "thumbs";

    /// <summary>A tick and a cross, for a club that prefers them.</summary>
    public const string Marks = "marks";

    /// <summary>The closed set, served in the refusal so a client never has to guess.</summary>
    public static readonly string[] All = [Thumbs, Marks];

    /// <summary>Whether a value is one the product knows how to draw.</summary>
    public static bool IsKnown(string? value) => value is Thumbs or Marks;

    /// <summary>The glyph set a club will actually get.</summary>
    // The pattern rather than a call to IsKnown: it is the same test, and it is the one the
    // compiler can see through — `settings.ActionGlyphs.Trim()` behind an IsKnown() call is a
    // CS8602 the build then carries for ever.
    public static string For(TenantSettingsView settings)
        => settings.ActionGlyphs?.Trim() is Thumbs or Marks ? settings.ActionGlyphs.Trim() : Thumbs;
}
