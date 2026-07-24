namespace Crusaders.Mainframe.Api.Domain;

public sealed class EnrolledTemplate : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }

    /// <summary>Opaque pointer at the on-prem template blob (file path / store key, never the template bytes themselves).</summary>
    public required string TemplateId { get; set; }
    public string? FingerLabel { get; set; }
    public Guid EnrolledByAdminUserId { get; set; }
    public string? ConsentReceiptHash { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? SupersededAt { get; set; }
}

public sealed class BiometricMatchEvent : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid CourtId { get; set; }

    public DateTimeOffset AttemptedAt { get; set; } = DateTimeOffset.UtcNow;
    public Guid? MatchedUserId { get; set; }
    public Guid? BookingId { get; set; }
    public double Confidence { get; set; }
    public double LivenessScore { get; set; }
    public int LatencyMs { get; set; }
    public required string Outcome { get; set; }   // match | no_match | low_quality | error
}
