using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The name a court box prints is printable ASCII (R11 D11-1). The HD44780 shows its own ROM
/// glyphs for any byte past 0x7E and the bridge counts a two-byte UTF-8 letter as two columns,
/// so "ZOË NEL" arrived as "ZO" + two garbage cells + " NEL" and pushed the line one column long.
/// </summary>
public class MemberDisplayTests
{
    [Theory]
    [InlineData("Zoë Nel", "ZOE NEL")]
    [InlineData("André du Toit", "ANDRE DU TOIT")]
    [InlineData("René Müller", "RENE MULLER")]
    [InlineData("Ñandú Peña", "NANDU PENA")]
    [InlineData("Søren Æbelø", "SOREN AEBELO")]
    [InlineData("Straße Łukasz", "STRASSE LUKASZ")]
    [InlineData("Ava 🎾 Smith", "AVA SMITH")]
    [InlineData("  Cleo   O’Brien ", "CLEO O'BRIEN")]
    public void A_name_is_folded_to_printable_ascii(string full, string expected)
    {
        Assert.Equal(expected, MemberDisplay.Shorten(full));
    }

    [Theory]
    [InlineData("Zoë Nel")]
    [InlineData("Ñandú Peña-Villaseñor de la Fuente")]
    [InlineData("🎾🎾🎾")]
    [InlineData("李小龍")]
    [InlineData("Ava 🎾 Smith")]
    public void Every_character_sent_to_the_box_is_printable_ascii_and_fits(string full)
    {
        var shown = MemberDisplay.Shorten(full);

        Assert.False(string.IsNullOrWhiteSpace(shown));
        Assert.All(shown!, c => Assert.InRange(c, ' ', '~'));
        Assert.InRange(shown!.Length, 1, MemberDisplay.MaxLength);
        Assert.DoesNotContain("  ", shown);
    }

    /// <summary>A name with nothing printable left is a member, not a blank line.</summary>
    [Theory]
    [InlineData("🎾🎾🎾")]
    [InlineData("李小龍")]
    public void A_name_with_nothing_printable_falls_back_to_a_safe_word(string full)
    {
        Assert.Equal(MemberDisplay.Fallback, MemberDisplay.Shorten(full));
    }

    [Fact]
    public void A_long_accented_name_is_folded_before_it_is_initialled()
    {
        // Folding first: "Ø" is one column, so the initial is "O", never a lone combining mark.
        // R12 D12-1: the initial is the LAST word's — the surname, "Berg" of "van der Berg".
        Assert.Equal("PRIYA B", MemberDisplay.Shorten("Priya Éloïse-Naidoo van der Berg"));
        Assert.Equal("THANDIWE O", MemberDisplay.Shorten("Thandiwe Nomvula Ørsted"));
    }

    /// <summary>
    /// Review round 12, D12-1. On the panel's A00 ROM <c>\</c> is a yen sign and <c>~</c> an arrow,
    /// and the bridge stored <c>"</c> as an escape the LCD printed — <c>THABO \"</c>,
    /// <c>KIM LEE\\PARK</c>. A double quote of either shape is an apostrophe; a backslash or a
    /// tilde separates words; and the initial is a LETTER, never the punctuation a nickname opens with.
    /// </summary>
    [Theory]
    [InlineData("Thabo \u201CTJ\u201D Mokoena", "THABO M")]
    [InlineData("Thabo \"TJ\" Ng", "THABO 'TJ' NG")]
    [InlineData("Kim Lee\\Park", "KIM LEE PARK")]
    [InlineData("Ana~Maria Vos", "ANA MARIA VOS")]
    [InlineData("Thabo (TJ) Mokoena", "THABO M")]
    [InlineData("Nomvuzo Thandeka 'Mokoena'", "NOMVUZO M")]
    public void Quotes_backslashes_and_tildes_never_reach_the_panel_and_the_initial_is_a_letter(string full, string expected)
    {
        var shown = MemberDisplay.Shorten(full);

        Assert.Equal(expected, shown);
        Assert.DoesNotContain('"', shown!);
        Assert.DoesNotContain('\\', shown!);
        Assert.DoesNotContain('~', shown!);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void No_name_on_file_is_still_no_field(string? full)
    {
        Assert.Null(MemberDisplay.Shorten(full));
    }

    // ---- the court box's greeting_name: the first name only ------------------------------------

    [Theory]
    [InlineData("Olga Organiser", "OLGA")]
    [InlineData("  Zoë   Nel ", "ZOE")]
    [InlineData("Søren Æbelø", "SOREN")]
    [InlineData("Straße Łukasz", "STRASSE")]
    [InlineData("Mary-Jane Watson", "MARY-JANE")]
    [InlineData("O’Brien Kelly", "O'BRIEN")]
    [InlineData("🎾 Ava Smith", "AVA")]                 // a glyph the panel cannot print is not the first word
    [InlineData("Kim\\Lee Park", "KIM")]                // a backslash separates words, as in Shorten
    [InlineData("Ana~Maria Vos", "ANA")]
    [InlineData("Cher", "CHER")]
    public void The_greeting_is_the_first_word_folded_to_upper_case_ascii(string full, string expected)
    {
        Assert.Equal(expected, MemberDisplay.FirstName(full));
    }

    [Fact]
    public void A_first_name_longer_than_the_line_is_cut_to_the_cap()
    {
        var shown = MemberDisplay.FirstName("Wolfeschlegelsteinhausen Bergerdorff");

        Assert.Equal(MemberDisplay.MaxLength, shown.Length);
        Assert.Equal("WOLFESCHLEGELSTE", shown);
        Assert.Equal("ABCDEFGHIJKLMNOP", MemberDisplay.FirstName("abcdefghijklmnop Q"));   // exactly the cap is kept whole
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("🎾🎾🎾")]
    [InlineData("李小龍")]
    public void No_printable_first_name_is_an_empty_greeting_never_null(string? full)
    {
        Assert.Equal("", MemberDisplay.FirstName(full));
    }

    [Theory]
    [InlineData("Zoë Nel")]
    [InlineData("Ñandúvillaseñorinhoço Peña")]
    [InlineData("Thabo “TJ” Mokoena")]
    [InlineData("\"Quoted\" Name")]
    public void Every_greeting_character_is_printable_ascii_and_fits(string full)
    {
        var shown = MemberDisplay.FirstName(full);

        Assert.All(shown, c => Assert.InRange(c, ' ', '}'));
        Assert.DoesNotContain(' ', shown);
        Assert.DoesNotContain('"', shown);
        Assert.InRange(shown.Length, 1, MemberDisplay.MaxLength);
        Assert.Equal(shown.ToUpperInvariant(), shown);
    }
}
