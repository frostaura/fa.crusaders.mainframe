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
    private static TariffGroup G(string name, int? discount, bool? peak, int sort = 0, string? key = null)
        => new(Guid.NewGuid(), name, key, discount, peak, sort);

    [Fact]
    public void A_member_in_no_group_tops_up_at_the_club_default_and_has_no_peak_priority()
    {
        // P13-B2: the top-up rate is gone; rewrite as package_discount_bps (lowest wins, null = no say, §3.8)
        Assert.Fail($"P13-B2: the top-up rate is gone; rewrite as package_discount_bps (lowest wins, null = no say, §3.8)");
    }

    [Fact]
    public void The_lowest_rate_any_group_sets_wins_and_a_group_with_no_rate_has_no_opinion()
    {
        // P13-B2: the top-up rate is gone; rewrite as package_discount_bps (lowest wins, null = no say, §3.8)
        Assert.Fail($"P13-B2: the top-up rate is gone; rewrite as package_discount_bps (lowest wins, null = no say, §3.8)");
    }

    [Fact]
    public void Tied_rates_name_the_group_first_in_the_clubs_own_order()
    {
        // P13-B2: the top-up rate is gone; rewrite as package_discount_bps (lowest wins, null = no say, §3.8)
        Assert.Fail($"P13-B2: the top-up rate is gone; rewrite as package_discount_bps (lowest wins, null = no say, §3.8)");
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
        // P13-B2: the top-up rate is gone; rewrite as package_discount_bps (lowest wins, null = no say, §3.8)
        Assert.Fail($"P13-B2: the top-up rate is gone; rewrite as package_discount_bps (lowest wins, null = no say, §3.8)");
    }

    /// <summary>
    /// A NEW club's seeded pair: the league group grants peak at the league rate; the non-league
    /// group has NO SAY (null) — so a league member an admin also drops into it keeps the priority.
    /// </summary>
    [Fact]
    public Task The_seeded_non_league_group_has_no_say_on_peak()
    {
        // P13-B2: the top-up rate is gone; rewrite as package_discount_bps (lowest wins, null = no say, §3.8)
        Assert.Fail($"P13-B2: the top-up rate is gone; rewrite as package_discount_bps (lowest wins, null = no say, §3.8)");
        return Task.CompletedTask;
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
    public Task An_archived_group_contributes_nothing_to_the_tariff()
    {
        // P13-B2: the top-up rate is gone; rewrite as package_discount_bps (lowest wins, null = no say, §3.8)
        Assert.Fail($"P13-B2: the top-up rate is gone; rewrite as package_discount_bps (lowest wins, null = no say, §3.8)");
        return Task.CompletedTask;
    }

    /// <summary>
    /// <c>member_groups_enabled</c> turns off the booking RESTRICTIONS groups add, not the tariff
    /// the member class used to carry: a club that switches restrictions off must not silently
    /// move every league member to the regular rate or out of the peak window.
    /// </summary>
    [Fact]
    public Task Switching_group_restrictions_off_leaves_the_league_tariff_in_force()
    {
        // P13-B2: the top-up rate is gone; rewrite as package_discount_bps (lowest wins, null = no say, §3.8)
        Assert.Fail($"P13-B2: the top-up rate is gone; rewrite as package_discount_bps (lowest wins, null = no say, §3.8)");
        return Task.CompletedTask;
    }
}
