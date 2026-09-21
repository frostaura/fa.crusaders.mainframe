namespace Crusaders.Mainframe.Api.Services;

/// <summary>What happened to one booking in a bulk cancel. A closed set.</summary>
public static class BulkCancelStatuses
{
    /// <summary>It was booked and now is not. The money moved.</summary>
    public const string Cancelled = "cancelled";

    /// <summary>
    /// It was already gone — and this is a SUCCESS, not a failure.
    ///
    /// <para>
    /// <b>The whole reason bulk cancel needs its own outcome vocabulary.</b>
    /// <c>CancelAsync</c> answers <c>NotFound</c> for a row that is not <c>Booked</c>, so a
    /// retried batch whose first attempt half-landed would report its own successes as errors.
    /// An admin reading "6 failed" about 6 bookings they successfully cancelled forty seconds
    /// ago will cancel something else to compensate.
    /// </para>
    /// </summary>
    public const string AlreadyCancelled = "already_cancelled";

    /// <summary>
    /// It was an admin block, so it was lifted rather than cancelled.
    ///
    /// <para>
    /// The admin ticked cells on a grid; they should not have to know that two of them are a
    /// different kind of row with no money in it.
    /// </para>
    /// </summary>
    public const string BlockLifted = "block_lifted";

    /// <summary>Nothing happened, and <c>error</c> says why.</summary>
    public const string Failed = "failed";
}

/// <summary>What happened to one item in a bulk book. A closed set.</summary>
public static class BulkBookStatuses
{
    public const string Booked = "booked";

    /// <summary>A free-text guest, which has no wallet — written as an admin block that charges nobody.</summary>
    public const string Blocked = "blocked";

    /// <summary>This exact item already landed under this idempotency key. A retry, answered honestly.</summary>
    public const string Duplicate = "duplicate";

    public const string Failed = "failed";
}

/// <summary>One booking an admin ticked, and whether the penalty is waived for it specifically.</summary>
public readonly record struct BulkCancelItem(Guid BookingId, bool? WaivePenalty);

/// <summary>One slot an admin wants booked.</summary>
public readonly record struct BulkBookItem(Guid CourtId, DateTimeOffset StartsAt, int SliceCount);

/// <summary>
/// The values one bulk cancellation shares across every item — the admin's key, their words,
/// the batch-level waiver default and who they are.
///
/// <para>
/// A parameter object rather than four arguments: they travel together everywhere they are
/// read, and the complexity gate caps a signature at six.
/// </para>
/// </summary>
public readonly record struct BulkCancelBatch(
    string IdempotencyKey, string Reason, bool WaivePenaltyDefault, Guid ActorId);
