import { ApiError } from "./api";
import { formatCredits } from "./utils";
import { describeFailure } from "./errors";

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
  // These four used to end "Refresh the schedule", inside a modal that covered the only
  // Refresh control on the page — a real click on it is intercepted by the dialog's own
  // overlay — and beside a grid that went on offering the slot as Available for ever, since
  // nothing polls. The app now refetches the day BEFORE the sentence renders (see
  // `provesStaleGrid` below), so the sentence states what has happened rather than asking
  // for something the member cannot do.
  slot_taken: "Someone just took that slot. The schedule behind this is up to date now — pick another time.",
  insufficient_balance: "Not enough credits — top up your wallet and try again.",
  court_not_found: "That court isn't on the schedule any more. The schedule behind this is up to date now.",
  duplicate_request: "That booking already went through — it's on the schedule behind this.",
  already_started: "That booking has already started, so it can't be cancelled.",
  booking_not_found: "That booking is no longer there. The schedule behind this is up to date now.",
  block_not_found: "That block has already been lifted.",
  // A suspended membership is not a stale screen. Without this key the refusal fell through to
  // the schedule's fallback — "Couldn't make that booking. Refresh the schedule and try again." —
  // which is advice that can never work: the member refreshes, presses Book again, and gets the
  // same refusal with no way to learn why. The club is the only repair there is.
  member_suspended: "Your membership is suspended, so you can't book. Speak to the club to have it restored.",
  // The same rule, for a membership the club has not approved or has turned down. It reads
  // mostly to the DESK: a member in either state cannot sign in, so the screen this appears on
  // is the admin's book-on-behalf dialog, where the fix is one click away on the Members page.
  member_not_active: "That membership isn't active yet, so it can't be booked against. Approve it on the Members page first.",
  waive_reason_required: "Say why the penalty is being waived — the club's audit needs the reason, not just the tick.",
};

/**
 * What a 5xx means to the person holding the phone.
 *
 * <p>
 * Every server-side failure used to arrive as the booking fallback — "Refresh the schedule
 * and try again" — which is advice for a stale grid and simply wrong for a gateway that is
 * down: refreshing fails too, and the member is told to keep trying something that cannot
 * work. A 5xx is never the member's doing and there is nothing on the schedule for them to
 * fix.
 * </p>
 */
const SERVER_DOWN_TEXT = "The club's system isn't answering right now. Nothing was booked and no credit was taken — try again in a minute.";

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
  if (e.status >= 500) return SERVER_DOWN_TEXT;

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
 * Does this refusal prove the client's copy of the day is out of date?
 *
 * <p>
 * L-F2. Every one of these is the server saying "what you are looking at is not what is
 * there" — and the schedule did nothing about it. A finder booked a slot an admin had taken
 * in another browser, got the refusal, and watched the grid go on showing that slot as
 * <em>Available</em> for thirty seconds and indefinitely after: no refetch was issued, there
 * is no polling, and the page's only Refresh control sits behind the modal's own
 * <code>aria-modal</code> overlay, which intercepts the click. The <code>out_of_hours</code>
 * variant is worse — an admin moving Monday's closing time to 09:00 leaves every slot from
 * 09:00 to 19:15 still drawn as bookable until something reloads the day.
 * </p>
 *
 * <p>
 * So the callers refetch on these codes, and <em>await</em> the refetch before showing the
 * sentence, which is what lets the sentences above say the schedule is up to date instead of
 * asking the member to make it so. A refusal that is about the member rather than about the
 * day — <code>insufficient_balance</code>, <code>per_day_cap_exceeded</code>,
 * <code>peak_hours_league_only</code>, <code>member_suspended</code> — is deliberately not
 * here: refetching would not change it, and a needless day-sized read on every refusal is
 * how a mobile grid gets slow.
 * </p>
 */
const STALE_GRID_CODES = new Set([
  "slot_taken", "court_not_found", "duplicate_request",
  "out_of_hours", "past_time", "too_far_ahead",
  "booking_not_found", "block_not_found",
]);

export function provesStaleGrid(e: unknown): boolean {
  return e instanceof ApiError && e.code !== null && STALE_GRID_CODES.has(e.code);
}

