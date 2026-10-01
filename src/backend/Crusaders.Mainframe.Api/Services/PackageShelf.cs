using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>Where a package on a member's shelf comes from: the club's own, or one of the member's groups.</summary>
public enum ShelfSource
{
    Club,
    Group,
}

/// <summary>
/// One package as a particular member is offered it (P13 §4.2): the minutes, the list price, the
/// discount applied and the rand the member pays, plus the saving against the smallest package on
/// the same shelf (§4.3). <see cref="Group"/> names the group a group package belongs to.
/// </summary>
public sealed record ShelfItem(
    MinutePackage Package,
    ShelfSource Source,
    TariffGroup? Group,
    int DiscountBps,
    decimal PriceZar)
{
    /// <summary>Rand saved against the shelf's baseline, rounded down to the cent; null when there is none.</summary>
    public decimal? SavingZar { get; init; }

    /// <summary>The same saving as a whole percent, rounded down; null when none or when it rounds to 0.</summary>
    public int? SavingPct { get; init; }
}

/// <summary>A member's whole shelf and the tariff it was priced with.</summary>
public sealed record MemberShelf(MemberTariff Tariff, IReadOnlyList<ShelfItem> Items)
{
    /// <summary>The live item for a package id, or null when the package is not on this shelf now.</summary>
    public ShelfItem? Find(Guid packageId) => Items.FirstOrDefault(i => i.Package.Id == packageId);
}

/// <summary>
/// The shelf rule (P13 §4.2) and the saving (§4.3), pure, plus the one database read that feeds
/// them. The purchase route, the desk and the member's shelf all read a member's packages through
/// here, so the price a member is shown, the price they are asked to pay and the price the desk
/// would charge them cannot disagree.
///
/// <para>
/// <b>The discount touches rand, never minutes.</b> A "5 hours" package is 300 minutes for
/// everybody; the member's discount (the LOWEST any of their active groups sets —
/// <see cref="MemberTariffs"/>) lowers what a CLUB package costs, rounded down to the cent in the
/// member's favour. A group's own packages are already that group's price and take no discount on
/// top (Dean, 2026-10-01: a group member sees both their group's packages and the club's, the
/// club's at their discount).
/// </para>
/// </summary>
public static class PackageShelf
{
    /// <summary>10 000 basis points is the whole price.</summary>
    public const int WholeBps = 10_000;

    /// <summary>Rounds rand DOWN to the cent — the buyer keeps any fraction of a cent.</summary>
    public static decimal FloorCent(decimal zar) => Math.Floor(zar * 100m) / 100m;

    /// <summary><c>floor_cent(list × (10 000 − bps) ÷ 10 000)</c>.</summary>
    public static decimal Discounted(decimal listZar, int bps)
        => FloorCent(listZar * (WholeBps - Math.Clamp(bps, 0, WholeBps)) / WholeBps);

    /// <summary>
    /// The shelf for one member, pure. <paramref name="packages"/> may hold anything the club has —
    /// archived packages, other groups' packages — and only what this member may buy survives.
    /// <paramref name="tariff"/> must be resolved over the member's ACTIVE groups.
    /// </summary>
    public static IReadOnlyList<ShelfItem> Build(IEnumerable<MinutePackage> packages, MemberTariff tariff)
    {
        var groups = tariff.Groups.ToDictionary(g => g.Id);
        var discount = tariff.PackageDiscountBps ?? 0;
        var items = new List<ShelfItem>();

        foreach (var package in packages)
        {
            if (package.Status != MinutePackageStatus.Active) continue;
            if (package.GroupId is not { } groupId)
            {
                items.Add(new ShelfItem(package, ShelfSource.Club, null, discount, Discounted(package.PriceZar, discount)));
            }
            else if (groups.TryGetValue(groupId, out var group))
            {
                items.Add(new ShelfItem(package, ShelfSource.Group, group, 0, package.PriceZar));
            }
        }

        var ordered = items
            .OrderBy(i => i.Package.SortOrder)
            .ThenBy(i => i.Package.Minutes)
            .ThenBy(i => i.Package.Name, StringComparer.Ordinal)
            .ThenBy(i => i.Package.Id)
            .ToList();

        var savings = Savings(ordered.Select(i => (i.Package.Minutes, i.PriceZar)).ToList());
        return ordered.Select((item, n) => item with { SavingZar = savings[n].Zar, SavingPct = savings[n].Pct }).ToList();
    }

