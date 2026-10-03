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
        // Folding first: "É" is one column, so the initial is "E", never a lone combining mark.
        Assert.Equal("PRIYA E", MemberDisplay.Shorten("Priya Éloïse-Naidoo van der Berg"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void No_name_on_file_is_still_no_field(string? full)
    {
        Assert.Null(MemberDisplay.Shorten(full));
    }
}
