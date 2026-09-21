namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The one number an admin bulk action is bounded by, read once and clamped on the way out.
///
/// <para>
/// <b>Same rule as <see cref="DoorSettings"/>, and this is the sharpest case of it after the
/// retention cutoff.</b> A batch is an amplification factor: every item takes a payer advisory
/// lock and a GiST index write, and the booking routes carry no per-user rate limiter of their
/// own (only the global 600-per-minute per-IP bucket). A hand-edited <c>admin_bulk_max_items</c>
/// of 50 000 is therefore not a big form, it is one request holding fifty thousand locks. The
/// PUT bounds it; this clamps it again, because the PUT is not the only way a value reaches the
/// column.
/// </para>
/// </summary>
public static class BulkSettings
{
    /// <summary>
    /// A hundred items. A league book-out is four courts by a season's worth of Tuesdays, and a
    /// grid multi-select an admin can actually read runs to a few dozen.
    /// </summary>
    public const int DefaultMaxItems = 100;

    /// <summary>One. A club that wants bulk actions off has no switch, and zero would be one.</summary>
    public const int MinMaxItems = 1;

    /// <summary>Five hundred, past which one request is a denial of service on the club's own booking table.</summary>
    public const int MaxMaxItems = 500;

    /// <summary>Longest idempotency key accepted, matching the credit-adjust endpoint's.</summary>
    public const int MaxIdempotencyKeyLength = 200;

    /// <summary>Longest reason a batch may carry.</summary>
    public const int MaxReasonLength = 512;

    /// <summary>Longest free-text guest name. The same ceiling <c>BlockLabel</c> has, because that is where it lands.</summary>
    public const int MaxGuestNameLength = 128;

    /// <summary>Longest admin note beside a real member's booking. Matches <c>bookings.AdminNote</c>.</summary>
    public const int MaxNoteLength = 128;

    /// <summary>Most items this club's bulk actions accept, clamped to the range its own PUT declares.</summary>
    public static int MaxItems(TenantSettingsView settings)
        => Math.Clamp(settings.AdminBulkMaxItems, MinMaxItems, MaxMaxItems);
}
