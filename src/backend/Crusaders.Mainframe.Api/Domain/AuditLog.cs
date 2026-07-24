namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// Append-only audit log. Every admin action — approve, reject, book-on-behalf,
/// adjust-credit, impersonate — writes a row here. Members have a right to see who
/// has touched their data (out of scope for v1 UI but the data is captured).
/// </summary>
public sealed class AuditLog : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    public Guid ActorUserId { get; set; }
    public Guid? SubjectUserId { get; set; }
    public required string Action { get; set; }   // e.g. "member.approved", "booking.created_on_behalf"
    public string? DetailsJson { get; set; }
    public string? IpAddress { get; set; }
    public string? UserAgent { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
