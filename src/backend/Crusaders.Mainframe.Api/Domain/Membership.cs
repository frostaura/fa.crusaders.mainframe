namespace Crusaders.Mainframe.Api.Domain;

public enum MembershipStatus
{
    PendingApproval = 0,
    Active = 1,
    Rejected = 2,
    Suspended = 3,

    /// <summary>
    /// Deleted by the club with its history kept: the person's name, address, photo and credentials
    /// are wiped and the rows stay so the books balance. Terminal — nothing reactivates it, and every
    /// list hides it unless asked for it by name. See <c>Services.MemberDeletion</c>.
    /// </summary>
    Deleted = 4,
}

/// <summary>
/// The player profile attached to a User. Holds tenant-issued membership number, photo and status.
/// What used to be its member class is membership of a group — see <see cref="MemberGroup"/>.
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
    public string? RejectionReason { get; set; }
    public Guid? ReviewedByUserId { get; set; }
    public DateTimeOffset? ReviewedAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    public User? User { get; set; }
}
