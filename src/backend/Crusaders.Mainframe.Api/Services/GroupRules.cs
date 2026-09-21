using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>One stretch of a club day, in local minutes past midnight. Half-open: <c>[Start, End)</c>.</summary>
public readonly record struct MinuteWindow(int Start, int End)
{
    /// <summary>Whether a whole booking fits inside this window. A range, not an instant — see <see cref="GroupRules"/>.</summary>
    public bool Contains(int startMinute, int endMinute) => startMinute >= Start && endMinute <= End;
}

/// <summary>A group as the rule evaluator needs it: its windows for one day, its price, its caps.</summary>
public sealed record MemberGroupRules(
    Guid Id,
    string Name,
    string? Description,
    GroupPricingMode PricingMode,
    int PriceMultiplierBps,
    decimal? FlatSlicePriceCredits,
    int? MaxSlotsPerDay,
    int? MaxMinutesPerDay,
    int? AdvanceBookingDays,
    bool HasAnyWindows,
    IReadOnlyList<MinuteWindow> WindowsForDay);

/// <summary>
/// "The most restrictive of the group rules apply" — GOAL item 3 — defined precisely enough that
/// two readers cannot disagree about it.
///
/// <para>
/// <b>Windows intersect.</b> Every group a member belongs to must say yes, which is the
/// deny-overrides combining algorithm and the standard reading of "most restrictive" when several
/// policies apply to one subject (XACML 3.0). A group with NO window rows at all contributes the
/// club's own opening hours, i.e. it does not narrow anything — see <see cref="MemberGroupWindow"/>
/// for why that clause has to exist.
/// </para>
///
/// <para>
/// <b>Prices take the MAXIMUM.</b> This is the decision most likely to be argued with, so: "most
/// restrictive" means the member gets the least favourable of the rules that apply to them, and
/// for a permission the least favourable is the narrowest window while for a price it is the
/// highest. Taking the narrowest window and the LOWEST price would be two different meanings of
/// one word in one sentence. It is also the only direction that is safe under admin error:
/// adding a member to an extra group can then never make them cheaper by accident. A mis-click
/// that costs a member a higher price is visible to them before they confirm; the inverse costs
/// the club revenue nobody ever notices, and this club's admins are volunteers.
/// </para>
///
/// <para>
/// <b>Caps take the minimum, skipping zeros.</b> Zero means unlimited everywhere in this
/// codebase, so a naive <c>Math.Min</c> would let one unlimited group either forbid everything or
/// exempt everything depending on which way the next reader took it. <see cref="BookingLimits.MinOf"/>
/// is the one place that is decided.
/// </para>
///
/// <para>
/// <b>A member in NO group is unrestricted at the club's own rules and the court's own price.</b>
/// Not refused, and not "the default group's rules". A brand-new member must be able to book
/// before an admin has classified them, and a club that never opens the groups screen must behave
/// exactly as it does today — which is what makes installing this feature a no-op for the
/// existing Crusaders data rather than a migration of live economics.
/// </para>
/// </summary>
public static class GroupRules
{
    /// <summary>0x. A group may price a slice at nothing; it may not price it at less than nothing.</summary>
    public const int MinMultiplierBps = 0;

    /// <summary>100x. Past this a "multiplier" is a typo, not a tariff.</summary>
    public const int MaxMultiplierBps = 1_000_000;

    /// <summary>Two windows a day is an off-peak club; eight is every reasonable shape of one.</summary>
    public const int MaxWindowsPerDay = 8;

    /// <summary>And 56 across the week, so a group cannot be used as a scheduling engine.</summary>
    public const int MaxWindowsPerGroup = 56;

    /// <summary>More groups than this is a taxonomy nobody can hold in their head, on a screen with no search.</summary>
    public const int MaxGroupsPerTenant = 32;

    /// <summary>The most members an admin may add to a group in one call.</summary>
    public const int MaxMembersPerCall = 500;

    /// <summary>Name bounds. Two characters is the shortest thing anybody means; 64 is the column.</summary>
    public const int MinNameLength = 2;
    public const int MaxNameLength = 64;
    public const int MaxDescriptionLength = 256;

    /// <summary>
    /// What one group charges for one slice on one court.
    ///
    /// <para>
    /// Clamped and floored on the way out, in the <see cref="DoorSettings"/> posture: the database
    /// CHECK refuses a nonsense configuration, and a hand-edited row that got past it produces a
    /// sane price rather than a court that pays the member — the lesson of D2-B06.
    /// </para>
    ///
    /// <para>
    /// <c>AwayFromZero</c> matches the walk-up pro-rata and both penalty computations, so the club
    /// does not round in its own favour in one place and against itself in another.
    /// </para>
    /// </summary>
    // Block body, not an expression one: lizard's C# parser reads the `{` of a switch or an
    // object initialiser as the END of the function and dumps the rest of the file into a
    // *global* pseudo-function whose length trips `-L 200`. See memory/gotchas.md.
    public static decimal PriceFor(MemberGroupRules group, decimal courtPrice)
    {
        return group.PricingMode switch
        {
            GroupPricingMode.Multiplier => Math.Max(0m, decimal.Round(
                courtPrice * Math.Clamp(group.PriceMultiplierBps, MinMultiplierBps, MaxMultiplierBps) / 10_000m,
                2, MidpointRounding.AwayFromZero)),
            GroupPricingMode.FlatPerSlice => Math.Max(0m, decimal.Round(
                group.FlatSlicePriceCredits ?? courtPrice, 2, MidpointRounding.AwayFromZero)),
            _ => courtPrice,
        };
    }

