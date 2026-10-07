using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The validation half of preferences, without a database — what a write may contain and how
/// a stored row reads back.
/// </summary>
public sealed class UserPreferencesRulesTests
{
    [Theory]
    [InlineData("dark", "dark")]
    [InlineData(" Light ", "light")]
    [InlineData("SYSTEM", "system")]
    [InlineData("sepia", null)]
    [InlineData("", null)]
    public void A_theme_is_one_of_three_after_trimming_and_lower_casing(string raw, string? expected)
        => Assert.Equal(expected, UserPreferencesRules.NormaliseTheme(raw));

    [Theory]
    [InlineData("welcome", "welcome")]
    [InlineData(" book-a-court ", "book-a-court")]
    [InlineData("wallet.top_up:2", "wallet.top_up:2")]
    [InlineData(null, null)]
    [InlineData("   ", null)]
    [InlineData("two words", null)]
    [InlineData("-leading-dash", null)]
    public void A_step_is_a_slug_or_nothing(string? raw, string? expected)
        => Assert.Equal(expected, UserPreferencesRules.NormaliseStep(raw));

    [Fact]
    public void A_step_one_character_past_the_limit_is_refused_and_one_at_it_is_kept()
    {
        Assert.NotNull(UserPreferencesRules.NormaliseStep(new string('a', UserPreferencesRules.MaxStepLength)));
        Assert.Null(UserPreferencesRules.NormaliseStep(new string('a', UserPreferencesRules.MaxStepLength + 1)));
    }

    [Fact]
    public void Opt_outs_are_trimmed_and_deduplicated_in_order()
    {
        var (kinds, error) = UserPreferencesRules.NormaliseOptouts([" device.offline", "member.registered", "device.offline"]);

        Assert.Null(error);
        Assert.Equal(["device.offline", "member.registered"], kinds);
    }

    [Theory]
    [InlineData("Device.Offline")]
    [InlineData("device offline")]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("9lives")]
    public void An_opt_out_that_is_not_a_kind_identifier_refuses_the_whole_list(string? bad)
    {
        var (kinds, error) = UserPreferencesRules.NormaliseOptouts(["device.offline", bad]);

        Assert.Null(kinds);
        Assert.Equal(UserPreferencesRules.InvalidNotificationKind, error);
    }

    [Fact]
    public void The_opt_out_cap_counts_distinct_kinds_not_entries()
    {
        var atCap = Enumerable.Range(0, UserPreferencesRules.MaxOptouts).Select(i => (string?)$"k.n{i}").ToList();
        Assert.Null(UserPreferencesRules.NormaliseOptouts([.. atCap, .. atCap]).Error);

        var overCap = Enumerable.Range(0, UserPreferencesRules.MaxOptouts + 1).Select(i => (string?)$"k.n{i}").ToList();
        Assert.Equal(UserPreferencesRules.TooManyOptouts, UserPreferencesRules.NormaliseOptouts(overCap).Error);
    }

    [Theory]
    [InlineData("""["a.b","c"]""", 2)]
    [InlineData("[]", 0)]
    [InlineData("", 0)]
    [InlineData("""{"not":"an array"}""", 0)]
    [InlineData("not json", 0)]
    public void A_stored_opt_out_list_reads_back_or_reads_as_none(string json, int count)
        => Assert.Equal(count, UserPreferencesRules.ReadOptouts(json).Count);

    [Fact]
    public void No_row_reads_as_findable_every_other_privacy_flag_off_and_the_system_theme()
    {
        var view = UserPreferencesView.From(null);

        Assert.Equal("system", view.Theme);
        Assert.True(view.Findable);
        Assert.False(view.ShowInLeaderboards);
        Assert.False(view.RatingOptIn);
        Assert.False(view.WeeklyRecap);
        Assert.Null(view.UpdatedAt);
        Assert.Equal(UserPreferences.CurrentOnboardingVersion, view.CurrentOnboardingVersion);
    }
}
