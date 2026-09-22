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
    Guid BookingId, string Status, decimal RefundCredits, decimal PenaltyCredits,
    string? MemberName, string? CourtName, DateTimeOffset? StartsAt, string? Error)
{
    public static BulkCancelResult Failure(Guid bookingId, string error)
        => new(bookingId, BulkCancelStatuses.Failed, 0m, 0m, null, null, null, error);

    /// <summary>Whether this outcome is one the admin should read as having worked.</summary>
    public bool Succeeded => Status != BulkCancelStatuses.Failed;
}

/// <summary>A whole bulk cancel's answer.</summary>
public sealed record BulkCancelOutcome(
    IReadOnlyList<BulkCancelResult> Results, decimal TotalRefundedCredits, decimal TotalPenaltyCredits);

/// <summary>One row of a bulk book's answer.</summary>
public sealed record BulkBookResult(
    int Index, string Status, Guid? BookingId, string? CourtName,
    DateTimeOffset? StartsAt, DateTimeOffset? EndsAt, decimal AmountCredits, string? Error)
{
    public static BulkBookResult Booked(int index, Booking booking, string? courtName, decimal amount)
        => new(index, BulkBookStatuses.Booked, booking.Id, courtName,
            booking.StartsAt, booking.EndsAt, amount, null);

    public static BulkBookResult Blocked(int index, Booking booking, string? courtName)
        => new(index, BulkBookStatuses.Blocked, booking.Id, courtName,
            booking.StartsAt, booking.EndsAt, 0m, null);

    public static BulkBookResult Replay(int index, Booking booking, string? courtName)
        => new(index, BulkBookStatuses.Duplicate, booking.Id, courtName,
            booking.StartsAt, booking.EndsAt, 0m, null);

    public static BulkBookResult Failure(int index, string error, string? courtName, DateTimeOffset startsAt)
        => new(index, BulkBookStatuses.Failed, null, courtName, startsAt, null, 0m, error);

    public bool Succeeded => Status != BulkBookStatuses.Failed;
}

/// <summary>A whole bulk book's answer.</summary>
public sealed record BulkBookOutcome(
    IReadOnlyList<BulkBookResult> Results, decimal TotalChargedCredits, int? HaltedAt, string? HaltedReason);
