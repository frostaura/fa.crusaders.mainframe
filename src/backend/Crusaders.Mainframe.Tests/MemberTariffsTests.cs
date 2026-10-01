using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// D2/P13: what a member's groups add up to for money and for the peak window — "most
/// restrictive rules for multi-group (lowest package discount; peak only if all groups grant)". The pure rule first, then
/// the two readers that must agree on it (the booking path and the grid), on the in-memory host.
/// </summary>
public class MemberTariffsTests
{
    private static TariffGroup G(string name, int? discount, bool? peak, int sort = 0, string? key = null)
        => new(Guid.NewGuid(), name, key, discount, peak, sort);

    [Fact]
    public void A_member_in_no_group_has_no_package_discount_and_no_peak_priority()
    {
        var t = MemberTariffs.Resolve([]);
        Assert.Null(t.PackageDiscountBps);
        Assert.Null(t.DiscountGroup);
        Assert.False(t.PeakPriority);
        Assert.Equal("Regular", t.LegacyMemberClass);
    }

    /// <summary>
    /// P13 §3.8: the LOWEST discount among the groups that set one wins, and a group with none
    /// (null) has no opinion — it neither takes the discount away nor counts as 0%. Mutation
    /// check (§1.4): "highest wins" makes the first assertion read 2500.
    /// </summary>
    [Fact]
    public void The_lowest_discount_any_group_sets_wins_and_a_group_with_none_has_no_opinion()
    {
        var league = G("League", 1000, peak: true, key: MemberGroupSystemKeys.League);
        var students = G("Students", 2500, peak: null, sort: 1);
        var juniors = G("Juniors", null, peak: null, sort: 2);

        var both = MemberTariffs.Resolve([students, league, juniors]);
        Assert.Equal(1000, both.PackageDiscountBps);
        Assert.Equal(league.Id, both.DiscountGroup!.Id);

        var onlyJuniors = MemberTariffs.Resolve([juniors]);
        Assert.Null(onlyJuniors.PackageDiscountBps);
        Assert.Null(onlyJuniors.DiscountGroup);

        // An explicit 0 is a say ("no discount here"), and it is the lowest.
        var zero = MemberTariffs.Resolve([league, G("Staff rate off", 0, peak: null, sort: 3)]);
        Assert.Equal(0, zero.PackageDiscountBps);
        Assert.Equal("Staff rate off", zero.DiscountGroup!.Name);
    }

    [Fact]
    public void Tied_discounts_name_the_group_first_in_the_clubs_own_order()
    {
        var b = G("Bravo", 1000, peak: null, sort: 2);
        var a = G("Alpha", 1000, peak: null, sort: 1);
        var c = G("Charlie", 1000, peak: null, sort: 1);

        var t = MemberTariffs.Resolve([b, c, a]);
        Assert.Equal(1000, t.PackageDiscountBps);
        // Sort order first, then name: Alpha (1) before Charlie (1) before Bravo (2).
        Assert.Equal("Alpha", t.DiscountGroup!.Name);
        Assert.Equal(["Alpha", "Charlie", "Bravo"], t.Groups.Select(g => g.Name));
    }

    /// <summary>
    /// Review D2-P1: a group with no say (null) neither grants nor withholds. A league member in a
    /// window-only group keeps the priority; a member whose groups ALL have no say has none; a
    /// single explicit false beats any number of grants and is the only group named.
    /// </summary>
    [Fact]
    public void A_group_with_no_say_neither_grants_nor_withholds_peak()
    {
        var league = G("League", null, peak: true, key: MemberGroupSystemKeys.League);
        var juniors = G("Juniors", null, peak: null, sort: 1);
        var coaching = G("Coaching", null, peak: false, sort: 2);
        var seniors = G("Seniors", null, peak: true, sort: 3);

        var withNoSay = MemberTariffs.Resolve([league, juniors]);
        Assert.True(withNoSay.PeakPriority);
        Assert.Empty(withNoSay.PeakWithheldBy);

        var onlyNoSay = MemberTariffs.Resolve([juniors]);
        Assert.False(onlyNoSay.PeakPriority);
        Assert.Empty(onlyNoSay.PeakWithheldBy); // nobody withheld it; nobody granted it

        var oneNo = MemberTariffs.Resolve([league, seniors, juniors, coaching]);
        Assert.False(oneNo.PeakPriority);
        Assert.Equal(["Coaching"], oneNo.PeakWithheldBy);
    }

