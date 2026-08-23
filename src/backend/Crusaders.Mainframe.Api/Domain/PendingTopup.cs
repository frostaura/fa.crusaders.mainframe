namespace Crusaders.Mainframe.Api.Domain;

public enum TopUpStatus
{
    Pending = 0,
    Completed = 1,
    Failed = 2,
    Cancelled = 3,
}

/// <summary>
/// One row per top-up attempt. Reconciles the gateway callback to the ledger entry.
/// Idempotent on <see cref="ExternalReference"/> (the gateway's payment id), enforced by a unique index.
/// </summary>
public sealed class PendingTopup : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }

    public decimal AmountZar { get; set; }
    public required string IdempotencyKey { get; set; }     // matches the merchantTransactionId
    /// <summary>The gateway's own reference for this attempt. For PayFast this is the
    /// m_payment_id we sent, since PayFast has no server-side checkout registration.</summary>
    public string? GatewayCheckoutId { get; set; }
    public string? ExternalReference { get; set; }          // gateway payment id (PayFast pf_payment_id), on completion
    public TopUpStatus Status { get; set; } = TopUpStatus.Pending;
    public string? FailureReason { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? CompletedAt { get; set; }
}