    /// <summary>
    /// The price a member actually pays per slice: the highest any of their groups asks for, and
    /// the court's own price when they are in none.
    /// </summary>
    public static decimal PriceFor(IReadOnlyList<MemberGroupRules> groups, decimal courtPrice)
    {
        if (groups.Count == 0) return courtPrice;
        var price = courtPrice;
        var seen = false;
        foreach (var group in groups)
        {
            var candidate = PriceFor(group, courtPrice);
            price = seen ? Math.Max(price, candidate) : candidate;
            seen = true;
        }
        return price;
    }

    /// <summary>
    /// The windows a member may book inside on one day: the club's hours intersected with every
    /// group's, which may legitimately come out EMPTY.
    ///
    /// <para>
    /// An empty result is a real state and is reported as one — "you are in two groups whose
    /// booking times do not overlap" — rather than as an empty grid, which reads to a member as
    /// the club being shut.
    /// </para>
    /// </summary>
    public static IReadOnlyList<MinuteWindow> AllowedWindows(
        IReadOnlyList<MemberGroupRules> groups, MinuteWindow clubHours)
    {
        var allowed = new List<MinuteWindow> { clubHours };

        foreach (var group in groups)
        {
            // A group with no window rows anywhere is unrestricted and narrows nothing.
            if (!group.HasAnyWindows) continue;

            // It HAS windows, but none on this day — so it permits nothing today. That is the
            // deny-overrides reading and it is deliberate: "we may book Tuesdays and Thursdays"
            // has to mean something on a Wednesday.
            allowed = Intersect(allowed, group.WindowsForDay);
            if (allowed.Count == 0) break;
        }

        return allowed;
    }

    /// <summary>
    /// Whether a whole booking lies inside ONE allowed stretch.
    ///
    /// <para>
    /// One stretch, not the union: a 08:45–09:15 booking across the edge of an 06:00–09:00 window
    /// is refused, because half of the court time the member asked for is time they may not have.
    /// That is the same whole-range rule <c>CheckOperatingHoursRule</c> already applies to opening
    /// hours, and applying it two different ways would be a rule the member could not learn.
    /// </para>
    /// </summary>
    public static bool Permits(IReadOnlyList<MinuteWindow> allowed, int startMinute, int endMinute)
        => allowed.Any(w => w.Contains(startMinute, endMinute));

    /// <summary>
    /// The slot cap a member is actually held to: the smallest their groups name, falling back to
    /// the tenant's, with 0 meaning unlimited throughout.
    /// </summary>
    public static int SlotCapFor(IReadOnlyList<MemberGroupRules> groups, int tenantDefault)
        => CapFor(groups, tenantDefault, g => g.MaxSlotsPerDay);

    /// <summary>The same for the minutes cap.</summary>
    public static int MinuteCapFor(IReadOnlyList<MemberGroupRules> groups, int tenantDefault)
        => CapFor(groups, tenantDefault, g => g.MaxMinutesPerDay);

    /// <summary>
    /// And for the booking horizon, where the minimum is also the restrictive direction: a group
    /// may bring a member's horizon in, never push it out past the club's own.
    /// </summary>
    public static int AdvanceDaysFor(IReadOnlyList<MemberGroupRules> groups, int tenantDefault)
        => CapFor(groups, tenantDefault, g => g.AdvanceBookingDays);

    /// <summary>
    /// Which group bound a cap, for the refusal body. Null when the tenant's own number is the
    /// binding one — so the sentence a member reads names the rule that actually stopped them
    /// rather than the first rule the code happened to check.
    /// </summary>
    public static MemberGroupRules? BoundBy(
        IReadOnlyList<MemberGroupRules> groups, int tenantDefault, Func<MemberGroupRules, int?> select)
    {
        var effective = CapFor(groups, tenantDefault, select);
        if (effective == 0) return null;
        if (effective == tenantDefault && !groups.Any(g => select(g) == effective && effective != 0)) return null;
        return groups.FirstOrDefault(g => select(g) is { } v && v == effective && v != 0);
    }

    private static int CapFor(
        IReadOnlyList<MemberGroupRules> groups, int tenantDefault, Func<MemberGroupRules, int?> select)
    {
        var effective = tenantDefault;
        foreach (var group in groups)
        {
            effective = BookingLimits.MinOf(effective, select(group) ?? tenantDefault);
        }
        return effective;
    }

    /// <summary>
    /// The overlap of two window sets, as a new set. Both sides are half-open, so a window ending
    /// where another begins produces nothing rather than a zero-length stretch.
    /// </summary>
    private static List<MinuteWindow> Intersect(
        IReadOnlyList<MinuteWindow> left, IReadOnlyList<MinuteWindow> right)
    {
        var result = new List<MinuteWindow>();
        foreach (var a in left)
        {
            foreach (var b in right)
            {
                var start = Math.Max(a.Start, b.Start);
                var end = Math.Min(a.End, b.End);
                if (start < end) result.Add(new MinuteWindow(start, end));
            }
        }
        return result;
    }

    /// <summary>
    /// The windows of one group on one day, with anything a hand-edit could have produced dropped.
    ///
    /// <para>
    /// A dropped window makes the group MORE restrictive, not less — the opposite failure
    /// direction from <c>OperatingHours</c>, deliberately. For an access rule, failing closed is
    /// right; for opening hours, which decide whether the club can trade at all, failing closed
    /// would shut the club. Two postures, two reasons, both written down.
    /// </para>
    /// </summary>
    public static IReadOnlyList<MinuteWindow> WindowsFor(IEnumerable<MemberGroupWindow> windows, DayOfWeek day)
        => windows
            .Where(w => w.DayOfWeek == day)
            .Where(w => w.StartMinute >= 0 && w.EndMinute <= 1440 && w.EndMinute > w.StartMinute)
            .OrderBy(w => w.StartMinute)
            .Select(w => new MinuteWindow(w.StartMinute, w.EndMinute))
            .ToList();
}
