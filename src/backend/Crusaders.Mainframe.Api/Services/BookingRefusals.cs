namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The booking refusal vocabulary: one word per <see cref="BookingResult"/>, and <b>the only
/// place those words are spelled</b>.
///
/// <para>
/// Every path that reports a refused booking reads <see cref="CodeOf"/> — the single member and
/// admin routes (<c>BookingEndpoints.ToHttpResult</c> takes its <c>error</c> from it), the admin
/// bulk book and its quote (<see cref="AdminBulkBookingService"/>), and the member bulk book
/// (<see cref="MemberBulkBookingService"/>). There used to be two copies, and the admin one had
/// already drifted once: four member-only refusals fell through to <c>booking_failed</c>, a code
/// no screen has a sentence for. One mapping cannot drift from itself;
/// <c>BookingRefusalsTests</c> fails the build when a new <see cref="BookingResult"/> has no word.
/// </para>
///
/// <para>
/// Three codes are a batch's own: <see cref="NotAttempted"/>, <see cref="IdempotencyKeyReused"/>
/// and <see cref="AlreadyCancelled"/>.
/// </para>
/// </summary>
public static class BookingRefusals
{
    public const string InsufficientBalance = "insufficient_balance";

    /// <summary>The slot is someone else's — or, in a quote, an earlier item of the same batch's.</summary>
    public const string SlotTaken = "slot_taken";

    /// <summary>What a result with no word maps to. <c>BookingRefusalsTests</c> keeps every known refusal off it.</summary>
    public const string Unmapped = "booking_failed";

    /// <summary>An item after the batch halted. Nothing was tried; retry the same key after a top-up.</summary>
    public const string NotAttempted = "not_attempted";

    /// <summary>This key already booked a DIFFERENT item at this position. Use a fresh key for a new list.</summary>
    public const string IdempotencyKeyReused = "idempotency_key_reused";

    /// <summary>
    /// This key already booked THIS item, and that booking has since been cancelled. A replay
    /// must not answer "booked" about a court the payer no longer holds; see <c>BulkReplay</c>.
    /// </summary>
    public const string AlreadyCancelled = "already_cancelled";

    /// <summary>
    /// The code for one refusal. Block body for the lizard reason in
    /// <c>memory/gotchas-gates.md</c> — an expression-bodied switch costs the file its scope.
    /// </summary>
    public static string CodeOf(BookingResult result)
    {
        return result switch
        {
            BookingResult.NotFound => "court_not_found",
            BookingResult.PastTime => "past_time",
            BookingResult.TooFarAhead => "too_far_ahead",
            BookingResult.SlotTaken => SlotTaken,
            BookingResult.InsufficientBalance => InsufficientBalance,
            BookingResult.PeakHoursLeagueOnly => "peak_hours_league_only",
            BookingResult.PerDayCapExceeded => "per_day_cap_exceeded",
            BookingResult.PerDaySlotCapExceeded => "per_day_slot_cap_exceeded",
            BookingResult.GroupWindow => "group_window",
            BookingResult.CrossesMidnight => "crosses_midnight",
            BookingResult.NoBookableWindow => "no_bookable_window",
            BookingResult.OutOfHours => "out_of_hours",
            BookingResult.NoTimeAvailable => "no_time_available",
            BookingResult.InvalidDuration => "invalid_duration",
            BookingResult.DuplicateRequest => "duplicate_request",
            _ => Unmapped,
        };
    }
}
