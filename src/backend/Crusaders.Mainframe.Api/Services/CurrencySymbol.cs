using System.Globalization;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The club's currency symbol — what it governs, and the one thing it deliberately does not.
///
/// <para>
/// <b>The decision, stated here because this is where it has to hold.</b> The owner asked for
/// the <c>cr</c> suffix to be replaced by a configurable symbol that precedes the amount,
/// defaulting to <c>R</c>. This product renders two different quantities and only one of them
/// is money:
/// </para>
///
/// <list type="bullet">
///   <item><b>Rand</b> — what a member hands PayFast for a package, what the desk takes over the
///     counter, the revenue report's net. This IS money, and this is its symbol.</item>
///   <item><b>Minutes</b> — the wallet balance and what a booking costs (P13). Minutes are the
///     unit of account (<c>CLAUDE.md</c>); a minutes figure wearing a money sign is a
///     money-correctness bug, not a copy choice, and minutes are written in words or
///     <c>45 min</c>, never with a currency symbol (<see cref="MoneyFormat"/>).</item>
/// </list>
///
/// <para>
/// <b>So this symbol reaches rand and stops there.</b> Before P13 the second unit was a
/// rand-denominated token at a conversion rate, and every money email once printed a rand sign
/// over it — the overstatement was the rate itself. Minutes made the rule easier to keep, not
/// unnecessary.
/// </para>
///
/// <para>
/// Unrecognised values fall back to the default rather than failing closed: unlike a door
/// policy this decides a GLYPH. A club with a typo in this key gets a rand sign and a working
/// screen, not a screen it cannot use.
/// </para>
/// </summary>
public static class CurrencySymbol
{
    /// <summary>The settings key.</summary>
    public const string Key = "currency_symbol";

    /// <summary>The rand sign. The club is in Durban North, KwaZulu-Natal.</summary>
    public const string Default = "R";

    /// <summary>
    /// A symbol, not an essay.
    ///
    /// <para>
    /// Four characters covers every symbol in circulation — <c>R</c>, <c>R$</c>, <c>CHF</c>,
    /// <c>US$</c>, <c>zł</c> — and the bound is not cosmetic: this string is interpolated into
    /// an HTML email body and sits beside figures on screens whose layout is already
    /// width-constrained.
    /// </para>
    /// </summary>
    public const int MaxLength = 4;

    /// <summary>
    /// Whether a value is one the product can put in front of an amount.
    ///
    /// <para>
    /// Letters and currency signs only. <b>That is what makes the value safe to interpolate
    /// into an HTML email body with no escaping step</b> — no angle bracket, no ampersand, no
    /// quote and no control character survives it. Digits are refused too, so <c>R50</c>
    /// cannot be saved as a symbol and then printed in front of another number.
    /// </para>
    ///
    /// <para>
    /// Only the ENDS are packaging: leading and trailing whitespace is trimmed, because a
    /// pasted value carries whatever came with it and the owner wrote the setting as
    /// <c>"R "</c>, with the space that separates it from the amount. Whitespace INSIDE is not
    /// a symbol and is refused, or <c>"R X"</c> saves and prints as a symbol with a hole in it.
    /// </para>
    /// </summary>
    public static bool IsAcceptable(string? value)
    {
        var trimmed = value?.Trim();
        if (string.IsNullOrEmpty(trimmed) || trimmed.Length > MaxLength) return false;

        foreach (var c in trimmed)
        {
            if (!char.IsLetter(c) && CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.CurrencySymbol)
                return false;
        }
        return true;
    }

    /// <summary>The symbol a club will actually get, for a raw stored value — or the default.</summary>
    public static string Sanitise(string? value) => IsAcceptable(value) ? value!.Trim() : Default;

    /// <summary>The symbol a club will actually get.</summary>
    public static string For(TenantSettingsView settings) => Sanitise(settings.CurrencySymbol);
}
