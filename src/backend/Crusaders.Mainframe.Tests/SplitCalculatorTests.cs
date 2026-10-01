using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// D11's split calculator. The one promise that matters is that the shares sum to the price
/// EXACTLY, whatever the mode, the weights or the price — so it is checked over thousands of
/// generated cases rather than a handful of chosen ones, with a fixed seed so a failure replays.
/// </summary>
public class SplitCalculatorTests
{
    private static List<SplitSeat> Seats(params (int Seat, bool Guest, int Weight, decimal Amount)[] seats) =>
        seats.Select(s => new SplitSeat(s.Seat, s.Guest, s.Weight, s.Amount)).ToList();

    [Fact]
    public void Equal_split_rounds_partners_down_to_whole_minutes_and_the_organiser_takes_the_rest()
    {
        var result = SplitCalculator.Split(32, SplitModes.Equal, Seats((1, false, 1, 0), (2, false, 1, 0), (3, false, 1, 0)));

        Assert.Null(result.Error);
        var shares = result.Shares!.ToDictionary(s => s.Seat, s => s.ShareMinutes);
        Assert.Equal(10, shares[2]);
        Assert.Equal(10, shares[3]);
        Assert.Equal(12, shares[1]);
    }

    /// <summary>
    /// The organiser keeps every remainder (§1.2): 61 minutes four ways is 15 for each partner and
    /// 16 for the organiser, and a ratio of 1:1:1 on 100 is 33, 33 and 34 — never a 33.33.
    /// </summary>
    [Theory]
    [InlineData(61, "equal", new[] { 1, 1, 1, 1 }, new[] { 16, 15, 15, 15 })]
    [InlineData(100, "ratio", new[] { 1, 1, 1 }, new[] { 34, 33, 33 })]
    [InlineData(45, "ratio", new[] { 1, 2 }, new[] { 15, 30 })]
    [InlineData(7, "ratio", new[] { 3, 2, 2 }, new[] { 3, 2, 2 })]
    [InlineData(1, "equal", new[] { 1, 1 }, new[] { 1, 0 })]
    public void The_remainder_of_a_split_stays_with_the_organiser(int price, string mode, int[] weights, int[] expected)
    {
        var seats = weights.Select((w, i) => new SplitSeat(i + 1, false, w)).ToList();

        var result = SplitCalculator.Split(price, mode, seats);

        Assert.Null(result.Error);
        Assert.Equal(expected, result.Shares!.OrderBy(s => s.Seat).Select(s => s.ShareMinutes));
        Assert.Equal(price, result.Shares!.Sum(s => s.ShareMinutes));
    }

    [Fact]
    public void A_guest_pays_nothing_and_is_not_a_head_in_an_equal_split()
    {
        var result = SplitCalculator.Split(32, SplitModes.Equal, Seats((1, false, 1, 0), (2, true, 1, 0), (3, false, 1, 0)));
        var shares = result.Shares!.ToDictionary(s => s.Seat, s => s.ShareMinutes);
        Assert.Equal(0, shares[2]);
        Assert.Equal(16, shares[3]);
        Assert.Equal(16, shares[1]);
    }

    [Fact]
    public void A_ratio_split_divides_by_weight()
    {
        var result = SplitCalculator.Split(30, SplitModes.Ratio, Seats((1, false, 1, 0), (2, false, 2, 0)));
        var shares = result.Shares!.ToDictionary(s => s.Seat, s => s.ShareMinutes);
        Assert.Equal(20, shares[2]);
        Assert.Equal(10, shares[1]);
    }

    [Fact]
    public void An_amount_split_takes_the_partners_figures_and_gives_the_organiser_the_remainder()
    {
        var result = SplitCalculator.Split(32, SplitModes.Amount, Seats((1, false, 0, 0), (2, false, 0, 7), (3, false, 0, 10)));
        var shares = result.Shares!.ToDictionary(s => s.Seat, s => s.ShareMinutes);
        Assert.Equal(7, shares[2]);
        Assert.Equal(10, shares[3]);
        Assert.Equal(15, shares[1]);
    }

    /// <summary>An amount is whole minutes (§1.2): a fraction is refused by code, never truncated or rounded.</summary>
    [Theory]
    [InlineData(7.5)]
    [InlineData(0.5)]
    [InlineData(10.01)]
    [InlineData(-0.5)]
    public void An_amount_that_is_not_whole_minutes_is_refused(double amount)
    {
        var result = SplitCalculator.Split(32, SplitModes.Amount, Seats((1, false, 0, 0), (2, false, 0, (decimal)amount)));

        Assert.Equal(SplitCalculator.InvalidAmount, result.Error);
        Assert.Null(result.Shares);
    }

