using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>Who the batch is booking for, and how. Resolved from the request's <c>on_behalf</c>.</summary>
/// <param name="PayerUserId">Null means a free-text guest, which becomes an admin block charging nobody.</param>
/// <param name="GuestName">The label a guest block carries, or the note beside a member's booking.</param>
/// <param name="AdminNote">Set only when a guest name accompanies a real member.</param>
/// <param name="ActorIsAdmin">
/// Whether the actor holds the admin role, taken from the route group's claim exactly as
/// <c>BookingEndpoints</c>' on-behalf route takes it.
///
/// <para>
/// <b>It is carried rather than inferred, and carrying it is load-bearing.</b>
/// <c>BookingService</c> used to derive "this is an admin" from <c>actorId != userId</c>, which
/// was true of every row this service books; D2-B13 removed that inference, so without this the
/// whole bulk path silently lost its exemption from peak hours, the group windows and the
/// per-day caps — and a league night booked out across four courts would have been refused item
/// by item with member-class reason codes.
/// </para>
/// </param>
public readonly record struct BulkBookRequestContext(
    Guid? PayerUserId, string? GuestName, string? AdminNote, bool AllowNegativeBalance,
    string IdempotencyKey, bool ActorIsAdmin = false);

/// <summary>One row of a bulk cancel's answer.</summary>
public sealed record BulkCancelResult(
    Guid BookingId, string Status, int RefundMinutes, int PenaltyMinutes,
    string? MemberName, string? CourtName, DateTimeOffset? StartsAt, string? Error, string? BlockLabel = null)
{
    public static BulkCancelResult Failure(Guid bookingId, string error)
        => new(bookingId, BulkCancelStatuses.Failed, 0, 0, null, null, null, error);

    /// <summary>Whether this outcome is one the admin should read as having worked.</summary>
    public bool Succeeded => Status != BulkCancelStatuses.Failed;
}

/// <summary>A whole bulk cancel's answer.</summary>
public sealed record BulkCancelOutcome(
    IReadOnlyList<BulkCancelResult> Results, int TotalRefundedMinutes, int TotalPenaltyMinutes);

/// <summary>One row of a bulk book's answer.</summary>
public sealed record BulkBookResult(
    int Index, string Status, Guid? BookingId, string? CourtName,
    DateTimeOffset? StartsAt, DateTimeOffset? EndsAt, int AmountMinutes, string? Error)
{
    public static BulkBookResult Booked(int index, Booking booking, string? courtName, int amount)
        => new(index, BulkBookStatuses.Booked, booking.Id, courtName,
            booking.StartsAt, booking.EndsAt, amount, null);

    public static BulkBookResult Blocked(int index, Booking booking, string? courtName)
        => new(index, BulkBookStatuses.Blocked, booking.Id, courtName,
            booking.StartsAt, booking.EndsAt, 0, null);

    public static BulkBookResult Replay(int index, Booking booking, string? courtName)
        => new(index, BulkBookStatuses.Duplicate, booking.Id, courtName,
            booking.StartsAt, booking.EndsAt, 0, null);

    public static BulkBookResult Failure(int index, string error, string? courtName, DateTimeOffset startsAt)
        => new(index, BulkBookStatuses.Failed, null, courtName, startsAt, null, 0, error);

    public bool Succeeded => Status != BulkBookStatuses.Failed;
}

/// <summary>A whole bulk book's answer.</summary>
public sealed record BulkBookOutcome(
    IReadOnlyList<BulkBookResult> Results, int TotalChargedMinutes, int? HaltedAt, string? HaltedReason);

/// <summary>One item of a bulk quote: its price when bookable, or the refusal code it would meet.</summary>
public sealed record BulkQuoteLine(
    BulkBookItem Item, string? CourtName, int PriceMinutes, bool Bookable, string? Reason);

/// <summary>
/// A whole batch, priced. <paramref name="TotalMinutes"/> sums the bookable lines only;
/// <paramref name="BalanceMinutes"/> is the payer's balance now.
/// </summary>
/// <param name="BalanceMinutes">The payer's raw balance.</param>
/// <param name="HeldMinutes">What of it the payer holds for partners (D11).</param>
/// <param name="OwedBackMinutes">What of it is due back to partners and waiting (D11); the guard is on what is left.</param>
public sealed record BulkQuote(
    IReadOnlyList<BulkQuoteLine> Lines, int TotalMinutes, int BalanceMinutes, int HeldMinutes = 0, int OwedBackMinutes = 0)
{
    public int SpendableMinutes => BalanceMinutes - HeldMinutes - OwedBackMinutes;
}
