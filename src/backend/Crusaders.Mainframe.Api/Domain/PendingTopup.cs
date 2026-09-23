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

    /// <summary>
    /// The credits-per-rand quoted to the member at the moment they were sent to PayFast.
    ///
    /// <para>
    /// <b>Load-bearing, and the reason this column exists.</b> The callback used to
    /// re-resolve the rate from live <c>tenant_settings</c>, so an admin who changed
    /// <c>credits_per_zar_*</c> while a member sat on PayFast's card page changed what that
    /// member received for money they had already paid. Two identical R100 payments minutes
    /// apart credited 100 and 240; in the damaging direction a member quoted 320 credits for
    /// R200 was credited 200. The rate is part of the offer, so it is captured with the
    /// offer and honoured on settlement.
    /// </para>
    ///
    /// <para>
    /// Nullable only for rows written before this column existed; the callback falls back to
    /// the live rate for those and nothing else.
    /// </para>
    /// </summary>
    public decimal? ConversionRate { get; set; }

    /// <summary>
    /// The group whose <see cref="MemberGroup.CreditsPerZar"/> the rate above was quoted from, or
    /// null when it was the tenant's default rate — recorded so a reconciliation can see which
    /// tariff applied. It replaced the member-class column (D2); a row written before that
    /// carries the league group's id when it was quoted at the league rate.
    ///
    /// <para>
    /// A reference, not a foreign key: an empty group may be deleted, and a top-up row is
    /// history that must outlive it. The change record keeps the deleted group's name.
    /// </para>
    /// </summary>
    public Guid? GroupId { get; set; }

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
