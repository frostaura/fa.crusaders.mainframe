using System.Globalization;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The two quantities this product states, rendered the one way they are allowed to be rendered.
///
/// <para>
/// <b>It exists because the rule kept being re-implemented at the call site, and the call site
/// kept getting it wrong.</b> Every figure this system shows a member is either <b>credits</b> —
/// the unit of account — or <b>money</b>, which is what they handed the gateway. Both must be
/// written with a dot, on every host, for two independent reasons: PayFast rejects the club's
/// own <c>en-ZA</c> comma decimal outright, and a member reconciling a wallet history against a
/// bank statement must not meet the same amount spelled two ways on two adjacent lines.
/// </para>
///
/// <para>
/// That is not hypothetical either. <c>BookingService</c>'s lights-release reason was built with
/// a bare <c>{back:0.00}</c>, which takes <see cref="CultureInfo.CurrentCulture"/> — so on the
/// club's own locale, the DEFAULT case rather than an exotic one, it wrote "8,00 credits" on a
/// statement whose every other row said "8.00 credits". It was the last raw interpolation of its
/// kind in the project, and the answer to "why did only that one drift" is that it was the only
/// one that had to remember. Nothing here has to remember: there is one format string per
/// quantity and it lives in this file only.
/// </para>
///
/// <para>
/// <see cref="Email.EmailTemplates"/>'s <c>Cr</c>, <c>Zar</c> and <c>Num</c> are thin wrappers
/// over these, kept because a template reads better for having them and because they are where
/// the unit rules are argued. <b>They are wrappers and not copies</b> — duplicating the format
/// string in the email layer and the service layer is precisely how the two halves came apart.
/// </para>
/// </summary>
public static class MoneyFormat
{
    /// <summary>The invariant rendering of any figure this product calls an amount.</summary>
    /// <remarks>
    /// Private, and the only place the string "0.00" appears. Everything below is a unit
    /// attached to this.
    /// </remarks>
    private static string Amount(decimal value) => value.ToString("0.00", CultureInfo.InvariantCulture);

    /// <summary>
    /// A credit figure, with its unit — "8.00 credits".
    /// </summary>
    /// <remarks>
    /// The word is spelled out rather than suffixed "cr", because this string is read in prose:
    /// in a ledger reason, in an email fact row, and in a sentence about a balance. Credits take
    /// <b>no</b> currency symbol, ever — see <see cref="CurrencySymbol"/> for why that is a
    /// money-correctness rule and not a copy preference.
    /// </remarks>
    public static string Credits(decimal value) => Amount(value) + " credits";

    /// <summary>
    /// Real money, in the club's own symbol — "R100.00", "-R50.00", "CHF1234567.89".
    /// </summary>
    /// <remarks>
    /// The symbol PRECEDES the amount, which forces a choice a trailing unit never did: the sign
    /// goes OUTSIDE it. "-R50.00" is how a negative amount of money is written; "R-50.00" reads
    /// as a symbol followed by a malformed number. The symbol is required rather than defaulted,
    /// so a new money surface cannot silently print a rand sign to a club that does not take
    /// rand — the compiler asks the author where the club's symbol came from.
    /// </remarks>
    public static string Money(decimal value, string symbol) =>
        (value < 0 ? "-" : "") + symbol + Amount(Math.Abs(value));

    /// <summary>A number with no trailing-zero noise, for percentages and conversion rates.</summary>
    public static string Number(decimal value) => value.ToString("0.####", CultureInfo.InvariantCulture);
}
