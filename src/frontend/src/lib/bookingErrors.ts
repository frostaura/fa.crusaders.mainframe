import { ApiError } from "./api";
import { formatCredits } from "./utils";

/**
 * Booking refusals, turned into sentences a member can act on.
 *
 * <p>
 * The schedule used to branch on the HTTP STATUS: 402 meant "top up", 409 meant "just
 * taken", 400 meant "that slot is in the past", and everything else meant "Booking
 * failed." Three of those were wrong. The two headline rules of the whole product —
 * peak-hour league exclusivity and the per-day cap — answered 500 and so came out as
 * the bare "Booking failed."; a member whose session had simply lapsed got a 400 and
 * was told their 8 p.m. slot was in the past; and `too_far_ahead` and
 * `invalid_duration` were told the same thing.
 * </p>
 *
 * <p>
 * Two refusals sharing a status code is normal — the stable snake_case `error` token is
 * what tells them apart, and it is what this file reads. Codes carrying figures get
 * those figures into the sentence, because "peak hours are for league and senior
 * members" is advice and "16:00–19:00 is league and senior only until an hour before
 * the slot" is an answer.
 * </p>
 *
 * <p>
 * Never show a member a code or an exception. Anything unrecognised falls back to a
 * plain sentence that says what to do next, and the token is left to the console.
 * </p>
 */
const BOOKING_ERROR_TEXT: Record<string, string> = {
  past_time: "That slot has already started — pick a later one.",
  too_far_ahead: "That day isn't open for booking yet. Try a date closer to today.",
  slot_taken: "Someone just took that slot. Refresh the schedule to see what's left.",
  insufficient_balance: "Not enough credits — top up your wallet and try again.",
  court_not_found: "That court isn't available any more. Refresh the schedule.",
  duplicate_request: "That booking already went through — refresh to see it.",
  already_started: "That booking has already started, so it can't be cancelled.",
  booking_not_found: "That booking is no longer there. Refresh the schedule.",
  block_not_found: "That block has already been lifted.",
};

/** The sign-out sentence. The 401 handler in `lib/api.ts` does the actual redirect. */
export const SESSION_LOST_TEXT = "Your session has expired — sign in again to book.";

/**
 * `insufficient_balance` as an ADMIN booking on somebody else's behalf sees it.
 *
 * <p>
 * The shared sentence above says "top up your wallet", which is right for a member and
 * wrong for a club desk: the short wallet is not theirs, and a desk account's balance is
 * zero permanently because it never plays. Two audiences, one error code — which is why
 * the code, not the status, is what the client branches on.
 * </p>
 *
 * <p>
 * This is the degenerate path. Ordinarily the refusal carries `current_credits` and
 * `required_credits` and the schedule turns it into §8's override offer with the figures
 * in it; this sentence is what is left when those are missing.
 * </p>
 */
export const MEMBER_SHORT_TEXT =
  "That member doesn't have enough credit for this court. Try again to see what they're short by.";

/**
 * The same refusal when the short wallet is the signed-in admin's own.
 *
 * <p>
 * §8's override is `payer.AllowNegativeBalance && actorId != userId` on the server
 * (`BookingService`), so an admin cannot authorise an overdraft on themselves — an actor
 * approving their own negative balance is not an override, it is an unlimited credit line.
 * The picker lists the admin along with every other active member, so this refusal is
 * reachable; before this sentence existed the screen offered the override anyway, refused
 * it on the second press, discarded the figures and told the admin to "try again to see
 * what they're short by", which returned them to the start with nothing new to see.
 * </p>
 */
export const ADMIN_SELF_SHORT_TEXT =
  "You don't have enough credit for this court. The admin override only works on another member's " +
  "wallet, not your own — top up and book it again.";

function describePeakHours(err: ApiError): string {
  const start = err.detail("peak_start");
  const end = err.detail("peak_end");
  const hours = err.detail("regular_advance_hours");
  if (start === null || end === null || hours === null) {
    return "Peak-hour slots are reserved for league and senior members until closer to the time.";
  }
  const window = hours === 1 ? "an hour" : `${hours} hours`;
  return `${start}–${end} is reserved for league and senior members until ${window} before the slot. `
    + `You can take it if it's still free ${window} before it starts.`;
}

function describePerDayCap(err: ApiError): string {
  const cap = err.detail("cap_minutes");
  const booked = err.detail("already_booked_minutes");
  if (cap === null || booked === null) return "You've reached your daily court-time limit for that day.";
  return `You already have ${booked} of your ${cap} minutes booked for that day. `
    + "Cancel one of them, or pick another day.";
}

function describeOutOfHours(err: ApiError): string {
  const opens = err.detail("opens_at");
  const closes = err.detail("closes_at");
  if (opens === null || closes === null) return "The club is closed at that time.";
  return `The club is open ${opens}–${closes} that day. Pick a time inside those hours.`;
}

function describeInvalidDuration(err: ApiError): string {
  const max = err.detail("max_slices");
  return max === null
    ? "That booking length isn't allowed."
    : `A booking can be 1 to ${max} slots long.`;
}

/**
 * @param fallback what to say when the server gave nothing recognisable — phrase it as
 * something the member can do, never as "an error occurred".
 */
export function describeBookingError(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;

  // A lapsed or missing session reaches here as 401 (the client's own handler signs the
  // member out) and, on a deployment whose hostname carries no tenant subdomain, as a
  // 400 `tenant_unresolved` from the tenancy middleware before authorization ever runs.
  // Both mean the same thing to the person holding the phone.
  if (e.status === 401 || e.code === "tenant_unresolved") return SESSION_LOST_TEXT;

  switch (e.code) {
    case "peak_hours_league_only": return describePeakHours(e);
    case "per_day_cap_exceeded": return describePerDayCap(e);
    case "out_of_hours": return describeOutOfHours(e);
    case "invalid_duration": return describeInvalidDuration(e);
    case "no_time_available": return "There's no free time on that court right now.";
    default: break;
  }

  if (e.code !== null && e.code in BOOKING_ERROR_TEXT) return BOOKING_ERROR_TEXT[e.code];
  return fallback;
}

/**
 * The message after a cancellation, naming what actually moved.
 *
 * <p>
 * The same concern as the refusals above — an API outcome turned into a sentence — and
 * here for the same reason: it lives beside the copy it belongs with, and it is a plain
 * function that a test can call without rendering a page.
 * </p>
 *
 * <p>
 * It replaces "Booking cancelled — refund pending.", which was shown identically when
 * 50.00 credits came back, when 35.00 came back with 15.00 kept as a penalty, and when
 * a checked-in member lost the whole price and nothing came back at all. Nothing in that
 * sentence was true in the third case, and the member had no other way to find out.
 * </p>
 */
export function cancellationOutcome(refunded: number, penalty: number): string {
  if (refunded <= 0 && penalty <= 0) {
    return "Booking cancelled. Nothing was refunded — the lights had already been on.";
  }
  if (penalty > 0) {
    return `Booking cancelled. ${formatCredits(refunded - penalty)} back to your credit, `
      + `${formatCredits(penalty)} kept as the late-cancellation penalty.`;
  }
  return `Booking cancelled. ${formatCredits(refunded)} back to your credit.`;
}
