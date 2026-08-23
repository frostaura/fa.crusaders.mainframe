namespace Crusaders.Mainframe.Api.Domain;

public enum LedgerEntryType
{
    TopUp = 0,
    BookingCharge = 1,
    CancellationRefund = 2,
    NoShowPenalty = 3,
    LateCancellationPenalty = 4,
    AdminAdjustment = 5,
    PaymentReversal = 6,
}

/// <summary>
/// Immutable ledger row. Balance is the sum of these for a given user — never a stored field.
/// Every credit movement is one of these entries; rows are append-only.
/// <para>
/// Per the Crusaders client blueprint Rev 2 (A.8), the ledger unit is <b>credits</b>, not ZAR.
/// The legacy column name <see cref="AmountCredits"/> is preserved for migration stability — read it as
/// "the unit of account, which Crusaders has fixed at credits". On <see cref="LedgerEntryType.TopUp"/>
/// rows, <see cref="ZarPaid"/> and <see cref="ConversionRate"/> capture the ZAR amount that funded
/// the top-up and the class-specific rate used (160 or 240 credits per rand), so the conversion is
/// auditable forever.
/// </para>
/// </summary>
public sealed class LedgerEntry : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }

    public LedgerEntryType Type { get; set; }

    /// <summary>Signed amount in the unit of account (credits for Crusaders). Positive credits the user, negative debits.</summary>
    public decimal AmountCredits { get; set; }

    /// <summary>For <see cref="LedgerEntryType.TopUp"/> + <see cref="LedgerEntryType.PaymentReversal"/>: the ZAR amount that moved. Null on internal entries.</summary>
    public decimal? ZarPaid { get; set; }

    /// <summary>Credits-per-rand at the moment of conversion. Null on non-top-up rows. Stored so historic entries don't re-derive.</summary>
    public decimal? ConversionRate { get; set; }

    public Guid? RelatedBookingId { get; set; }
    public Guid ActorUserId { get; set; }
    public string? Reason { get; set; }
    public string? ExternalReference { get; set; } // unique on the gateway transaction id

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
