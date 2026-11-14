using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// P13 §4.2–4.3, pure: the shelf rule (group packages and club packages, the club's at the
/// member's discount), the rand rounding (down to the cent, in the buyer's favour) and the saving
/// against the smallest package on the same shelf. No database — every mutant §1.4 names for the
/// shelf and the saving turns at least one of these red.
/// </summary>
public class PackageShelfTests
{
    private static readonly Guid Club = Guid.NewGuid();

    private static MinutePackage P(string name, int minutes, decimal price, int sort = 0, Guid? group = null,
        MinutePackageStatus status = MinutePackageStatus.Active) => new()
        {
            TenantId = Club,
            Name = name,
            Minutes = minutes,
            PriceZar = price,
            SortOrder = sort,
            GroupId = group,
            Status = status,
        };

    private static TariffGroup G(string name, int? bps, int sort = 0) => new(Guid.NewGuid(), name, null, bps, null, sort);

    private static readonly MinutePackage[] Seeded =
    [
        P("1 hour", 60, 120.00m, 0), P("5 hours", 300, 550.00m, 1), P("10 hours", 600, 1000.00m, 2),
    ];

    // ---- §4.3: the contract's own check -------------------------------------------------

    /// <summary>
    /// "With 1 h R120, 5 h R550 and 10 h R1000, the 5 h package saves R50 (8%) and the 10 h
    /// package saves R200 (16%). At a 10% discount these become R45 and R180, with the same
    /// percentages." The baseline itself has no saving.
    /// </summary>
    [Fact]
    public void The_contract_example_saves_what_the_contract_says_with_and_without_a_discount()
    {
        var plain = PackageShelf.Build(Seeded, MemberTariffs.Resolve([]));
        Assert.Equal([120.00m, 550.00m, 1000.00m], plain.Select(i => i.PriceZar));
        Assert.Equal([null, 50.00m, 200.00m], plain.Select(i => i.SavingZar));
        Assert.Equal([null, 8, 16], plain.Select(i => i.SavingPct));

        var league = G("League", 1000);
        var discounted = PackageShelf.Build(Seeded, MemberTariffs.Resolve([league]));
        Assert.Equal([108.00m, 495.00m, 900.00m], discounted.Select(i => i.PriceZar));
        Assert.Equal([null, 45.00m, 180.00m], discounted.Select(i => i.SavingZar));
        Assert.Equal([null, 8, 16], discounted.Select(i => i.SavingPct));
        Assert.All(discounted, i => Assert.Equal(1000, i.DiscountBps));
        // A discount never touches minutes: a "5 hours" package is 300 minutes for everybody.
        Assert.Equal([60, 300, 600], discounted.Select(i => i.Package.Minutes));
    }

    /// <summary>
    /// The baseline is the FEWEST minutes, not the first in shelf order and not the largest.
    /// Mutation check (§1.4): a baseline of the largest package gives the small ones a negative
    /// saving (null) and the largest none, so this goes red.
    /// </summary>
    [Fact]
    public void The_baseline_is_the_smallest_package_whatever_the_shelf_order()
    {
        var reordered = new[] { P("10 hours", 600, 1000m, 0), P("1 hour", 60, 120m, 5), P("5 hours", 300, 550m, 1) };
        var shelf = PackageShelf.Build(reordered, MemberTariffs.Resolve([]));

        Assert.Equal(["10 hours", "5 hours", "1 hour"], shelf.Select(i => i.Package.Name));
        Assert.Equal([200.00m, 50.00m, null], shelf.Select(i => i.SavingZar));
        Assert.Equal([16, 8, null], shelf.Select(i => i.SavingPct));
    }

    [Fact]
    public void A_tie_on_the_smallest_minutes_goes_to_the_lower_price_then_shelf_order()
    {
        var savings = PackageShelf.Savings([(60, 130m), (60, 120m), (120, 200m)]);
        // Baseline is the R120 hour; the R130 hour costs more than it, so it saves nothing.
        Assert.Equal([((decimal?)null, (int?)null), (null, null), (40.00m, 16)], savings);

        var sameBoth = PackageShelf.Savings([(60, 120m), (60, 120m)]);
        Assert.All(sameBoth, s => Assert.Null(s.Zar));
    }

    /// <summary>A package dearer per minute than the baseline shows no saving at all, never a negative one.</summary>
    [Fact]
    public void A_package_that_saves_nothing_shows_nothing()
    {
        var savings = PackageShelf.Savings([(60, 100m), (120, 200m), (120, 250m)]);
        Assert.Equal([((decimal?)null, (int?)null), (null, null), (null, null)], savings);
    }

