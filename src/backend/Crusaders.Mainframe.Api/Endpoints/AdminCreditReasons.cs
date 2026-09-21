using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// What kind of by-hand money movement the desk is making — the closed set, and which ledger type
/// each one posts.
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

    /// <summary>The whole closed set, served in the refusal so a client never has to guess.</summary>
    public static readonly string[] All =
        [TopUpCash, TopUpEft, TopUpCardOffline, Goodwill, Correction, RefundOutsideSystem, Other];

    /// <summary>A resolved code and the ledger type it posts.</summary>
    public readonly record struct Kind(string Code, LedgerEntryType Type);

    /// <summary>
    /// The kind a request names, or null when it names one that does not exist.
    ///
    /// <para>
    /// <b>An absent code is accepted for one release</b> as <see cref="Other"/> →
    /// <c>AdminAdjustment</c>, which is today's exact behaviour, and is logged as deprecated. The
    /// alternative — requiring it immediately — breaks every console build in the field the
    /// moment this deploys, for a field the frontend is adding in the same wave. The grace is
    /// one release and the log line is what says when it can go.
    /// </para>
    /// </summary>
    public static Kind? Resolve(string? reasonCode, ILogger logger)
    {
        if (string.IsNullOrWhiteSpace(reasonCode))
        {
            logger.LogWarning(
                "an admin credit adjustment arrived with no reason_code; defaulting to '{Code}'. "
                + "This grace lasts one release — after it the request is a 400.", Other);
            return new Kind(Other, LedgerEntryType.AdminAdjustment);
        }

        var code = reasonCode.Trim();
        return code switch
        {
            TopUpCash or TopUpEft or TopUpCardOffline => new Kind(code, LedgerEntryType.AdminTopUp),
            Goodwill or Correction or RefundOutsideSystem or Other => new Kind(code, LedgerEntryType.AdminAdjustment),
            _ => null,
        };
    }

    /// <summary>Whether a code posts an <see cref="LedgerEntryType.AdminTopUp"/>, for the tests that care.</summary>
    public static bool IsTopUp(string code)
        => code is TopUpCash or TopUpEft or TopUpCardOffline;
}
