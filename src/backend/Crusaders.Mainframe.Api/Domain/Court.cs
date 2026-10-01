namespace Crusaders.Mainframe.Api.Domain;

public enum CourtType
{
    Squash = 0,
    Padel = 1,
    Tennis = 2,
    Badminton = 3,
}

/// <summary>
/// A bookable court. court_number is unique within the tenant and stable —
/// it's what flows into webhook URL templates (e.g. /court/{court_number}/turn/on).
/// </summary>
public sealed class Court : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    public int CourtNumber { get; set; }
    public required string Name { get; set; }
    public CourtType CourtType { get; set; } = CourtType.Squash;
    public bool IsActive { get; set; } = true;

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
