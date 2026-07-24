namespace Crusaders.Mainframe.Api.Domain;

public enum MembershipStatus
{
    PendingApproval = 0,
    Active = 1,
    Rejected = 2,
    Suspended = 3,
}

/// <summary>
/// Member class — drives the credits-per-rand conversion rate on top-ups AND peak-hours access.
/// Per the Crusaders client blueprint (Rev 2, A.7 + A.8 + A.12):
///   - <see cref="Regular"/> — standard member; default rate (R100 → 160 credits at Crusaders).
///   - <see cref="LeagueOrSenior"/> — league players or members aged 65+; better rate (R100 → 240
///     credits at Crusaders) and exclusive booking access to peak-hour slots until just before slot start.
/// Class is admin-assignable, audit-logged on every change.
/// </summary>
public enum MemberClass
{
    Regular = 0,
    LeagueOrSenior = 1,
}

/// <summary>
/// The player profile attached to a User. Holds tenant-issued membership number, photo, status, class.
/// </summary>
public sealed class Membership : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }

    public required string FullName { get; set; }
    public required string MembershipNumber { get; set; }
    public string? PhotoUrl { get; set; }

    public MembershipStatus Status { get; set; } = MembershipStatus.PendingApproval;
    public MemberClass MemberClass { get; set; } = MemberClass.Regular;
    public string? RejectionReason { get; set; }
    public Guid? ReviewedByUserId { get; set; }
    public DateTimeOffset? ReviewedAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    public User? User { get; set; }
}
