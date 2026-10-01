namespace Crusaders.Mainframe.Api.Domain;

/// <summary>The <see cref="MemberGroup.SystemKey"/> vocabulary.</summary>
public static class MemberGroupSystemKeys
{
    /// <summary>The group that replaced the <c>LeagueOrSenior</c> member class.</summary>
    public const string League = "league";

    /// <summary>
    /// The value the deprecated <c>member_class</c> wire field carries for a member of the league
    /// group, and <see cref="RegularClassName"/> for everyone else. Kept for ONE release so a
    /// webhook template or an old screen reading it does not break mid-deploy.
    /// </summary>
    public const string LeagueClassName = "LeagueOrSenior";

    /// <inheritdoc cref="LeagueClassName"/>
    public const string RegularClassName = "Regular";
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
/// <b>The ONE configurable concept (decision D2, 2026-09-23).</b> A group used to be a second axis
/// beside a two-value member class that drove the top-up rate and blueprint A.12's peak rule.
/// The class is gone: a group now also carries the package discount
/// (<see cref="PackageDiscountBps"/>, P13) and the peak priority (<see cref="PeakPriority"/>), and what was
/// "LeagueOrSenior" is membership of the system group whose <see cref="SystemKey"/> is
/// <see cref="MemberGroupSystemKeys.League"/>. How several groups combine is
/// <see cref="Services.MemberTariffs"/>' question for the discount and the peak, and
/// <see cref="Services.GroupRules"/>' for windows and caps.
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

    /// <summary>Null inherits the tenant setting. 0 means unlimited, as it does everywhere in this codebase.</summary>
    public int? MaxSlotsPerDay { get; set; }

    /// <summary>Null inherits the tenant setting. 0 means unlimited.</summary>
    public int? MaxMinutesPerDay { get; set; }

    /// <summary>Null inherits the tenant setting.</summary>
    public int? AdvanceBookingDays { get; set; }

    /// <summary>
    /// The discount, in basis points (0–10 000), this group's members get on the club's minutes
    /// packages (P13). Null means the group has no say. When several of a member's groups set
    /// one, the LOWEST wins (<see cref="Services.MemberTariffs"/>). It discounts rand only — a
    /// package's minutes are the same for everybody.
    /// </summary>
    public int? PackageDiscountBps { get; set; }

    /// <summary>
    /// What this group says about booking inside the club's peak window at any time (blueprint
    /// A.12): <c>true</c> grants it, <c>false</c> withholds it, <c>null</c> has no say — the same
    /// "no opinion" state <see cref="PackageDiscountBps"/> has. A member has the priority when at
    /// least one of their active groups grants it and none withholds it — see
    /// <see cref="Services.MemberTariffs"/>. Null is what every group that existed before D2
    /// carries, because none of them had any say in peak priority then.
    /// </summary>
    public bool? PeakPriority { get; set; }

    /// <summary>
    /// A stable handle for a group the system itself relies on, unique per tenant when set. Only
    /// <see cref="MemberGroupSystemKeys.League"/> exists: it is how the migration, the seeder and
    /// the one-release deprecated <c>member_class</c> field find the group that replaced
    /// <c>LeagueOrSenior</c> after an admin has renamed it. Never written by the admin API.
    /// </summary>
    public string? SystemKey { get; set; }

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
/// creating a group merely to hold a DISCOUNT would silently forbid its members from booking at
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