    [Fact]
    public void A_whole_amount_written_with_a_zero_fraction_is_whole()
    {
        var result = SplitCalculator.Split(32, SplitModes.Amount, Seats((1, false, 0, 0), (2, false, 0, 10.0m)));

        Assert.Null(result.Error);
        Assert.Equal(22, result.Shares!.Single(s => s.Seat == 1).ShareMinutes);
    }

    [Fact]
    public void An_amount_past_the_largest_whole_number_is_refused_rather_than_overflowing()
    {
        Assert.Equal(SplitCalculator.InvalidAmount,
            SplitCalculator.Split(32, SplitModes.Amount, Seats((1, false, 0, 0), (2, false, 0, (decimal)int.MaxValue + 1))).Error);
    }

    [Theory]
    [InlineData("amount", 33, SplitCalculator.ExceedsPrice)]
    [InlineData("amount", -1, SplitCalculator.InvalidAmount)]
    [InlineData("thirds", 0, SplitCalculator.InvalidMode)]
    public void Refusals_are_named(string mode, int amount, string error)
    {
        var result = SplitCalculator.Split(32, mode, Seats((1, false, 0, 0), (2, false, 0, amount)));
        Assert.Equal(error, result.Error);
        Assert.Null(result.Shares);
    }

    [Fact]
    public void An_amount_with_any_decimal_places_is_refused()
    {
        Assert.Equal(SplitCalculator.InvalidAmount,
            SplitCalculator.Split(32, SplitModes.Amount, Seats((1, false, 0, 0), (2, false, 0, 1.005m))).Error);
    }

    [Fact]
    public void Zero_total_weight_is_refused_rather_than_divided_by()
    {
        Assert.Equal(SplitCalculator.InvalidWeight,
            SplitCalculator.Split(32, SplitModes.Ratio, Seats((1, false, 0, 0), (2, false, 0, 0))).Error);
    }

    [Fact]
    public void Without_the_organiser_there_is_nobody_to_take_the_remainder()
    {
        Assert.Equal(SplitCalculator.NoOrganiser, SplitCalculator.Split(32, SplitModes.Equal, Seats((2, false, 1, 0))).Error);
    }

    /// <summary>
    /// The property: for every generated price, mode and seat set that the calculator accepts,
    /// the shares sum to the price exactly, no share is negative, every partner share under an
    /// equal or ratio split is its exact fraction rounded down, and a guest pays 0.
    /// </summary>
    [Fact]
    public void Shares_always_sum_to_the_price_exactly()
    {
        var random = new Random(20260923);
        var accepted = 0;
        for (var i = 0; i < 5000; i++)
        {
            var price = random.Next(0, 401);
            var mode = SplitModes.All[random.Next(SplitModes.All.Length)];
            var seats = new List<SplitSeat> { new(1, false, random.Next(0, 5)) };
            var remaining = price;
            foreach (var seat in Enumerable.Range(2, random.Next(1, 4)))
            {
                var amount = random.Next(0, remaining + 1);
                remaining -= amount;
                seats.Add(new SplitSeat(seat, random.Next(5) == 0, random.Next(0, 101), amount));
            }

            var result = SplitCalculator.Split(price, mode, seats);
            if (result.Error is not null) continue;
            accepted++;

            Assert.Equal(price, result.Shares!.Sum(s => s.ShareMinutes));
            Assert.All(result.Shares!, s => Assert.True(s.ShareMinutes >= 0, $"negative share in case {i}"));
            foreach (var share in result.Shares!.Where(s => s.Seat != 1))
            {
                var input = seats.First(s => s.Seat == share.Seat);
                if (input.IsGuest) Assert.Equal(0, share.ShareMinutes);
                if (mode == SplitModes.Amount || input.IsGuest) continue;

                var weights = mode == SplitModes.Equal ? seats.Count(s => !s.IsGuest) : seats.Where(s => !s.IsGuest).Sum(s => s.Weight);
                var weight = mode == SplitModes.Equal ? 1 : input.Weight;
                // Exactly the exact fraction rounded DOWN — not nearest, not up (§1.2, §1.4).
                Assert.True(share.ShareMinutes == (long)price * weight / weights, $"a partner's share is not ⌊price × weight ÷ total⌋ in case {i}");
            }
        }
        Assert.True(accepted > 3000, $"only {accepted} generated cases were accepted — the generator is not exercising the calculator");
    }
}
