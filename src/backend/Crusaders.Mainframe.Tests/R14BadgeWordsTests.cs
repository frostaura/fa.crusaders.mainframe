using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 14, J14-11: the first-result badge is earned by the first CONFIRMED result a member
/// played in — whichever side recorded it (<see cref="BadgeRules"/>). Its description said
/// "Recorded your first match result.", which is false for the player who only confirmed the
/// opponent's score. One badge, worded true for both.
/// </summary>
public sealed class R14BadgeWordsTests
{
    [Fact]
    public void The_first_result_badge_is_true_for_the_player_who_confirmed_it()
    {
        var badge = BadgeCatalogue.Find(BadgeCatalogue.FirstResult)!;

        Assert.Equal("On the record", badge.Name);
        Assert.Equal("Your first match result is on the record.", badge.Description);
        Assert.DoesNotContain("Recorded", badge.Description, StringComparison.OrdinalIgnoreCase);
    }
}