    /// <summary>
    /// The rand saving rounds DOWN to the cent and the percent DOWN to the whole; a percent that
    /// comes out at 0 is null even when a few cents are saved.
    /// </summary>
    [Fact]
    public void A_saving_rounds_down_and_a_zero_percent_is_null()
    {
        // 3 × 33.33 = 99.99 against 99.98: one cent saved, 0.01% — shown in rand, not as a percent.
        var tiny = PackageShelf.Savings([(10, 33.33m), (30, 99.98m)]);
        Assert.Equal(0.01m, tiny[1].Zar);
        Assert.Null(tiny[1].Pct);

        // 100 × 7 ÷ 3 = 233.333… − 200 = 33.333… → R33.33 (never R33.34); 14.28…% → 14.
        var thirds = PackageShelf.Savings([(3, 100m), (7, 200m)]);
        Assert.Equal(33.33m, thirds[1].Zar);
        Assert.Equal(14, thirds[1].Pct);

        // 100 × 8 ÷ 3 = 266.666… − 266 = 0.666… → R0.66, never the nearest R0.67.
        Assert.Equal(0.66m, PackageShelf.Savings([(3, 100m), (8, 266m)])[1].Zar);
    }

    /// <summary>A shelf whose smallest package is free (a 100% discount) has no saving to show, rather than dividing by zero.</summary>
    [Fact]
    public void A_free_baseline_shows_no_saving()
    {
        var shelf = PackageShelf.Build(Seeded, MemberTariffs.Resolve([G("Staff", 10_000)]));
        Assert.All(shelf, i => Assert.Equal(0.00m, i.PriceZar));
        Assert.All(shelf, i => Assert.Null(i.SavingZar));
    }

    // ---- §1.2 / §4.2: the discount is rand only, rounded down to the cent -------------------

    [Theory]
    [InlineData(550.00, 1000, 495.00)]
    [InlineData(120.00, 333, 116.00)]    // 120 × 0.9667 = 116.004 → 116.00
    [InlineData(99.99, 1500, 84.99)]     // 84.9915 → 84.99, never 85.00
    [InlineData(0.05, 5000, 0.02)]       // 0.025 → 0.02: the buyer keeps the fraction of a cent
    [InlineData(10.00, 3333, 6.66)]      // 6.667 → 6.66, never the nearest 6.67
    [InlineData(1000.00, 0, 1000.00)]
    [InlineData(1000.00, 10000, 0.00)]
    public void A_discount_rounds_the_price_down_to_the_cent(double list, int bps, double expected)
        => Assert.Equal((decimal)expected, PackageShelf.Discounted((decimal)list, bps));

    // ---- §4.2: who sees what ------------------------------------------------------------------

    /// <summary>
    /// Dean's answer 2: a group member sees their group's packages AND the club's, the club's at
    /// their discount and the group's at the group's own price with nothing on top. Mutation check
    /// (§1.4): applying the discount to a group package, or to minutes, turns this red.
    /// </summary>
    [Fact]
    public void A_group_member_sees_the_groups_packages_and_the_clubs_at_their_discount()
    {
        var league = G("League", 1000);
        var other = G("Coaching", null);
        var packages = Seeded.Append(P("League 10 hours", 600, 800m, 3, league.Id))
            .Append(P("Coaching block", 120, 150m, 4, other.Id))
            // Cheaper per minute and SMALLER than anything on this member's shelf: were the saving
            // measured against another shelf, it would become the baseline (mutation check §1.4).
            .Append(P("Coaching taster", 30, 30m, 5, other.Id))
            .ToList();

        var shelf = PackageShelf.Build(packages, MemberTariffs.Resolve([league]));

        Assert.Equal(["1 hour", "5 hours", "10 hours", "League 10 hours"], shelf.Select(i => i.Package.Name));
        var mine = shelf.Single(i => i.Source == ShelfSource.Group);
        Assert.Equal(800m, mine.PriceZar);
        Assert.Equal(0, mine.DiscountBps);
        Assert.Equal(league.Id, mine.Group!.Id);
        Assert.All(shelf.Where(i => i.Source == ShelfSource.Club), i => Assert.Equal(1000, i.DiscountBps));
        // The saving is computed across the whole shelf the member sees: 108 × 10 − 800 = 280.
        Assert.Equal(280.00m, mine.SavingZar);
    }

