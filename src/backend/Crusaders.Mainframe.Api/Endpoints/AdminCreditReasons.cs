using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// What kind of by-hand minutes movement the desk is making — the closed set, and which ledger
/// type each one posts. The class keeps its name (P13 §2.5): it names no unit on the wire.
///
/// <para>
/// <b>Why a code at all.</b> One free-text <c>Reason</c> carried a cash top-up, an EFT, a
/// goodwill gesture and a book correction, and the ledger had no way to tell them apart. That is
/// not a tidiness problem: <c>docs/specs/reporting.md</c> defines Revenue as <c>top_up</c> net of
/// <c>payment_reversal</c>, so <b>every rand the club took over the counter was invisible to its
/// own revenue report</b> — the figure was wrong by exactly the cash the club handled.
/// </para>
///
/// <para>
/// The free-text reason stays required alongside it. The code says WHAT KIND, the reason says WHY
/// THIS ONE, and month-end needs both: "top_up_cash" does not tell anybody which receipt it was.
/// </para>
/// </summary>
public static class AdminCreditReasons
{
    /// <summary>The audit action a by-hand credit movement writes. Not a door action, deliberately.</summary>
    public const string AuditAction = "credit.adjusted";

    /// <summary>Cash handed over the counter.</summary>
    public const string TopUpCash = "top_up_cash";

    /// <summary>An electronic transfer that has cleared into the club's account.</summary>
    public const string TopUpEft = "top_up_eft";

    /// <summary>A card taken on the club's own terminal rather than through PayFast.</summary>
    public const string TopUpCardOffline = "top_up_card_offline";

    /// <summary>A gesture — an apology, a prize, a welcome. Not money the club took.</summary>
    public const string Goodwill = "goodwill";

    /// <summary>Fixing the books. Compensating a wrongly-swept no-show belongs here, named to its booking.</summary>
    public const string Correction = "correction";

    /// <summary>Money given back outside this system, recorded so the ledger matches the bank.</summary>
    public const string RefundOutsideSystem = "refund_outside_system";

    /// <summary>Everything else, which is also what a request carrying no code at all is read as.</summary>
    public const string Other = "other";

    /// <summary>
    /// The codes the desk SELLS a package under (<c>POST /admin/minutes/{id}/sell</c>, P13 §3.7):
    /// money the club took, posted as <c>AdminTopUp</c> and counted as revenue.
    /// </summary>
    public static readonly string[] SaleCodes = [TopUpCash, TopUpEft, TopUpCardOffline];

    /// <summary>
    /// The codes the desk ADJUSTS a balance under (<c>POST /admin/minutes/{id}/adjust</c>):
    /// goodwill and corrections, posted as <c>AdminAdjustment</c>. Since P13 a sale is its own
    /// route, so a top-up code sent here is refused rather than read as a sale with a signed amount.
    /// </summary>
    public static readonly string[] AdjustmentCodes = [Goodwill, Correction, RefundOutsideSystem, Other];

    /// <summary>A resolved code and the ledger type it posts.</summary>
    public readonly record struct Kind(string Code, LedgerEntryType Type);

    /// <summary>
    /// The adjustment kind a request names, or null when it names one the adjust route does not take.
    ///
    /// <para>
    /// <b>An absent code is accepted for one release</b> as <see cref="Other"/>, which is the
    /// pre-code behaviour, and is logged as deprecated — requiring it at once would break every
    /// console build in the field the moment this deploys.
    /// </para>
    /// </summary>
    public static Kind? ResolveAdjustment(string? reasonCode, ILogger logger)
    {
        if (string.IsNullOrWhiteSpace(reasonCode))
        {
            logger.LogWarning(
                "an admin minutes adjustment arrived with no reason_code; defaulting to '{Code}'. "
                + "This grace lasts one release — after it the request is a 400.", Other);
            return new Kind(Other, LedgerEntryType.AdminAdjustment);
        }

        var code = reasonCode.Trim();
        return AdjustmentCodes.Contains(code) ? new Kind(code, LedgerEntryType.AdminAdjustment) : null;
    }

    /// <summary>The sale kind a request names, or null when it is not one of <see cref="SaleCodes"/>. Never defaulted.</summary>
    public static Kind? ResolveSale(string? reasonCode)
    {
        var code = reasonCode?.Trim();
        return code is not null && SaleCodes.Contains(code) ? new Kind(code, LedgerEntryType.AdminTopUp) : null;
    }
}
