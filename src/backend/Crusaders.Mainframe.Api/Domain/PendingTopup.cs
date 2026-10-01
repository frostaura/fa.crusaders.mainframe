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

    /// <summary>What PayFast is asked for: the package price after the locked discount.</summary>
    public decimal AmountZar { get; set; }

    /// <summary>
    /// The purchase lock (P13): what the member was sold, frozen at checkout. The callback adds
    /// <see cref="Minutes"/> from this row and never re-reads <see cref="MinutePackage"/>, so an
    /// admin editing or archiving the package while the member sits on PayFast's card page cannot
    /// change what money already paid buys. A reference, not a foreign key, like
    /// <see cref="GroupId"/>.
    /// </summary>
    public Guid PackageId { get; set; }

    /// <summary>A copy of the package's name at checkout, for the receipt and the ledger reason.</summary>
    public string PackageName { get; set; } = "";

    /// <summary>The whole minutes the callback adds to the balance. Strictly positive.</summary>
    public int Minutes { get; set; }

    /// <summary>The package price before any group discount. <see cref="AmountZar"/> is after it.</summary>
    public decimal ListPriceZar { get; set; }

    /// <summary>The group discount applied, in basis points; 0 when none.</summary>
    public int DiscountBps { get; set; }

    /// <summary>
    /// The group whose <see cref="MemberGroup.PackageDiscountBps"/> was locked into this purchase,
    /// or null when no discount applied — recorded so a reconciliation can see which tariff
    /// applied.
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
