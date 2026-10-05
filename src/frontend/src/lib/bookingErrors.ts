import { ApiError } from "./api";
import { NotSent, UnsureOutcome } from "./bookingOutcome";
import type { SplitCancel } from "./bookingsApi";
import { minutesSpoken } from "./minutes";
import { rateLimitedSentence } from "./errors";

/**
 * Booking refusals, turned into sentences a member can act on.
 *
 * <p>
 * The schedule used to branch on the HTTP STATUS: 402 meant "buy more", 409 meant "just
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
/**
 * R15 D15-5 — a member's own booking once they have checked in: the 409 `already_checked_in`, and
 * the grid's cancel sheet saying it up front off the quote's `checkedIn` (so it is never reached).
 */
export const ALREADY_CHECKED_IN_TEXT =
  "You've checked in to this booking, so it can't be cancelled — the court is yours until it ends. If something's wrong, speak to the club.";

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
  insufficient_balance: "Not enough minutes — buy a package and try again.",
  court_not_found: "That court isn't on the schedule any more. The schedule behind this is up to date now.",
  duplicate_request: "That booking already went through — it's on the schedule behind this.",
  already_started: "That booking has already started, so it can't be cancelled.",
  // R15 D15-5 — a member may not cancel a booking they have checked in to: the lights have been
  // on, nothing would come back, and the slot would be sold twice. The club can still cancel it.
  already_checked_in: ALREADY_CHECKED_IN_TEXT,
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
 *
 * <p>
 * <b>It never claims nothing happened</b> (review round 1, F1.1). A 504 after the club had
 * already booked and charged was told "Nothing was booked and no minutes were taken". The sheets
 * re-read the day first and say what the schedule shows (`UNSURE_TEXT`); this is what is left
 * for a caller that cannot look.
 * </p>
 */
export type BookingAction = "book" | "cancel";

const SERVER_DOWN_TEXT: Record<BookingAction, string> = {
  book: "The club's system didn't answer, so this may or may not have gone through. Check the schedule, then try again in a minute.",
  cancel: "The club's system didn't answer, so the booking may or may not have been cancelled. Check the schedule, then try again in a minute.",
};

/**
 * An unanswered write, after the sheet re-read the day and looked (see `lib/bookingOutcome`).
 * `checked` — the schedule showed it had not landed; unchecked — even the look failed.
 */
export const UNSURE_TEXT: Record<BookingAction, { checked: string; unchecked: string }> = {
  book: {
    checked: "The club's system didn't answer, so we checked the schedule: the slot is still free — nothing was booked and no minutes were taken. Try again in a minute.",
    unchecked: "The club's system didn't answer and the schedule couldn't be read either, so we can't tell whether this was booked. Check the schedule and your wallet before trying again.",
  },
  cancel: {
    checked: "The club's system didn't answer, so we checked the schedule: the booking is still there — nothing was cancelled and no minutes moved. Try again in a minute.",
    unchecked: "The club's system didn't answer and the schedule couldn't be read either, so we can't tell whether it was cancelled. Check the schedule and your wallet before trying again.",
  },
};

/** R3 I-4 — offline before sending: certain that nothing happened, and said so. */
export const NOT_SENT_TEXT: Record<BookingAction, string> = {
  book: "You're offline, so nothing was sent — nothing was booked and no minutes were taken. Try again when you're back online.",
  cancel: "You're offline, so nothing was sent — the booking is still there and no minutes moved. Try again when you're back online.",
};

/**
 * R4 I4-3 — the club's rate limit refused the write before it ran (`429 { error: "rate_limited",
 * retry_after_seconds }`), so nothing happened — said, with the wait the club gave. It read as
 * the generic "Couldn't make that booking", and the seconds were never used.
 */
export const RATE_LIMITED_TAIL: Record<BookingAction, string> = {
  book: "Nothing was booked and no minutes were taken.",
  cancel: "The booking is still there and no minutes moved.",
};

function describeRateLimited(e: ApiError, action: BookingAction): string {
  return `${rateLimitedSentence(Number(e.detail("retry_after_seconds")) || null)} ${RATE_LIMITED_TAIL[action]}`;
}

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

const slotWord = (n: number) => (n === 1 ? "slot" : "slots");
const count = (value: string | number | null): number | null =>
  (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null);

/**
 * R8 J8-1 — the daily SLOT limit, with its figures. It fell through to the sheet's fallback, "Try
 * again in a moment", which can never work. Partner seats the member said yes to count against it
 * (the server's `BookingRules.HeldAsync`), so the sentence says so: a grid reading "2 of 4" was
 * refused at 4. About the member when the desk books for them (`forName`).
 */
