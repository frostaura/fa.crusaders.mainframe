namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// A user — a person within a tenant. The same human at two clubs has two User rows.
/// Platform admins have <see cref="IsPlatformAdmin"/> true and are not tenant-scoped.
/// </summary>
public sealed class User : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    public required string Email { get; set; }
    public string? PasswordHash { get; set; }
    public string? PinHash { get; set; }
    public bool EmailVerified { get; set; }
    public bool IsAdmin { get; set; }
    public bool IsPlatformAdmin { get; set; }
    public string Status { get; set; } = "active"; // active | suspended

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? LastLoginAt { get; set; }

    public Membership? Membership { get; set; }
}