    /// <summary>
    /// The saving of each item against the shelf's baseline (P13 §4.3), pure, in the order given.
    ///
    /// <para>
    /// The baseline is the item with the FEWEST minutes, ties to the lower price, then to shelf
    /// order — the package a member would otherwise buy repeatedly. Against it:
    /// <c>saving_zar = floor_cent(baseline.price × p.minutes ÷ baseline.minutes − p.price)</c> and
    /// <c>saving_pct = floor(100 × (1 − p.price × baseline.minutes ÷ (p.minutes × baseline.price)))</c>,
    /// computed as one division of exact products so a whole percent is never read as 15.999….
    /// A saving shows only when it is positive; a percent that rounds to 0 is null; the baseline
    /// itself, and every item on a shelf whose baseline is free, has none.
    /// </para>
    /// </summary>
    public static IReadOnlyList<(decimal? Zar, int? Pct)> Savings(IReadOnlyList<(int Minutes, decimal PriceZar)> items)
    {
        var result = items.Select(_ => ((decimal?)null, (int?)null)).ToList();
        if (items.Count == 0) return result;

        var baseline = 0;
        for (var n = 1; n < items.Count; n++)
        {
            var (minutes, price) = items[n];
            var (bestMinutes, bestPrice) = items[baseline];
            if (minutes < bestMinutes || (minutes == bestMinutes && price < bestPrice)) baseline = n;
        }

        var (baseMinutes, basePrice) = items[baseline];
        if (baseMinutes <= 0 || basePrice <= 0m) return result;

        for (var n = 0; n < items.Count; n++)
        {
            if (n == baseline) continue;
            result[n] = SavingOf(items[n], baseMinutes, basePrice);
        }
        return result;
    }

    private static (decimal? Zar, int? Pct) SavingOf((int Minutes, decimal PriceZar) item, int baseMinutes, decimal basePrice)
    {
        var zar = FloorCent((basePrice * item.Minutes / baseMinutes) - item.PriceZar);
        if (zar <= 0m) return (null, null);

        var atBaseRate = item.Minutes * basePrice;
        var pct = (int)Math.Floor(100m * (atBaseRate - (item.PriceZar * baseMinutes)) / atBaseRate);
        return (zar, pct > 0 ? pct : null);
    }

    /// <summary>
    /// The member's shelf now: their active groups' tariff and every active package the club
    /// has, priced by <see cref="Build"/>. Tenant-filtered, so another club's package never appears.
    /// </summary>
    public static async Task<MemberShelf> ForAsync(MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        var tariff = MemberTariffs.Resolve(await MemberTariffs.GroupsOfAsync(db, userId, ct));
        var packages = await db.MinutePackages.AsNoTracking()
            .Where(p => p.Status == MinutePackageStatus.Active)
            .ToListAsync(ct);
        return new MemberShelf(tariff, Build(packages, tariff));
    }

    /// <summary>The discount a shelf applies to the club's packages, as the wire names it; null when no group sets one.</summary>
    public static object? DiscountWire(MemberTariff tariff)
    {
        if (tariff.PackageDiscountBps is not { } bps || tariff.DiscountGroup is not { } group) return null;
        return new { bps, group = new { id = group.Id, name = group.Name } };
    }

    /// <summary>One shelf item on the wire (P13 §3.4).</summary>
    public static object ItemWire(ShelfItem item)
    {
        return new
        {
            id = item.Package.Id,
            name = item.Package.Name,
            minutes = item.Package.Minutes,
            list_price_zar = item.Package.PriceZar,
            discount_bps = item.DiscountBps,
            price_zar = item.PriceZar,
            saving_zar = item.SavingZar,
            saving_pct = item.SavingPct,
            source = item.Source == ShelfSource.Club ? "club" : "group",
            group = item.Group is { } g ? new { id = g.Id, name = g.Name } : null,
        };
    }
}
