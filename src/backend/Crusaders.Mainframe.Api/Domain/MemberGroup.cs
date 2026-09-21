namespace Crusaders.Mainframe.Api.Domain;

/// <summary>How a group prices a slice, relative to the court's own price.</summary>
public enum GroupPricingMode
{
    /// <summary>The court's price, unchanged. What both seeded groups start on.</summary>
    InheritCourt = 0,

    /// <summary>The court's price times a factor in basis points. 10 000 is 1.00x.</summary>
    Multiplier = 1,

    /// <summary>A flat price per slice, whatever the court charges.</summary>
    FlatPerSlice = 2,
}

/// <summary>
/// Whether a group still applies. Archiving rather than deleting is how a club removes a rule
/// without silently changing what every one of its members may book and pay.
/// </summary>
public enum MemberGroupStatus
{
    Active = 0,
    Archived = 1,
}

/// <summary>
/// GOAL item 3: "a sort of grouping mechanism with its own configurable rates and times range
/// that are allowed to book between… The most restrictive of the group rules apply."
///
/// <para>
/// <b>A second axis, orthogonal to <see cref="MemberClass"/>.</b> The class keeps doing what it
/// has always done — it drives the top-up conversion rate and blueprint A.12's peak rule — and is
/// untouched by this. Folding the two together would migrate live economics in the same change
/// as a new feature, which is two risks wearing one commit.
/// </para>
///
/// <para>
/// <b>A member may be in several groups</b>, which is why membership is a join table rather than
/// a column, and it is what makes "most restrictive wins" a real question rather than a
/// formality. <see cref="Services.GroupRules"/> is where that question is answered.
/// </para>
/// </summary>
public sealed class MemberGroup : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>Unique per tenant, case-insensitively: two groups called "League" is an admin reading the wrong rule.</summary>
    public required string Name { get; set; }

    /// <summary>Shown to the member on the grid, so a refusal can be explained in the club's own words.</summary>
    public string? Description { get; set; }

    public MemberGroupStatus Status { get; set; } = MemberGroupStatus.Active;
    public int SortOrder { get; set; }

    public GroupPricingMode PricingMode { get; set; } = GroupPricingMode.InheritCourt;

    /// <summary>Basis points, so a 0.75x rate is 7 500 and no decimal rounding happens in configuration.</summary>
    public int PriceMultiplierBps { get; set; } = 10_000;

    /// <summary>Same precision as <c>courts.SlicePriceCredits</c>; a narrower column would round a price the ledger then quotes.</summary>
    public decimal? FlatSlicePriceCredits { get; set; }

    /// <summary>Null inherits the tenant setting. 0 means unlimited, as it does everywhere in this codebase.</summary>
    public int? MaxSlotsPerDay { get; set; }

    /// <summary>Null inherits the tenant setting. 0 means unlimited.</summary>
    public int? MaxMinutesPerDay { get; set; }

    /// <summary>Null inherits the tenant setting.</summary>
    public int? AdvanceBookingDays { get; set; }

    /// <summary>
    /// The two groups the seeder writes. Renameable and editable, not deletable, so the groups
    /// screen always has two rows to explain the feature with.
    /// </summary>
    public bool IsSystemDefault { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public Guid CreatedByUserId { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// One stretch of one weekday a group's members may book inside.
///
/// <para>
/// Several rows per day is the point — 06:00–09:00 <b>and</b> 17:00–21:00 is an ordinary
/// off-peak rule — so there is deliberately no unique index on <c>(GroupId, DayOfWeek)</c>.
/// </para>
///
/// <para>
/// <b>A group with no window rows at all is unrestricted</b>, not shut. Without that clause,
/// creating a group merely to hold a PRICE would silently forbid its members from booking at
/// any time, which is the opposite of what the admin asked for and would show up as an empty
/// grid rather than as an error.
/// </para>
/// </summary>
public sealed class MemberGroupWindow : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid GroupId { get; set; }

    /// <summary>Stored as the <see cref="System.DayOfWeek"/> value, Sunday = 0, matching <c>OperatingHours</c>' own vocabulary.</summary>
    public DayOfWeek DayOfWeek { get; set; }

    /// <summary>Local minutes past midnight, 0..1439.</summary>
    public int StartMinute { get; set; }

    /// <summary>Local minutes past midnight, 1..1440, strictly after <see cref="StartMinute"/>. No midnight crossing.</summary>
    public int EndMinute { get; set; }
}

/// <summary>A member's place in a group. The unique index makes a double-add a no-op rather than a duplicate rule.</summary>
public sealed class MemberGroupMember : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid GroupId { get; set; }
    public Guid UserId { get; set; }
    public Guid AddedByUserId { get; set; }
    public DateTimeOffset AddedAt { get; set; } = DateTimeOffset.UtcNow;
}
