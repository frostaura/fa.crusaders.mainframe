namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The five Wave 1 door numbers and strings, read once and bounded on the way out.
///
/// <para>
/// <b>Why a type rather than five properties.</b> <c>door-gate.md</c> §8 states the rule this
/// whole tree runs on — <i>every number a door reads is bounded on the PUT and clamped again
/// on the way out</i> — because the PUT is not the only way a value reaches the settings
/// column; a hand-edited document is. <see cref="BookingCodeWindow"/> is the same type for the
/// same reason, and it exists because the door's horizon and the member's phone had drifted
/// into two independent copies of one piece of arithmetic. These five have three readers
/// between them (the club log, the tile's signals, the member's page) and one of them is the
/// retention cutoff a background worker DELETES rows against — which is the strongest possible
/// argument for the number being read in exactly one place.
/// </para>
///
/// <para>
/// <b>The two strings are clamped too, and that is not pedantry.</b> They are rendered to a
/// member who has been refused at a door in the dark, and they are printed on a door card that
/// goes on a wall. A 4 000-character "phone number" out of a hand-edited column is a page that
/// cannot be read on a phone; truncation is the bound the PUT declares, applied again where the
/// value is used. Blank becomes null, because "the club has set no contact" and "the club has
/// set an empty one" are the same fact to the person standing outside.
/// </para>
/// </summary>
public static class DoorSettings
{
    /// <summary>
    /// How long a club keeps its door rows. Ninety days: long enough to answer "nobody could
    /// get in through the side door all last month" and short enough that a club is not
    /// holding a two-year, member-identified record of everyone's comings and goings, which is
    /// what <c>audit_log</c>'s <c>retention_years</c> alone left it holding
    /// (<c>door-gate.md</c> §6's residual).
    /// </summary>
    public const int DefaultLogRetentionDays = 90;

    /// <summary>A week. Below that a club cannot answer a question about last weekend.</summary>
    public const int MinLogRetentionDays = 7;

    /// <summary>Two years. The ceiling is <c>retention_years</c>' own default, expressed in days.</summary>
    public const int MaxLogRetentionDays = 730;

    /// <summary>Refusals at one door inside the window before the door is flagged. Eight.</summary>
    public const int DefaultRefusalSpikeCount = 8;

    /// <summary>Three. Below that a club with a stiff door flags on ordinary retries.</summary>
    public const int MinRefusalSpikeCount = 3;

    /// <summary>A hundred, past which the flag would never fire at a racquet club's volume.</summary>
    public const int MaxRefusalSpikeCount = 100;

    /// <summary>The window those refusals are counted in. Twenty minutes.</summary>
    public const int DefaultRefusalSpikeMinutes = 20;

    /// <summary>Five minutes. Shorter than that and the flag is noise from one confused visitor.</summary>
    public const int MinRefusalSpikeMinutes = 5;

    /// <summary>Four hours, the same ceiling every other door window carries.</summary>
    public const int MaxRefusalSpikeMinutes = 240;

    /// <summary>Longest club contact phone accepted. Generous for an international number with extension.</summary>
    public const int MaxContactPhoneLength = 32;

    /// <summary>Longest club contact email accepted — the RFC's own address ceiling.</summary>
    public const int MaxContactEmailLength = 254;

    /// <summary>The club's door-log retention, in days, clamped to the range its own PUT declares.</summary>
    public static int LogRetentionDays(TenantSettingsView settings)
        => Math.Clamp(settings.DoorLogRetentionDays, MinLogRetentionDays, MaxLogRetentionDays);

    /// <summary>How many refusals at one door raise the spike flag, clamped.</summary>
    public static int RefusalSpikeCount(TenantSettingsView settings)
        => Math.Clamp(settings.DoorRefusalSpikeCount, MinRefusalSpikeCount, MaxRefusalSpikeCount);

    /// <summary>The window those refusals are counted in, minutes, clamped.</summary>
    public static int RefusalSpikeMinutes(TenantSettingsView settings)
        => Math.Clamp(settings.DoorRefusalSpikeMinutes, MinRefusalSpikeMinutes, MaxRefusalSpikeMinutes);

    /// <summary>The club's contact phone, trimmed and bounded, or null when it has set none.</summary>
    public static string? ContactPhone(TenantSettingsView settings)
        => Bounded(settings.ClubContactPhone, MaxContactPhoneLength);

    /// <summary>The club's contact email, trimmed and bounded, or null when it has set none.</summary>
    public static string? ContactEmail(TenantSettingsView settings)
        => Bounded(settings.ClubContactEmail, MaxContactEmailLength);

    /// <summary>
    /// A stored string as a reader should see it: trimmed, cut to the length the PUT declares,
    /// and null when there is nothing left. Block body for the lizard reason in
    /// <c>memory/gotchas.md</c>.
    /// </summary>
    private static string? Bounded(string? stored, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(stored)) return null;

        var trimmed = stored.Trim();
        return trimmed.Length <= maxLength ? trimmed : trimmed[..maxLength];
    }
}
