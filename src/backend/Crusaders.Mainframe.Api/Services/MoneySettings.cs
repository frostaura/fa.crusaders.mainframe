namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The bounds on the settings that decide what a member is CHARGED, named once and enforced
/// twice — on the settings PUT, and again here when a stored value is read.
///
/// <para>
/// <b>D2-B06 is why this type exists.</b> <c>slice_price_credits</c> was a required positional
/// on the settings request, written unconditionally, and touched by none of the five
/// validators. The court POST refuses a negative price and then falls back to this setting
/// when the caller omits one — so <c>slicePriceCredits: -500</c> answered <c>{"saved":true}</c>
/// and produced a court on which <b>every booking credited the member</b>. It was the one money
/// key on that endpoint with no bound at all.
/// </para>
///
/// <para>
/// Bounding it on the PUT alone would not be enough, for the reason <see cref="DoorSettings"/>
/// already records: the PUT is not the only way a number reaches the column. A restore from a
/// backup taken before the bound existed, a migration, or an admin with psql all bypass it.
/// So the reader floors it too, and the two numbers are the same constants rather than two
/// literals that can drift.
/// </para>
/// </summary>
public static class MoneySettings
{
    /// <summary>A court may be free. It may not be worse than free.</summary>
    public const decimal MinSlicePriceCredits = 0m;

    /// <summary>
    /// The largest price the ledger column can hold. <c>ledger_entries.AmountCredits</c> is
    /// <c>numeric(10,2)</c>, so a slice priced above this cannot be debited at all — the save
    /// fails with a Postgres 22003 rather than refusing the booking.
    /// </summary>
    public const decimal MaxSlicePriceCredits = 99_999_999.99m;

    /// <summary>
    /// The tenant's default court price, as the reader will actually use it: clamped into
    /// range, and rounded to the cents the ledger stores.
    /// </summary>
    public static decimal SlicePriceCredits(TenantSettingsView settings)
        => decimal.Round(
            Math.Clamp(settings.DefaultSlicePriceCredits, MinSlicePriceCredits, MaxSlicePriceCredits),
            2, MidpointRounding.AwayFromZero);

    /// <summary>
    /// Whether a price is expressible in whole cents — the same test the admin credit
    /// adjustment applies, for the same reason: credits are counted in cents and a price that
    /// is not a whole number of them is rounded by the column and then disagrees with every
    /// figure quoted back to the member.
    /// </summary>
    public static bool IsWholeCents(decimal value)
        => decimal.Round(value, 2, MidpointRounding.AwayFromZero) == value;
}
