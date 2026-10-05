using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 14, D14-5: the box's greeting line. A hard cut that ended on a space sent a
/// trailing blank the glass printed ("ABCDEFGHIJKLMNO "), and a generational suffix was taken for
/// the surname ("ROBERTA J" for Roberta Smithson Jr., "JOSE-ANTONIO J" for … da Silva Júnior).
/// </summary>
public class R14MemberDisplayTests
{
    [Theory]
    [InlineData("Abcdefghijklmno Pqr", "ABCDEFGHIJKLMNO")]
    [InlineData("Abcdefghijklmno-Pqrst Uvw", "ABCDEFGHIJKLMNO-")]
    [InlineData("Abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOP")]
    public void A_hard_cut_never_ends_on_a_space(string full, string expected)
    {
        var shown = MemberDisplay.Shorten(full);
        Assert.Equal(expected, shown);
        Assert.False(shown!.EndsWith(' '), $"'{shown}' ends on a space");
    }

    [Theory]
    [InlineData("Roberta Smithson Jr.", "ROBERTA S")]
    [InlineData("Robertalina Smithson Jr.", "ROBERTALINA S")]
    [InlineData("Robertalina Smithson Jr", "ROBERTALINA S")]
    [InlineData("Robertalina Smithson Sr.", "ROBERTALINA S")]
    [InlineData("José-Antônio da Silva Júnior", "JOSE-ANTONIO S")]
    [InlineData("José-Antônio da Silva Junior", "JOSE-ANTONIO S")]
    [InlineData("Joaquim Pereira de Souza Filho", "JOAQUIM S")]
    [InlineData("Joaquim Pereira de Souza Neto", "JOAQUIM S")]
    [InlineData("Wilhelmina Vanderbilt III", "WILHELMINA V")]
    [InlineData("Wilhelmina Vanderbilt II", "WILHELMINA V")]
    [InlineData("Wilhelmina Vanderbilt IV", "WILHELMINA V")]
    [InlineData("Wilhelmina Vanderbilt jr.", "WILHELMINA V")]
    public void A_generational_suffix_is_not_the_surname(string full, string expected)
    {
        Assert.Equal(expected, MemberDisplay.Shorten(full));
    }

    /// <summary>Varied: a name whose only later word IS a suffix keeps the old rule rather than inventing a surname.</summary>
    [Fact]
    public void A_name_that_is_all_suffix_after_the_first_word_still_fits()
    {
        var shown = MemberDisplay.Shorten("Maximilianopolis Junior");
        Assert.NotNull(shown);
        Assert.True(shown!.Length <= MemberDisplay.MaxLength);
        Assert.False(shown.EndsWith(' '));
        Assert.All(shown, c => Assert.InRange(c, ' ', '}'));
    }
}
