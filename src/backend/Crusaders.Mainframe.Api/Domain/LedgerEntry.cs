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

    /// <summary>
    /// Light time bought directly at the court, rather than as part of a booked slot.
    ///
    /// <para>
    /// Economically distinct from <see cref="BookingCharge"/>: a member topping up a
    /// running session is not reserving anything, and the club wants to see the two apart
    /// in reporting. Both are money spent on court time, so both live in
    /// <see cref="LedgerEntryTypes.Spend"/>.
    /// </para>
    /// </summary>
    LightsPurchase = 7,

    /// <summary>
    /// Money the club took by hand for a minutes package — cash at the desk, an EFT that
    /// cleared, a card taken offline.
    ///
    /// <para>
    /// <b>Not <see cref="AdminAdjustment"/>, and the difference is the club's revenue figure.</b>
    /// <c>docs/specs/reporting.md</c> defines Revenue as <c>top_up</c> net of
    /// <c>payment_reversal</c>, and <c>AdminAdjustment</c> sits in the
    /// <see cref="LedgerEntryTypes.Adjustment"/> bucket — so every cash top-up an admin took at
    /// the desk was invisible to the club's own revenue report, and the club's revenue figure
    /// was wrong by every rand it took over the counter.
    /// </para>
    ///
    /// <para>
    /// <b>Strictly positive</b>, and refused otherwise. Mixing signs inside a directional
    /// bucket is what makes a per-row listing unreadable; a goodwill grant or a book
    /// correction is an <see cref="AdminAdjustment"/> and says so.
    /// </para>
    ///
    /// <para>
    /// <i>Rejected:</i> counting <c>AdminAdjustment &gt; 0</c> as revenue. A signed type netted
    /// into a directional bucket is exactly the "field that mixes two things" the repo forbids,
    /// and it would silently reclassify every goodwill grant ever issued as money the club took.
    /// </para>
    /// </summary>
    AdminTopUp = 8,

    /// <summary>
    /// A partner's share of a split booking moving between the partner and the organiser (D11).
    ///
    /// <para>
    /// <b>Always a pair, and the pair nets to zero club-wide</b> — one row debits one member and
    /// the other pays another, under <c>share:{participant}:{seq}:out</c> and <c>:in</c>,
    /// posted in one save. So no club total moves: revenue, spend, refunds and penalties are
    /// exactly what they were, and a per-booking sum (<c>Owed</c>, the utilisation report) is
    /// unchanged because both legs name the same booking. What moves is who, between the
    /// players, bore the court — a member's "net court spend" is their spend less the shares
    /// they received plus the shares they paid.
    /// </para>
    ///
    /// <para>
    /// <b>Its own bucket, <see cref="LedgerEntryTypes.Transfer"/></b>, because it is none of the
    /// others: not spend (the organiser already spent), not a refund (the club gave nothing
    /// back), not an adjustment (no admin decided it).
    /// </para>
    /// </summary>
    ShareTransfer = 9,
}

/// <summary>
/// Report buckets, declared once.
///
/// <para>
/// <b>This exists because adding an enum member used to be silently dangerous.</b> There
/// is no database CHECK constraint on the column, no TypeScript union, and
/// <c>LedgerService.PostAsync</c> is type-blind — so a new member moved balances correctly
/// and appeared in <c>net_minutes</c>, while being invisible in fifteen
/// <c>Where(Type == X)</c> bucket sums across two endpoint files. Nothing failed to
/// compile. No test failed. The numbers just quietly stopped adding up.
/// </para>
///
/// <para>
/// Every member must appear in exactly one bucket, and
/// <c>LedgerEntryTypeCoverageTests</c> fails if one does not — so the next person to add a
/// type is asked the question at compile-and-test time rather than discovering it in a
/// month-end report.
/// </para>
/// </summary>
public static class LedgerEntryTypes
{
    /// <summary>
    /// Money in: a member funding their account, however the club took it.
    ///
    /// <para>
    /// <see cref="LedgerEntryType.AdminTopUp"/> belongs beside <see cref="LedgerEntryType.TopUp"/>
    /// and not in <see cref="Adjustment"/>, because a R200 note handed over the counter is the
    /// same event to the club's books as a R200 card payment. Putting it anywhere else is what
    /// made the revenue report wrong by every cash top-up the club has ever taken.
    /// </para>
    /// </summary>
    public static readonly LedgerEntryType[] Funding =
        [LedgerEntryType.TopUp, LedgerEntryType.AdminTopUp];