function describePerDaySlotCap(err: ApiError, context: BookingErrorContext): string {
  const name = context.forName ?? null;
  const [has, your, youve] = name ? [`${name} already has`, "their", "they've"] : ["You already have", "your", "you've"];
  const cap = count(err.detail("cap_slots"));
  const booked = count(err.detail("booked_slots"));
  const joined = `games ${youve} said yes to`;
  const group = typeof err.detail("group_name") === "string" ? ` The limit is the ${err.detail("group_name")} group's.` : "";
  if (cap === null || booked === null) {
    return `${name ? `${name} has` : "You've"} booked all ${your} slots for that day — ${joined} count too. Cancel one, or pick another day.${group}`;
  }
  const left = count(err.detail("remaining_slots")) ?? Math.max(0, cap - booked);
  if (left > 0) {
    return `${name ? `${name} can` : "You can"} book ${left} more ${slotWord(left)} that day — ${booked} of ${your} ${cap} are booked, `
      + `counting ${joined}. Pick fewer, or another day.${group}`;
  }
  return `${has} ${booked} of ${your} ${cap} ${slotWord(cap)} booked for that day — ${joined} count too. Cancel one, or pick another day.${group}`;
}

function describeOutOfHours(err: ApiError): string {
  const opens = err.detail("opens_at");
  const closes = err.detail("closes_at");
  if (opens === null || closes === null) return "The club is closed at that time.";
  return `The club is open ${opens}–${closes} that day. Pick a time inside those hours.`;
}

/** "Juniors", "Juniors and Seniors" — the groups a window refusal names. */
function groupNames(err: ApiError): string | null {
  const payload = err.payload as Record<string, unknown> | null | undefined;
  const raw = payload && typeof payload === "object" ? payload.groups ?? payload.group_name : undefined;
  const list = (Array.isArray(raw) ? raw : [raw]).filter((x): x is string => typeof x === "string" && x.trim() !== "");
  if (list.length === 0) return null;
  return list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * The member's groups leave no time at all that day (`no_bookable_window`) or not this time
 * (`group_window`). Said about the MEMBER when an admin is booking for them (F1.5): the desk's
 * booking follows that member's group times — god mode lifts the balance check and the daily cap, never
 * a group's window — so the sentence says that plainly, and where it can be changed.
 */
function describeGroupWindow(err: ApiError, forName: string | null | undefined): string {
  const groups = groupNames(err);
  const day = dayInWords(err.detail("day"));
  const onDay = day ? ` on ${day}` : " that day";
  const noun = groups?.includes(" and ") ? "groups" : "group";
  const whose = (lead: boolean) => {
    const owner = forName ? `${forName}'s` : lead ? "Your" : "your";
    return groups ? `${owner} ${noun} (${groups})` : `${owner} groups`;
  };
  const override = forName
    ? " Booking for a member follows their group's times and an admin can't override that — change the group's times on the Groups page, or book it as a club hold."
    : " Speak to the club if that's wrong.";
  if (err.code === "no_bookable_window") {
    return `${whose(true)} can't book at all${onDay} — the booking times don't overlap.${override}`;
  }
  const windows = allowedWindows(err);
  const when = windows ? ` ${forName ? "They" : "You"} can book ${windows}${onDay}.` : "";
  return `That time is outside ${whose(false)} booking times.${when}${override}`;
}

/** The server's day keys (`OperatingHours.DayKeys`) as the weekday a member reads. */
const DAY_WORDS: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};

/**
 * "wed" → "Wednesday" (R2 F1-4: the refusal said "on wed"). A word the server already spelled
 * out passes through; anything unrecognisable is dropped, and the sentence says "that day".
 */
function dayInWords(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const key = raw.trim().toLowerCase().slice(0, 3);
  const word = DAY_WORDS[key];
  if (!word) return null;
  return raw.trim().length <= 3 ? word : raw.trim()[0].toUpperCase() + raw.trim().slice(1);
}

/**
 * Would asking again change the answer? Not for a refusal about the member or the rules (a 4xx
 * with a reason) — a Try again beside "outside your group's times" promises what it cannot do
 * (R2 F1-4). A failure to hear back, a 5xx, a timeout (408) or a rate limit (429) may pass.
 */
export function worthRetrying(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  return e.status >= 500 || e.status === 408 || e.status === 429 || e.status === 401;
}

function allowedWindows(err: ApiError): string | null {
  const payload = err.payload as Record<string, unknown> | null | undefined;
  const raw = payload && typeof payload === "object" ? payload.allowed_windows : undefined;
  if (!Array.isArray(raw)) return null;
  const spans = raw
    .map((w) => (w && typeof w === "object" ? w as { start?: unknown; end?: unknown } : {}))
    .filter((w): w is { start: string; end: string } => typeof w.start === "string" && typeof w.end === "string")
    .map((w) => `${w.start}–${w.end}`);
  return spans.length ? spans.join(", ") : null;
}

function describeInvalidDuration(err: ApiError): string {
  const max = err.detail("max_slices");
  return max === null
    ? "That booking length isn't allowed."
    : `A booking can be 1 to ${max} slots long.`;
}

