using System.Globalization;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The two quantities this product states, rendered the one way they are allowed to be rendered.
///
/// <para>
/// <b>It exists because the rule kept being re-implemented at the call site, and the call site
/// kept getting it wrong.</b> Every figure this system shows a member is either <b>minutes</b> —
/// the unit of account since P13 (<c>docs/specs/minutes-and-packages.md</c> §7.2) — or
/// <b>money</b>, which is what they handed the gateway. Money must be written with a dot, on every
/// host, for two independent reasons: PayFast rejects the club's own <c>en-ZA</c> comma decimal
/// outright, and a member reconciling a wallet history against a bank statement must not meet
/// the same amount spelled two ways on two adjacent lines.
/// </para>
///
/// <para>
/// That is not hypothetical either. <c>BookingService</c>'s lights-release reason was once built
/// with a bare <c>{back:0.00}</c>, which takes <see cref="CultureInfo.CurrentCulture"/> — so on
/// the club's own locale it wrote a comma decimal on a statement whose every other row used a
/// dot. Nothing here has to remember: there is one rendering per quantity and it lives in this
/// file only.
/// </para>
///
/// <para>
/// <see cref="Email.EmailTemplates"/>' unit helpers and <c>Zar</c> are thin wrappers over these,
/// kept because a template reads better for having them. <b>They are wrappers and not
/// copies</b> — duplicating the rendering in the email layer and the service layer is precisely
/// how the two halves came apart.
/// </para>
/// </summary>
public static class MoneyFormat
{
    private const int MinutesPerHour = 60;
    private const int MinutesPerDay = 1440;

    /// <summary>The invariant rendering of any rand figure. The only place "0.00" appears.</summary>
    private static string Amount(decimal value) => value.ToString("0.00", CultureInfo.InvariantCulture);

    /// <summary>
    /// Minutes in prose, for emails, receipts and ledger reasons: "45 minutes", "1 minute",
    /// "1 hour 30 minutes", "2 hours", "1 day 6 hours 15 minutes", "0 minutes", "−45 minutes".
    /// </summary>
    /// <remarks>
    /// Days from 1 440 upward, zero parts left out, exact — it never rounds. A negative value gets
    /// ONE real minus sign (U+2212) on the whole figure, the sign every screen prints. Minutes
    /// never carry a currency symbol; see <see cref="CurrencySymbol"/>.
    /// </remarks>
    public static string Minutes(int n) =>
        Render(n, (" day", " days"), (" hour", " hours"), (" minute", " minutes"));

    /// <summary>
    /// Minutes in the compact form the screens use: "5 h", "45 min", "1 h 30 min", "1 d 6 h 15 min",
    /// "0 min", "−1 h 30 min". Used for the PayFast <c>item_name</c>.
    /// </summary>
    public static string MinutesCompact(int n) =>
        Render(n, (" d", " d"), (" h", " h"), (" min", " min"));

    /// <summary>
    /// The court box's <c>amount_label</c>: the whole number of minutes in invariant digits,
    /// "45", "9999". Callers check <c>0 &lt; n ≤ 9999</c> first; this only renders.
    /// </summary>
    public static string MinutesLabel(int n) => n.ToString(CultureInfo.InvariantCulture);

    private static string Render(int n, (string One, string Many) day, (string One, string Many) hour, (string One, string Many) minute)
    {
        long abs = Math.Abs((long)n);
        if (abs == 0) return "0" + minute.Many;

        var parts = new List<string>(3);
        Part(parts, abs / MinutesPerDay, day);
        Part(parts, abs % MinutesPerDay / MinutesPerHour, hour);
        Part(parts, abs % MinutesPerHour, minute);
        var text = string.Join(' ', parts);
        return n < 0 ? "−" + text : text;
    }

    private static void Part(List<string> parts, long count, (string One, string Many) unit)
    {
        if (count == 0) return;
        parts.Add(count.ToString(CultureInfo.InvariantCulture) + (count == 1 ? unit.One : unit.Many));
    }

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

    /// <summary>A number with no trailing-zero noise, for percentages.</summary>
    public static string Number(decimal value) => value.ToString("0.####", CultureInfo.InvariantCulture);
}