    /// <summary>Money out for court time. Both booked slots and light time bought at the court.</summary>
    public static readonly LedgerEntryType[] Spend =
        [LedgerEntryType.BookingCharge, LedgerEntryType.LightsPurchase];

    /// <summary>Money back to the member.</summary>
    public static readonly LedgerEntryType[] Refund = [LedgerEntryType.CancellationRefund];

    /// <summary>Money kept by the club for a missed or late-cancelled booking.</summary>
    public static readonly LedgerEntryType[] Penalty =
        [LedgerEntryType.NoShowPenalty, LedgerEntryType.LateCancellationPenalty];

    /// <summary>An admin moving minutes by hand, in either direction.</summary>
    public static readonly LedgerEntryType[] Adjustment = [LedgerEntryType.AdminAdjustment];

    /// <summary>A payment clawed back after the fact.</summary>
    public static readonly LedgerEntryType[] Reversal = [LedgerEntryType.PaymentReversal];

    /// <summary>
    /// Minutes moving between two members for one split booking (D11). Nets to zero across the
    /// club by construction, which is why no club report reads it.
    /// </summary>
    public static readonly LedgerEntryType[] Transfer = [LedgerEntryType.ShareTransfer];

    /// <summary>Every bucket, for the coverage test that keeps this honest.</summary>
    public static readonly IReadOnlyList<(string Name, LedgerEntryType[] Members)> All =
    [
        (nameof(Funding), Funding),
        (nameof(Spend), Spend),
        (nameof(Refund), Refund),
        (nameof(Penalty), Penalty),
        (nameof(Adjustment), Adjustment),
        (nameof(Reversal), Reversal),
        (nameof(Transfer), Transfer),
    ];
}

/// <summary>
/// Immutable ledger row. Balance is the sum of these for a given user — never a stored field.
/// Every money movement is one of these entries; rows are append-only.
/// <para>
/// The ledger unit is <b>whole minutes</b> of court time (P13, deviation D-3 from blueprint A.8),
/// never rand and never a fraction. On <see cref="LedgerEntryType.TopUp"/> and
/// <see cref="LedgerEntryType.AdminTopUp"/> rows, <see cref="ZarPaid"/> captures the rand that
/// bought the package, so what the club took for the minutes is auditable forever.
/// </para>
/// </summary>
public sealed class LedgerEntry : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }

    public LedgerEntryType Type { get; set; }

    /// <summary>Signed amount in whole minutes, the unit of account. Positive pays the user in, negative debits.</summary>
    public int AmountMinutes { get; set; }

    /// <summary>For <see cref="LedgerEntryType.TopUp"/> + <see cref="LedgerEntryType.PaymentReversal"/>: the ZAR amount that moved. Null on internal entries.</summary>
    public decimal? ZarPaid { get; set; }

    public Guid? RelatedBookingId { get; set; }
    public Guid ActorUserId { get; set; }
    public string? Reason { get; set; }
    public string? ExternalReference { get; set; } // unique on the gateway transaction id

    /// <summary>
    /// On a <see cref="LedgerEntryType.TopUp"/> posted by the PayFast ITN: the purchase
    /// (<c>pending_topups.Id</c>) it credits. Unique per club where set
    /// (<c>IX_ledger_entries_TenantId_PurchaseId</c>), so <b>one checkout is credited at most
    /// once</b> whatever arrives — the database's answer to money lane BM-2, where eight
    /// concurrent COMPLETEs carrying different <c>pf_payment_id</c>s credited one R120 purchase
    /// three times because each built a different <see cref="ExternalReference"/>. Null on every
    /// other row, and on purchases credited before the column existed.
    /// </summary>
    public Guid? PurchaseId { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