/** The refusals whose sentence carries the figures the refusal sent. */
const FIGURED: Record<string, (e: ApiError, context: BookingErrorContext) => string> = {
  peak_hours_league_only: describePeakHours,
  per_day_cap_exceeded: describePerDayCap,
  per_day_slot_cap_exceeded: describePerDaySlotCap,
  out_of_hours: describeOutOfHours,
  invalid_duration: describeInvalidDuration,
  no_time_available: () => "There's no free time on that court right now.",
  group_window: (e, context) => describeGroupWindow(e, context.forName),
  no_bookable_window: (e, context) => describeGroupWindow(e, context.forName),
};

/** Who the booking is for and what was being done — both change the sentence. */
export type BookingErrorContext = {
  action?: BookingAction;
  /** The member's first name when an admin is acting for them. */
  forName?: string | null;
};

/**
 * @param fallback what to say when the server gave nothing recognisable — phrase it as
 * something the member can do, never as "an error occurred".
 */
export function describeBookingError(e: unknown, fallback: string, context: BookingErrorContext = {}): string {
  const action = context.action ?? "book";
  if (e instanceof NotSent) return NOT_SENT_TEXT[action];
  if (e instanceof UnsureOutcome) return e.checked ? UNSURE_TEXT[action].checked : UNSURE_TEXT[action].unchecked;
  if (!(e instanceof ApiError)) return fallback;

  // A lapsed or missing session reaches here as 401 (the client's own handler signs the
  // member out) and, on a deployment whose hostname carries no tenant subdomain, as a
  // 400 `tenant_unresolved` from the tenancy middleware before authorization ever runs.
  // Both mean the same thing to the person holding the phone.
  if (e.status === 401 || e.code === "tenant_unresolved") return SESSION_LOST_TEXT;
  if (e.status === 429) return describeRateLimited(e, action);
  if (e.status >= 500) return SERVER_DOWN_TEXT[action];

  const withFigures = e.code !== null ? FIGURED[e.code] : undefined;
  if (withFigures) return withFigures(e, context);

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
 * R5 M5-7 — what came back to the organiser on a split cancel. `refunded` is the GROSS refund and
 * the penalty is its own ledger row; a server whose `net_minutes` is `refunded − partners` left
 * the penalty out ("25 min back" for a ledger +50 −15 −25 = +10). Such a net is corrected here;
 * a net that already counts the penalty (or one from the quote) is taken as it is.
 */
function splitBack(refunded: number, penalty: number, split: SplitCancel): number {
  if (penalty <= 0) return split.net;
  const partners = split.partners.reduce((n, p) => n + p.minutes, 0);
  return split.net === refunded - partners ? split.net - penalty : split.net;
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
 * 50 min came back, when 35 min came back with 15 min kept as a penalty, and when
 * a checked-in member lost the whole price and nothing came back at all. Nothing in that
 * sentence was true in the third case, and the member had no other way to find out.
 * </p>
 *
 * <p>
 * `member` is the first name of the person whose booking it was, and it is present exactly
 * when an ADMIN cancelled on somebody else's behalf. §7 is explicit that "refunds always
 * go to the booking's player", and the sentence said "back to your balance" to a desk
 * account whose own balance never moved — first person about another person's money, with
 * the member never named. An admin acting for someone should be told whose minutes moved.
 * </p>
 */
export function cancellationOutcome(
  refunded: number | null, penalty: number | null, member?: string | null, split?: SplitCancel | null,
): string {
  const whose = member ? `${member}'s balance` : "your balance";
  // F1.1 — the schedule shows it gone but the reply with the figures was lost. R15 X15-7 — it
  // claims nothing about the screen under it: a booking's own page re-reads and shows the refund.
  if (refunded === null || penalty === null) {
    return `Booking cancelled. The club's reply didn't arrive, so its figures aren't in this message — ${member ? `${member}'s` : "your"} wallet shows what came back.`;
  }
  if (refunded <= 0 && penalty <= 0) {
    return member
      ? `Booking cancelled. Nothing was refunded — ${member} had already checked in and the lights had been on.`
      : "Booking cancelled. Nothing was refunded — the lights had already been on.";
  }
  // F1.13 — a split booking: what the organiser keeps, and each partner's share, by name.
  const partners = split ? `; ${split.partners.map((p) => `${minutesSpoken(p.minutes)} to ${p.name}`).join(", ")}` : "";
  const back = split ? splitBack(refunded, penalty, split) : refunded - (penalty > 0 ? penalty : 0);
  if (penalty > 0) {
    return `Booking cancelled. ${minutesSpoken(back)} back to ${whose}${partners}, `
      + `${minutesSpoken(penalty)} kept as the late-cancellation penalty.`;
  }
  return `Booking cancelled. ${minutesSpoken(split ? split.net : refunded)} back to ${whose}${partners}.`;
}
