using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// D2: what a member's groups add up to for money and for the peak window — "most restrictive
/// rules for multi-group (min rate; peak only if all groups grant)". The pure rule first, then
/// the two readers that must agree on it (the booking path and the grid), on the in-memory host.
/// </summary>
public class MemberTariffsTests
{
    private static TariffGroup G(string name, decimal? rate, bool peak, int sort = 0, string? key = null)
        => new(Guid.NewGuid(), name, key, rate, peak, sort);

    [Fact]
    public void A_member_in_no_group_tops_up_at_the_club_default_and_has_no_peak_priority()
    {
        var t = MemberTariffs.Resolve([], 1.6m);

        Assert.Equal(1.6m, t.TopUpRate);
        Assert.Null(t.RateGroup);
        // "All groups grant" is vacuously true of none; read that way it would hand peak
        // priority to every member nobody has classified. The empty set is NO.
        Assert.False(t.PeakPriority);
        Assert.Empty(t.PeakWithheldBy);
        Assert.Equal("Regular", t.LegacyMemberClass);
    }

    [Fact]
    public void The_lowest_rate_any_group_sets_wins_and_a_group_with_no_rate_has_no_opinion()
    {
        var league = G("League", 2.4m, peak: true, sort: 0, key: MemberGroupSystemKeys.League);
        var coaching = G("Coaching", 2.0m, peak: true, sort: 1);
        var juniors = G("Juniors", null, peak: true, sort: 2);

        var t = MemberTariffs.Resolve([league, coaching, juniors], 1.6m);

        Assert.Equal(2.0m, t.TopUpRate);
        Assert.Equal(coaching, t.RateGroup);

        // A rate-less group never drags a member back to the club default.
        var onlyLeagueAndJuniors = MemberTariffs.Resolve([league, juniors], 1.6m);
        Assert.Equal(2.4m, onlyLeagueAndJuniors.TopUpRate);
        Assert.Equal(league, onlyLeagueAndJuniors.RateGroup);

        // A group that sets a rate REPLACES the default for its members — even a higher default.
        Assert.Equal(2.4m, MemberTariffs.Resolve([league], 3.0m).TopUpRate);
    }

    [Fact]
    public void Tied_rates_name_the_group_first_in_the_clubs_own_order()
    {
        var second = G("Beta", 2.0m, peak: false, sort: 5);
        var first = G("Zulu", 2.0m, peak: false, sort: 1);

        Assert.Equal(first, MemberTariffs.Resolve([second, first], 1.6m).RateGroup);
    }

    [Fact]
    public void Peak_priority_needs_every_group_and_the_refusal_names_the_ones_withholding_it()
    {
        var league = G("League", 2.4m, peak: true, key: MemberGroupSystemKeys.League);
        var coaching = G("Coaching", null, peak: false, sort: 1);

        Assert.True(MemberTariffs.Resolve([league], 1.6m).PeakPriority);

        var both = MemberTariffs.Resolve([league, coaching], 1.6m);
        Assert.False(both.PeakPriority);
        Assert.Equal(["Coaching"], both.PeakWithheldBy);
        // The deprecated field follows the league group, not the peak answer.
        Assert.Equal("LeagueOrSenior", both.LegacyMemberClass);
    }

    /// <summary>
    /// The deprecated <c>member_class</c> is membership of the LEAGUE group — not "has a better
    /// rate" and not "has peak priority": a coaching group with its own rate and priority is
    /// still a Regular member to a template written before D2.
    /// </summary>
    [Fact]
    public void The_deprecated_class_is_the_league_group_and_nothing_else()
    {
        var coaching = G("Coaching", 2.8m, peak: true);

        var t = MemberTariffs.Resolve([coaching], 1.6m);

        Assert.Equal(2.8m, t.TopUpRate);
        Assert.True(t.PeakPriority);
        Assert.Equal("Regular", t.LegacyMemberClass);
    }

    // ---- the two readers, on the in-memory host -------------------------------------------

    private static async Task<MemberGroup> AddGroupAsync(
        TestHost host, MainframeDbContext db, string name, decimal? rate, bool peak, bool archived = false)
    {
        var group = new MemberGroup
        {
            TenantId = host.Tenant.Id,
            Name = name,
            CreditsPerZar = rate,
            PeakPriority = peak,
            SortOrder = 5,
            Status = archived ? MemberGroupStatus.Archived : MemberGroupStatus.Active,
        };
        db.MemberGroups.Add(group);
        db.MemberGroupMembers.Add(new MemberGroupMember
        {
            TenantId = host.Tenant.Id,
            GroupId = group.Id,
            UserId = host.LeaguePlayerUser.Id,
            AddedByUserId = host.AdminUser.Id,
        });
        await db.SaveChangesAsync();
        return group;
    }

    /// <summary>
    /// A league member an admin also puts in a group that does not grant peak loses the
    /// priority — on the booking path AND on the grid, which must never paint a cell the
    /// booking would refuse.
    /// </summary>
    [Fact]
    public async Task A_group_withholding_peak_binds_the_booking_and_the_grid_alike()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        var schedule = scope.ServiceProvider.GetRequiredService<ScheduleService>();
        await ledger.PostAsync(new LedgerPosting(host.LeaguePlayerUser.Id, LedgerEntryType.TopUp, 200m, host.LeaguePlayerUser.Id), default);

        await AddGroupAsync(host, db, "Coaching", rate: null, peak: false);

        var tomorrowPeak = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(2).AddHours(17), TimeSpan.Zero);
        var refused = Assert.IsType<BookingResult.PeakHoursPriorityOnly>(await booking.CreateAsync(
            host.Courts[0].Id, host.LeaguePlayerUser.Id, host.LeaguePlayerUser.Id, tomorrowPeak, 1, default));
        Assert.Equal(["Coaching"], refused.WithheldByGroups);

        var day = await schedule.GetDayAsync(DateOnly.FromDateTime(tomorrowPeak.UtcDateTime), host.LeaguePlayerUser.Id, default);
        Assert.False(day.ViewerMayBookPeak);
    }

    /// <summary>An ARCHIVED group contributes neither a rate nor a peak refusal.</summary>
    [Fact]
    public async Task An_archived_group_contributes_nothing_to_the_tariff()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var s = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

        await AddGroupAsync(host, db, "Old promo", rate: 1.0m, peak: false, archived: true);

        var t = await MemberTariffs.ForAsync(db, host.LeaguePlayerUser.Id, s, default);
        Assert.Equal(TestHost.LeagueCreditsPerZar, t.TopUpRate);
        Assert.True(t.PeakPriority);
    }

    /// <summary>
    /// <c>member_groups_enabled</c> turns off the booking RESTRICTIONS groups add, not the tariff
    /// the member class used to carry: a club that switches restrictions off must not silently
    /// move every league member to the regular rate or out of the peak window.
    /// </summary>
    [Fact]
    public async Task Switching_group_restrictions_off_leaves_the_league_tariff_in_force()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.TenantSettings.FirstAsync(x => x.TenantId == host.Tenant.Id);
        row.SettingsJson = row.SettingsJson.TrimEnd('}') + ",\"member_groups_enabled\":false}";
        await db.SaveChangesAsync();

        var s = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        Assert.False(s.MemberGroupsEnabled);

        var t = await MemberTariffs.ForAsync(db, host.LeaguePlayerUser.Id, s, default);
        Assert.Equal(TestHost.LeagueCreditsPerZar, t.TopUpRate);
        Assert.True(t.PeakPriority);
    }
}
