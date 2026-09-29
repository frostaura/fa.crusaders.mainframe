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
  /**
   * Only an admin booking ON BEHALF of somebody reaches this: a member meets the club's
   * closing time first. The desk is exempt from the opening hours on purpose, so the only
   * thing left stopping them is the end of the day itself, and it has to say so — the
   * refusal it used to get named the whole day as the times the member may book, under a
   * refusal at 23:41.
   */
  crosses_midnight: "That booking would run past midnight, and a booking has to finish on the day it starts. Shorten it, or start it earlier.",
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

function describePeakHours(err: ApiError): string {
  const start = err.detail("peak_start");
  const end = err.detail("peak_end");
  const hours = err.detail("regular_advance_hours");
  const withheld = withheldBy(err);
  if (start === null || end === null || hours === null) {
    return withheld ?? "Peak-hour slots are reserved for league and senior members until closer to the time.";
  }
  const window = hours === 1 ? "an hour" : `${hours} hours`;
  if (withheld) {
    return `${start}–${end} is peak time. ${withheld} You can take it if it's still free ${window} before it starts.`;
  }
  return `${start}–${end} is reserved for league and senior members until ${window} before the slot. `
    + `You can take it if it's still free ${window} before it starts.`;
}

/**
 * D2: the groups that withheld peak priority, named — `withheld_by_groups: [names]` on the refusal.
 * A member told "reserved for league members" who IS a league member, and is also in a group that
 * withholds it, needs the group's name to know what to ask the club about.
 */
function withheldBy(err: ApiError): string | null {
  const payload = err.payload as Record<string, unknown> | null | undefined;
  const raw = payload && typeof payload === "object" ? payload.withheld_by_groups : undefined;
  const names = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return names.length === 1
    ? `Your group ${list} doesn't get early peak booking, so you book peak hours like everyone else.`
    : `Your groups ${list} don't get early peak booking, so you book peak hours like everyone else.`;
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
