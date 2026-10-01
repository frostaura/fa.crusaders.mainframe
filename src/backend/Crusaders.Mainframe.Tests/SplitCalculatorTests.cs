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
    public void Equal_split_rounds_partners_down_to_whole_credits_and_the_organiser_takes_the_rest()
    {
        var result = SplitCalculator.Split(32, SplitModes.Equal, Seats((1, false, 1, 0), (2, false, 1, 0), (3, false, 1, 0)));

        Assert.Null(result.Error);
        var shares = result.Shares!.ToDictionary(s => s.Seat, s => s.ShareMinutes);
        Assert.Equal(10, shares[2]);
        Assert.Equal(10, shares[3]);
        Assert.Equal(12, shares[1]);
    }

    [Fact]
    public void A_fractional_price_leaves_the_fraction_with_the_organiser()
    {
        // P13-B3: a price is whole minutes; a fractional price cannot exist (§1.1)
        Assert.Fail($"P13-B3: a price is whole minutes; a fractional price cannot exist (§1.1)");
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
        var result = SplitCalculator.Split(32, SplitModes.Amount, Seats((1, false, 0, 0), (2, false, 0, 7.5m), (3, false, 0, 10)));
        var shares = result.Shares!.ToDictionary(s => s.Seat, s => s.ShareMinutes);
        Assert.Equal(7.5m, shares[2]);
        Assert.Equal(10, shares[3]);
        Assert.Equal(14.5m, shares[1]);
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
    public void An_amount_with_more_than_two_decimal_places_is_refused()
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
    /// equal or ratio split is a whole number no larger than the exact fraction, and a guest pays 0.
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

                Assert.Equal(decimal.Floor(share.ShareMinutes), share.ShareMinutes);
                var weights = mode == SplitModes.Equal ? seats.Count(s => !s.IsGuest) : seats.Where(s => !s.IsGuest).Sum(s => s.Weight);
                var weight = mode == SplitModes.Equal ? 1 : input.Weight;
                Assert.True(share.ShareMinutes <= price * weight / weights, $"a partner asked for more than their fraction in case {i}");
            }
        }
        Assert.True(accepted > 3000, $"only {accepted} generated cases were accepted — the generator is not exercising the calculator");
    }
}
