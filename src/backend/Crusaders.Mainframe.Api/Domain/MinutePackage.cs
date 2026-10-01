namespace Crusaders.Mainframe.Api.Domain;

/// <summary>Whether a package is on sale. A package is never deleted: purchase rows name it.</summary>
public enum MinutePackageStatus
{
    Active = 0,
    Archived = 1,
}

/// <summary>
/// A bundle of court minutes a member can buy for rand (P13, minutes as the unit of account).
///
/// <para>
/// <b>Minutes are the unit; rand is only the price.</b> A "5 hours" package is exactly 300
/// minutes for everybody. A group discount (<see cref="MemberGroup.PackageDiscountBps"/>) lowers
/// the rand a member pays for a club package, never the minutes.
/// </para>
///
/// <para>
/// <see cref="GroupId"/> null is a club package, offered to every member. A value offers it only
/// to that group's active members, at its own price with no discount on top. It is fixed once the
/// package is created, so a shelf never silently moves a package between audiences.
/// </para>
///
/// <para>
/// <b>Never deleted, only archived</b> (<see cref="MinutePackageStatus.Archived"/>): every
/// <see cref="PendingTopup"/> row names the package it sold, and the purchase lock on that row —
/// not this one — is what the payment callback honours.
/// </para>
/// </summary>
public sealed class MinutePackage : ITenantScoped
{
    public const int NameMaxLength = 64;
    public const int MinMinutes = 1;
    public const int MaxMinutes = 60_000;
    public const decimal MaxPriceZar = 100_000m;

    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>Null is a club package (every member); a value is that group's own package. Fixed at creation.</summary>
    public Guid? GroupId { get; set; }

    /// <summary>Trimmed, 1–64 characters, unique among ACTIVE packages on the same shelf.</summary>
    public required string Name { get; set; }

    /// <summary>Whole minutes added to the buyer's balance, 1–60 000.</summary>
    public int Minutes { get; set; }

    /// <summary>The list price in rand, above 0 and at most 100 000, whole cents.</summary>
    public decimal PriceZar { get; set; }

    /// <summary>Shelf order, ascending; ties fall to minutes, then name.</summary>
    public int SortOrder { get; set; }

    public MinutePackageStatus Status { get; set; } = MinutePackageStatus.Active;

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public Guid CreatedByUserId { get; set; }
}
