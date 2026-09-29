namespace Crusaders.Mainframe.Api.Services;

/// <summary>How a booking's price is divided between its players (D11).</summary>
public static class SplitModes
{
    public const string Equal = "equal";
    public const string Ratio = "ratio";
    public const string Amount = "amount";

    public static readonly string[] All = [Equal, Ratio, Amount];

    /// <summary>The normalised mode, or null when it is not one of the three.</summary>
    public static string? Normalise(string? raw)
    {
        var mode = raw?.Trim().ToLowerInvariant();
        return mode is Equal or Ratio or Amount ? mode : null;
    }
}

/// <summary>One seat going into a split: its number, whether it is a guest, and its weight or amount.</summary>
/// <param name="Weight">Ratio mode only: a whole number from 0 to <see cref="SplitCalculator.MaxWeight"/>.</param>
/// <param name="Amount">Amount mode only, partner seats only: credits, at most two decimal places.</param>
public sealed record SplitSeat(int Seat, bool IsGuest, int Weight = 1, decimal Amount = 0m);

/// <summary>One seat coming out of a split.</summary>
public sealed record SplitShare(int Seat, decimal ShareCredits, int Weight);

/// <summary>The split, or the stable code of why it was refused.</summary>
public sealed record SplitResult(IReadOnlyList<SplitShare>? Shares, string? Error)
{
    public static SplitResult Refuse(string error) => new(null, error);
}

/// <summary>
/// Divides a booking's price between its players so the shares sum to the price EXACTLY, always.
///
/// <para>
/// <b>The rounding rule.</b> Every PARTNER's share under an equal or ratio split is a whole number
/// of credits, rounded DOWN; the organiser (seat 1) takes whatever is left, including any fraction
/// of a credit. So <c>Σ shares = P</c> by construction rather than by luck, a partner is never
/// asked for more than their exact fraction, and the odd credit lands on the person who chose to
/// split. Under an amount split the partners' figures are the organiser's own (at most two decimal
/// places, the ledger's scale) and the organiser again takes the remainder, which may not go below
/// zero.
/// </para>
///
/// <para>
/// <b>Guests carry nothing.</b> A guest is not a member and has no wallet; their seat is in the
/// split with share 0 and weight 0 whatever the caller sent, and they do not count as a head in an
/// equal split — the organiser is covering them.
/// </para>
/// </summary>
public static class SplitCalculator
{
    public const int MaxWeight = 100;

    public const string InvalidMode = "split_mode_invalid";
    public const string InvalidWeight = "split_weight_invalid";
    public const string InvalidAmount = "split_amount_invalid";
    public const string ExceedsPrice = "split_exceeds_price";
    public const string NoOrganiser = "split_needs_organiser";

    /// <summary>Splits <paramref name="price"/> across <paramref name="seats"/>. Seat 1 must be among them.</summary>
    public static SplitResult Split(decimal price, string mode, IReadOnlyList<SplitSeat> seats)
    {
        if (seats.All(s => s.Seat != 1)) return SplitResult.Refuse(NoOrganiser);
        if (price < 0) return SplitResult.Refuse(InvalidAmount);

        switch (SplitModes.Normalise(mode))
        {
            case SplitModes.Equal:
                return ByWeight(price, seats.Select(s => s with { Weight = 1 }).ToList());
            case SplitModes.Ratio:
                if (seats.Any(s => !s.IsGuest && (s.Weight < 0 || s.Weight > MaxWeight))) return SplitResult.Refuse(InvalidWeight);
                return ByWeight(price, seats);
            case SplitModes.Amount:
                return ByAmount(price, seats);
            default:
                return SplitResult.Refuse(InvalidMode);
        }
    }

    private static SplitResult ByWeight(decimal price, IReadOnlyList<SplitSeat> seats)
    {
        var total = seats.Where(s => !s.IsGuest).Sum(s => s.Weight);
        if (total <= 0) return SplitResult.Refuse(InvalidWeight);

        var partners = seats
            .Where(s => s.Seat != 1)
            .Select(s => s.IsGuest
                ? new SplitShare(s.Seat, 0m, 0)
                : new SplitShare(s.Seat, Math.Floor(price * s.Weight / total), s.Weight))
            .ToList();
        var organiser = seats.First(s => s.Seat == 1);
        return Assemble(price, organiser.Weight, partners);
    }

    private static SplitResult ByAmount(decimal price, IReadOnlyList<SplitSeat> seats)
    {
        var partners = new List<SplitShare>();
        foreach (var s in seats.Where(s => s.Seat != 1))
        {
            if (s.IsGuest)
            {
                partners.Add(new SplitShare(s.Seat, 0m, 0));
                continue;
            }
            if (s.Amount < 0 || decimal.Round(s.Amount, 2) != s.Amount) return SplitResult.Refuse(InvalidAmount);
            partners.Add(new SplitShare(s.Seat, s.Amount, 0));
        }

        if (partners.Sum(p => p.ShareCredits) > price) return SplitResult.Refuse(ExceedsPrice);
        return Assemble(price, 0, partners);
    }

    /// <summary>The organiser's share is the remainder — the one line that makes the sum exact.</summary>
    private static SplitResult Assemble(decimal price, int organiserWeight, List<SplitShare> partners)
    {
        var organiser = new SplitShare(1, price - partners.Sum(p => p.ShareCredits), organiserWeight);
        return new SplitResult([organiser, .. partners.OrderBy(p => p.Seat)], null);
    }
}