/**
 * The same two membership refusals, said to a member standing in front of the code screen
 * rather than in front of the schedule — or null when this is not that refusal.
 *
 * <p>
 * `POST /me/qr/generate` refuses a barred member, because the screen it feeds promises the
 * code will "start a walk-up on a free court, or pay for someone else's time" and the box
 * refuses a barred member every one of those. Round 7 made the code inert without making
 * the screen say so, which left a member holding a QR nothing would honour.
 * </p>
 *
 * <p>
 * Its own sentences rather than {@link describeBookingError}'s, for the reason that file
 * already carries twice (see {@link MEMBER_SHORT_TEXT}): one code, two audiences. The
 * schedule's version says "you can't book", which is the wrong half of the truth here —
 * nothing on this screen books anything — and `member_not_active`'s says "approve it on the
 * Members page", which is an instruction to a desk, on a screen only the member sees.
 * </p>
 *
 * <p>
 * <b>Null, not a fallback sentence.</b> The caller needs to tell a barred membership from a
 * flat battery: one is permanent and the screen must stop offering the code, the other
 * clears on its own and the screen should keep trying.
 * </p>
 */
export function describeCourtCodeRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 403) return null;
  if (e.code === "member_suspended") {
    return "Your membership is suspended, so a court code would not open anything — the boxes turn one away. "
      + "Speak to the club to have it restored.";
  }
  if (e.code === "member_not_active") {
    return "Your membership isn't active yet, so a court code would not open anything — the boxes turn one away. "
      + "The club has to approve it first.";
  }
  return null;
}

/**
 * What the court-code screen says when a fetch failed for a reason that is NOT the club
 * barring the member — i.e. every case {@link describeCourtCodeRefusal} answers null for.
 *
 * <p>
 * `screen` is which of the page's two cards is asking, and it exists because one of these
 * sentences names a control. The code card has "Refresh" on it and a code to refresh; the
 * barred card has neither — its only control is "Check again", and that card's test asserts
 * no control named Refresh is on it at all. A single shared string told a barred member
 * "Too many refreshes" on a card showing no code and offering no refresh; reproduced in a
 * real browser, not only in jsdom.
 * </p>
 *
 * <p>
 * The rate limit is reachable on both. `POST /me/qr/generate` sits behind the API's auth
 * bucket, which is shared with login, and neither button paces itself — `MIN_REFRESH_GAP_MS`
 * paces only the automatic pre-fetch. A member pressing the barred card's button while the
 * desk sorts their membership out is precisely who hits it.
 * </p>
 *
 * <p>
 * A plain function beside the copy it belongs with, for the reason the refusals above are:
 * a test can call it without rendering a page, and the two sentences stay where a reader
 * comparing them will find them together.
 * </p>
 */
export function describeCourtCodeFetchFailure(e: unknown, screen: "code" | "barred"): string {
  if (e instanceof ApiError && e.status === 429) {
    return screen === "barred"
      ? "That's a lot of checking at once. Give it a moment, then check again."
      : "Too many refreshes. Give it a moment and try again.";
  }
  // Only a NetworkError is genuinely a connection problem; describeFailure enforces that.
  // This returned the connection sentence for every non-429 failure, so a member whose club
  // had no tenant row, or whose session had lapsed, was sent to check their WiFi.
  return describeFailure(e, { action: "get a code" });
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
 *
 * <p>
 * `member` is the first name of the person whose booking it was, and it is present exactly
 * when an ADMIN cancelled on somebody else's behalf. §7 is explicit that "refunds always
 * go to the booking's player", and the sentence said "back to your credit" to a desk
 * account whose own balance never moved — first person about another person's money, with
 * the member never named. An admin acting for someone should be told whose credit moved.
 * </p>
 */
export function cancellationOutcome(refunded: number, penalty: number, member?: string | null): string {
  const whose = member ? `${member}'s credit` : "your credit";
  if (refunded <= 0 && penalty <= 0) {
    return member
      ? `Booking cancelled. Nothing was refunded — ${member} had already checked in and the lights had been on.`
      : "Booking cancelled. Nothing was refunded — the lights had already been on.";
  }
  if (penalty > 0) {
    return `Booking cancelled. ${formatCredits(refunded - penalty)} back to ${whose}, `
      + `${formatCredits(penalty)} kept as the late-cancellation penalty.`;
  }
  return `Booking cancelled. ${formatCredits(refunded)} back to ${whose}.`;
}
