namespace Crusaders.Mainframe.Api.Webhooks;

/// <summary>
/// The webhook event names for money movements (P13, <c>docs/specs/minutes-and-packages.md</c>
/// §5), declared once so an emitter and <c>WebhookEventCoverageTests</c> cannot spell one
/// differently.
///
/// <para>
/// They replaced the old unit's events, renamed one for one (§5's table). They are webhook types
/// only: the change-record actions, the audit action and the admin-notice kind
/// <c>topup.failed</c> are stored codes in append-only or surviving tables and keep their names
/// (§2.5, §12.2–12.3).
/// </para>
/// </summary>
public static class MinutesEvents
{
    /// <summary>A PayFast purchase of a minutes package completed.</summary>
    public const string Purchased = "minutes.purchased";

    /// <summary>A cancellation refund row was posted.</summary>
    public const string Refunded = "minutes.refunded";

    /// <summary>A no-show or late-cancellation penalty row was posted.</summary>
    public const string PenaltyApplied = "minutes.penalty_applied";

    /// <summary>An admin adjusted a member's minutes by hand.</summary>
    public const string Adjusted = "minutes.adjusted";

    /// <summary>A package was sold at the desk.</summary>
    public const string SoldAtDesk = "minutes.sold_at_desk";

    /// <summary>
    /// A refund was taken back — the NEGATIVE refund row a late-evidence no-show reversal posts.
    /// It went out as <c>minutes.refunded</c> carrying −45, a name saying the opposite of its
    /// figure (review round 6, E6-11).
    /// </summary>
    public const string RefundReversed = "minutes.refund_reversed";

    /// <summary>A penalty was given back — the POSITIVE penalty row of the same reversal (E6-11).</summary>
    public const string PenaltyReturned = "minutes.penalty_returned";

    /// <summary>Every name above, for the coverage test.</summary>
    public static readonly IReadOnlyList<string> All =
        [Purchased, Refunded, PenaltyApplied, Adjusted, SoldAtDesk, RefundReversed, PenaltyReturned];
}