    [Fact]
    public void A_member_outside_every_group_sees_only_the_clubs_packages_at_list_price()
    {
        var league = G("League", 1000);
        var packages = Seeded.Append(P("League 10 hours", 600, 800m, 3, league.Id)).ToList();

        var shelf = PackageShelf.Build(packages, MemberTariffs.Resolve([]));

        Assert.Equal(3, shelf.Count);
        Assert.All(shelf, i => Assert.Equal(ShelfSource.Club, i.Source));
        Assert.All(shelf, i => Assert.Equal(i.Package.PriceZar, i.PriceZar));
        Assert.All(shelf, i => Assert.Equal(0, i.DiscountBps));
    }

    [Fact]
    public void An_archived_package_is_on_nobodys_shelf()
    {
        var packages = Seeded.Append(P("Old 2 hours", 120, 200m, 1, status: MinutePackageStatus.Archived)).ToList();
        Assert.DoesNotContain(PackageShelf.Build(packages, MemberTariffs.Resolve([])), i => i.Package.Name == "Old 2 hours");
    }

    [Fact]
    public void The_shelf_is_ordered_by_sort_order_then_minutes_then_name()
    {
        var packages = new[]
        {
            P("B", 120, 200m, 1), P("A", 120, 210m, 1), P("Short", 30, 70m, 1), P("First", 600, 900m, 0),
        };
        var shelf = PackageShelf.Build(packages, MemberTariffs.Resolve([]));
        Assert.Equal(["First", "Short", "A", "B"], shelf.Select(i => i.Package.Name));
    }

    // ---- the PayFast item name ------------------------------------------------------------

    /// <summary>§3.4 / §12.13: an ASCII hyphen, the compact minutes, and at most 100 characters.</summary>
    [Fact]
    public void The_payfast_item_name_is_ascii_hyphenated_and_bounded()
    {
        Assert.Equal("Crusaders - 5 hours (5 h)", PackageEndpoints.ItemName("Crusaders", "5 hours", 300));
        Assert.Equal("Crusaders - Taster (1 h 30 min)", PackageEndpoints.ItemName(" Crusaders ", "Taster", 90));
        Assert.DoesNotContain('–', PackageEndpoints.ItemName("Crusaders", "5 hours", 300));

        var long64 = new string('x', 64);
        var name = PackageEndpoints.ItemName(new string('C', 60), long64, 600);
        Assert.Equal(PackageEndpoints.MaxItemNameLength, name.Length);
    }

    // ---- the lock -------------------------------------------------------------------------

    /// <summary>
    /// §4.4: the purchase row copies the shelf item — package, minutes, list price, discount and
    /// price — and names the discount's group only when a discount applied.
    /// </summary>
    [Fact]
    public void The_purchase_lock_copies_the_shelf_item_and_names_the_discount_group_only_when_one_applied()
    {
        var league = G("League", 1000);
        var tariff = MemberTariffs.Resolve([league]);
        var shelf = PackageShelf.Build(Seeded.Append(P("League 10 hours", 600, 800m, 3, league.Id)), tariff);

        var club = PackageEndpoints.Lock(Club, Guid.NewGuid(), shelf.Single(i => i.Package.Name == "5 hours"), tariff);
        Assert.Equal((300, 550.00m, 1000, 495.00m), (club.Minutes, club.ListPriceZar, club.DiscountBps, club.AmountZar));
        Assert.Equal(league.Id, club.GroupId);
        Assert.Equal("5 hours", club.PackageName);

        var own = PackageEndpoints.Lock(Club, Guid.NewGuid(), shelf.Single(i => i.Source == ShelfSource.Group), tariff);
        Assert.Equal((600, 800m, 0, 800m), (own.Minutes, own.ListPriceZar, own.DiscountBps, own.AmountZar));
        Assert.Null(own.GroupId);
    }

    // ---- the desk's bound ----------------------------------------------------------------

    [Theory]
    [InlineData(0)]
    [InlineData(1_000_000)]
    [InlineData(-1_000_000)]
    [InlineData(99_999_999_999)]
    public void An_adjustment_past_the_bound_is_refused_by_name(long amount)
        => Assert.NotNull(WalletEndpoints.RefuseAmount(amount));

    [Theory]
    [InlineData(1)]
    [InlineData(-45)]
    [InlineData(999_999)]
    [InlineData(-999_999)]
    public void An_adjustment_inside_the_bound_is_accepted(long amount)
        => Assert.Null(WalletEndpoints.RefuseAmount(amount));
}
