namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The bounds on the settings that decide what a member is CHARGED, named once and enforced
/// twice — on the settings PUT, and again when a stored value is read.
///
/// <para>
/// <b>D2-B06 is why this type exists.</b> A money setting with no bound on the PUT produced a
/// court on which every booking paid the member. Bounding a setting on the PUT alone is not
/// enough, for the reason <see cref="DoorSettings"/> records: the PUT is not the only way a
/// number reaches the column — a restore, a migration or psql all bypass it.
/// </para>
///
/// <para>
/// <b>Since P13 (minutes as the unit of account) there is no price setting left to bound.</b> A booking
/// costs its length in minutes, <c>SliceMinutes × SliceCount</c>, and the slice price, its
/// bounds and the whole-cents test on it are gone (<c>docs/specs/minutes-and-packages.md</c>
/// §2.2). What remains is the rand rule the desk and the packages still need.
/// </para>
/// </summary>
public static class MoneySettings
{
    /// <summary>
    /// Whether a rand figure is expressible in whole cents. A price or an amount received that is
    /// not a whole number of cents is rounded by a <c>numeric(10,2)</c> column and then
    /// disagrees with every figure quoted back to the member.
    /// </summary>
    public static bool IsWholeCents(decimal value)
        => decimal.Round(value, 2, MidpointRounding.AwayFromZero) == value;
}