    [Fact]
    public void Peak_priority_needs_every_group_and_the_refusal_names_the_ones_withholding_it()
    {
        var league = G("League", null, peak: true, key: MemberGroupSystemKeys.League);
        var coaching = G("Coaching", null, peak: false, sort: 1);

        Assert.True(MemberTariffs.Resolve([league]).PeakPriority);

        var both = MemberTariffs.Resolve([league, coaching]);
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
        var coaching = G("Coaching", 2000, peak: true, sort: 1);
        Assert.Equal("Regular", MemberTariffs.Resolve([coaching]).LegacyMemberClass);

        var league = G("League", null, peak: null, key: MemberGroupSystemKeys.League);
        Assert.Equal("LeagueOrSenior", MemberTariffs.Resolve([league]).LegacyMemberClass);
    }

    /// <summary>
    /// A NEW club's seeded pair: the league group grants peak at the league rate; the non-league
    /// group has NO SAY (null) — so a league member an admin also drops into it keeps the priority.
    /// </summary>
    [Fact]
    public async Task The_seeded_non_league_group_has_no_say_on_peak()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var tenantId = Guid.NewGuid();

        await MemberGroupSeeder.EnsureAsync(db, tenantId);

        var seeded = await db.MemberGroups.IgnoreQueryFilters().Where(g => g.TenantId == tenantId).ToListAsync();
        var league = Assert.Single(seeded, g => g.SystemKey == MemberGroupSystemKeys.League);
        var other = Assert.Single(seeded, g => g.SystemKey is null);
        Assert.True(league.PeakPriority);
        // P13 §4.6: League starts with no package discount; neither seeded group has a say.
        Assert.Null(league.PackageDiscountBps);
        Assert.Null(other.PackageDiscountBps);
        Assert.Null(other.PeakPriority);
        var t = MemberTariffs.Resolve([MemberTariffs.From(league), MemberTariffs.From(other)]);
        Assert.True(t.PeakPriority);
        Assert.Null(t.PackageDiscountBps);
    }

    // ---- the two readers, on the in-memory host -------------------------------------------

    private static async Task<MemberGroup> AddGroupAsync(
        TestHost host, MainframeDbContext db, string name, int? discount, bool peak, bool archived = false)
    {
        var group = new MemberGroup
        {
            TenantId = host.Tenant.Id,
            Name = name,
            PackageDiscountBps = discount,
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
        await ledger.PostAsync(new LedgerPosting(host.LeaguePlayerUser.Id, LedgerEntryType.TopUp, 200, host.LeaguePlayerUser.Id), default);

        await AddGroupAsync(host, db, "Coaching", discount: null, peak: false);

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

        await AddGroupAsync(host, db, "Promo", discount: 1500, peak: true);
        await AddGroupAsync(host, db, "Old promo", discount: 500, peak: false, archived: true);

        var t = await MemberTariffs.ForAsync(db, host.LeaguePlayerUser.Id, default);
        Assert.Equal(1500, t.PackageDiscountBps);
        Assert.Equal("Promo", t.DiscountGroup!.Name);
        Assert.True(t.PeakPriority);
        Assert.DoesNotContain(t.Groups, g => g.Name == "Old promo");
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
        var league = await db.MemberGroups.FirstAsync(g => g.SystemKey == MemberGroupSystemKeys.League);
        league.PackageDiscountBps = 1000;
        var row = await db.TenantSettings.FirstAsync(x => x.TenantId == host.Tenant.Id);
        row.SettingsJson = row.SettingsJson.TrimEnd('}') + ",\"member_groups_enabled\":false}";
        await db.SaveChangesAsync();

        var s = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        Assert.False(s.MemberGroupsEnabled);

        var t = await MemberTariffs.ForAsync(db, host.LeaguePlayerUser.Id, default);
        Assert.Equal(1000, t.PackageDiscountBps);
        Assert.True(t.PeakPriority);
    }
}
