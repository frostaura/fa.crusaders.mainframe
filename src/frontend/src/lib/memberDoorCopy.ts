import { GATE_ROSTER_MAX_ENTRIES } from "./gateCopy";
import { formatClock, formatCountdown } from "./countdown";
import type {
  MemberDoorBooking,
  MemberDoorContact,
  MemberDoorMembership,
  MemberDoorMembershipDetail,
  MemberDoorPolicy,
} from "./api";

/**
 * Everything the member's door surfaces say, in the member's own voice.
 *
 * <p>
 * Second person, present tense. This is deliberately NOT an addition to `gateCopy.ts`:
 * that module is the admin's register — third person, about somebody else's scan — and
 * `deviceActivity.ts` says so in its own words. Two registers in one file is how one gets
 * pasted into the other, and the sentence that results is either a club being told what
 * to do about its own membership or a member being told about "that membership".
 * </p>
 *
 * <p>
 * The ban list below is not a style guide. A door here is a board that pulls, decides
 * locally and energises a lock; there is no sensor on the door, no exit detection and no
 * way to push anything to it. Every banned substring is a claim a reader would act on and
 * be wrong to — see the matrix test beside this file, which sweeps every sentence this
 * module can build, not merely the ones a page happens to render today.
 * </p>
 */

/**
 * The substrings no sentence here may contain, in any casing.
 *
 * <p>
 * The first group mirrors the claim probe the court-code page already carries. The last
 * three are this surface's own: a queued open is not immediate, a pull-only board makes
 * every timing promise a lie, and this product measures nobody's comings and goings.
 * </p>
 */
export const BANNED_IN_MEMBER_DOOR_COPY = [
  "attendance",
  "check in",
  "checked in",
  "checking in",
  "marks you as arrived",
  "lights",
  "relay",
  "lockdown",
  "secure the building",
  "operator",
  "always",
  "guarantee",
  "instant",
  "immediately",
  "presence",
] as const;

/** What a door the club has not got round to naming is called, in words. */
export const UNNAMED_DOOR = "a door the club hasn't named yet";

export type DecisionTone = "success" | "info" | "warning" | "danger";
export type ChipTone = "muted" | "success" | "info" | "warning" | "danger";

/** What a member can do next. The page turns each into a control; this decides which exist. */
export type DecisionAction =
  | { kind: "book_a_court"; label: string }
  | { kind: "refresh_the_code"; label: string }
  | { kind: "call_the_club"; label: string; href: string }
  | { kind: "email_the_club"; label: string; href: string };

type ActionKind = DecisionAction["kind"];

/**
 * The per-reason sentence in the member's voice.
 *
 * <p>
 * Same keys as `deviceActivity.DOOR_REFUSAL_REASONS` — the member and the admin are
 * looking at the same seven decisions a door can make — and not one shared sentence,
 * because they are not the same reader and the two files must not be copy-pasted into
 * each other. Both halves are pinned by the matrix test.
 * </p>
 */
export const MEMBER_DOOR_REASON_LINES: Record<string, string> = {
  ok: "Your code was accepted and the door's board reported releasing its lock.",
  not_recognised: "Your code had run out, or wasn't one of this club's.",
  member_not_active: "The club had your membership as not active.",
  no_booking: "You had no court booked that the door would open for.",
  too_early: "Your court hadn't opened the door yet.",
  method_not_supported: "The board at that door asked something a door doesn't answer — nothing you did caused it.",
  not_a_gate: "That board is a court box rather than a door, so it was never going to open for your code.",
};

// --- club contact ------------------------------------------------------------------

/** A phone number as a dialable link. Spaces are for reading, not for dialling. */
function telHref(phone: string): string {
  return `tel:${phone.replace(/\s+/g, "")}`;
}

/**
 * The one control a refused member can press that reaches a human, or none.
 *
 * <p>
 * Both halves of the conditional, and then the third: a club with a number gets a call
 * button, a club with only an address gets an email one, and a club that has given the
 * app neither gets {@link contactMissingNotice} instead of a dead grey rectangle.
 * </p>
 */
function contactAction(contact: MemberDoorContact): DecisionAction | null {
  if (contact.phone) return { kind: "call_the_club", label: "Call the club", href: telHref(contact.phone) };
  if (contact.email) return { kind: "email_the_club", label: "Email the club", href: `mailto:${contact.email}` };
  return null;
}

/** The lead-in above the club's number in the page footer. */
export const CONTACT_LEAD = "Can't get in?";

/**
 * What a member is told when the club has given the app no way to reach it.
 *
 * <p>
 * The parenthesis is shown to every member on purpose. At a volunteer club the person
 * standing outside is quite often also on the committee, and it turns a dead end into a
 * fix somebody can make tonight.
 * </p>
 */
export function contactMissingNotice(): string {
  return "This club hasn't given the app a number to call. Whatever is written on the door is the only way"
    + " from here. (Club admins can add one under Admin settings.)";
}

/** The club's contact, as one line of plain text, or null when there is nothing to say. */
export function contactLine(contact: MemberDoorContact): string | null {
  const parts = [contact.phone, contact.email].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : null;
}

/** The sentence that closes a conclusion: a number, an address, or the door notice. */
function reachTheClub(contact: MemberDoorContact): string {
  if (contact.phone) return `Phone the club on ${contact.phone}.`;
  if (contact.email) return `Write to the club at ${contact.email}.`;
  return "Whatever is written on the door is the only way from here.";
}

// --- the decision card ---------------------------------------------------------------

export type DecisionContext = {
  /** The formatted time left of a `too_early` window, or null when there is no window. */
  countdown: string | null;
  /** When the door starts opening for this member, on the clock. */
  opensAtClock: string | null;
  /** When their court starts, on the clock. */
  bookingStartsClock: string | null;
  /**
   * `early_entry_minutes` from the response — the club's own number, already clamped.
   *
   * <p>
   * Zero means "the club has no early-entry window set", which is a real setting and not
   * an absent field; see {@link armNoBooking} for the sentence it earns.
   * </p>
   */
  earlyEntryMinutes: number;
  contact: MemberDoorContact;
};

export type MemberDecisionCopy = {
  tone: DecisionTone;
  headline: string;
  body: string;
  actions: DecisionAction[];
};

type Arm = { tone: DecisionTone; headline: string; body: string; wants: ActionKind[] };

/**
 * The open. P2, and the sentence easiest to get wrong on the whole surface.
 *
 * <p>
 * The board reported releasing its lock. It did not report that a door moved and it
 * cannot — there is nothing on the door to tell it. "The door opened" is a claim about
 * a hinge that nothing in this system has ever observed.
 * </p>
 */
function armOk(): Arm {
  return {
    tone: "success",
    headline: "The lock released.",
    body: "That is what the door's board reported doing. There is no sensor on a door here, so this screen"
      + " can't tell you the door moved — and nothing about your booking changed either, because a door"
      + " marks nobody as having arrived.",
    wants: [],
  };
}

/**
 * The open, at a door that had lost the club's network — the other half of P6's
 * conditional, and a genuinely different event from the one above.
 *
 * <p>
 * The board did not ask the club anything. It matched the code against the list of
 * bookings it had downloaded earlier and released the lock on its own, and the club's
 * record of it arrived when the board next got through. A member who is told only "the
 * lock released" has not been told that their booking was checked against a snapshot —
 * which is exactly the fact that explains why the door let them in on a night the club's
 * own screens showed nothing.
 * </p>
 *
 * <p>
 * A1.2 binds this arm as it binds {@link armOk}: the lock released, and nothing here says
 * a door moved or that anybody went through it.
 * </p>
 */
function armOkOffline(): Arm {
  return {
    tone: "success",
    headline: "The lock released — from the door's own list.",
    body: "That door couldn't reach the club when you held your code up, so it decided from the list of"
      + " bookings it had downloaded earlier. Its board reported releasing the lock, and the club's record"
      + " of it arrived afterwards. Nothing about your booking changed — a door marks nobody as having"
      + " arrived.",
    wants: [],
  };
}

/**
 * The one refusal that resolves itself, so it is a clock fact and must not be dressed as
 * a fault: info tone, live countdown, and no error styling anywhere in the arm.
 */
function armTooEarly(ctx: DecisionContext): Arm {
  const running = ctx.countdown !== null && ctx.countdown !== "0s";
  const arrived = ctx.countdown === "0s";
  const headline = running
    ? `Too early — the door opens for you in ${ctx.countdown}.`
    : arrived
      ? "The door opens for you now."
      : "Too early — the door hadn't opened for you yet.";
  const window = ctx.bookingStartsClock && ctx.opensAtClock
    ? `Your court at ${ctx.bookingStartsClock} doesn't open the door until ${ctx.opensAtClock}.`
    : "Your booking's door window hadn't opened when you held your code up.";
  return {
    tone: "info",
    headline,
    body: `${window} Nothing is wrong with your code — hold it up to the scanner again then.`,
    wants: [],
  };
}

/**
 * The club's early-entry window, in words a member reads rather than a count of minutes.
 *
 * <p>
 * `gate_early_entry_minutes` clamps to 0..240 server-side, so this only ever renders
 * something inside four hours — but "240 minutes" is a number nobody converts standing in
 * a doorway, which is the same argument `formatCountdown` already makes about a booking
 * code's quarter of an hour.
 * </p>
 */
export function formatWindowMinutes(minutes: number): string {
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourPart = hours === 1 ? "1 hour" : `${hours} hours`;
  if (rest === 0) return hourPart;
  return `${hourPart} ${rest === 1 ? "1 minute" : `${rest} minutes`}`;
}

/**
 * How near a booking has to be, said with the club's own number when it has one.
 *
 * <p>
 * Both halves. A club with `gate_early_entry_minutes` at zero has no window to name, and
 * "nothing booked in the next 0 minutes" is not a sentence — it is what a page prints when
 * it treats a real setting as an absent field. The wordless form is the floor.
 * </p>
 */
function bookingNearness(earlyEntryMinutes: number): string {
  if (earlyEntryMinutes > 0) return `in the next ${formatWindowMinutes(earlyEntryMinutes)}`;
  return "soon enough for a door to open";
}

function armNoBooking(ctx: DecisionContext): Arm {
  return {
    tone: "warning",
    headline: "The door needs a court booked.",
    body: "Your club opens its doors only for members with a court booked, and you have none starting"
      + ` ${bookingNearness(ctx.earlyEntryMinutes)}.`,
    wants: ["book_a_court"],
  };
}

function armNotActive(): Arm {
  return {
    tone: "danger",
    headline: "The club has your membership as not active.",
    body: "The door won't open for you until the club changes that. There's nothing you can fix on this phone.",
    wants: ["call_the_club"],
  };
}

function armNotRecognised(): Arm {
  return {
    tone: "warning",
    headline: "That code wasn't live any more.",
    body: "A code that has run out and a code that was never real look the same to a door, so it can't tell"
      + " you which. There's a fresh one below.",
    wants: ["refresh_the_code"],
  };
}

function armBoardFault(): Arm {
  return {
    tone: "danger",
    headline: "That door's scanner isn't set up right.",
    body: "The door answered in a way that means its board is misconfigured — not that anything is wrong"
      + " with you or with your code. Only the club can put it right.",
    wants: ["call_the_club"],
  };
}

/**
 * A reason this build has never heard of.
 *
 * <p>
 * It reaches a sentence rather than a blank card, and it never prints the raw token: a
 * member at a door has no use for `some_new_token`, and the club does not want it on a
 * screenshot either. The same rule `describeActivityReason` follows on the admin side.
 * </p>
 */
function armUnknown(): Arm {
  return {
    tone: "warning",
    headline: "The door turned you away.",
    body: "It didn't say why in a way this screen understands. The club can look up what happened.",
    wants: ["call_the_club"],
  };
}

/**
 * The key a reason looks its sentence up by.
 *
 * <p>
 * A null reason — what the endpoint answers for a refusal whose details would not parse —
 * is mapped to a key no table holds, rather than guarded separately at each of the three
 * call sites. "This build has no sentence for that" is the same finding whether the token
 * was absent or merely unrecognised, and the mutation pass that found this was right: two
 * spellings of one rule are two things to keep in step, and a redundant guard reads to the
 * next person as a second rule that must exist for a reason.
 * </p>
 */
function reasonKey(reason: string | null): string {
  return reason ?? "";
}

const ARMS: Record<string, (ctx: DecisionContext) => Arm> = {
  ok: armOk,
  too_early: armTooEarly,
  no_booking: armNoBooking,
  member_not_active: armNotActive,
  not_recognised: armNotRecognised,
  method_not_supported: armBoardFault,
  not_a_gate: armBoardFault,
};

const ACTION_LABELS: Record<"book_a_court" | "refresh_the_code", string> = {
  book_a_court: "Book a court",
  refresh_the_code: "Refresh the code",
};

function resolveActions(wants: ActionKind[], contact: MemberDoorContact): DecisionAction[] {
  const out: DecisionAction[] = [];
  for (const want of wants) {
    if (want === "book_a_court" || want === "refresh_the_code") {
      out.push({ kind: want, label: ACTION_LABELS[want] });
      continue;
    }
    const reach = contactAction(contact);
    if (reach) out.push(reach);
  }
  return out;
}

/**
 * The member's last door decision, as advice with a next action.
 *
 * <p>
 * `released` is the authoritative bit: a row the board let through is the open arm
 * whatever token travelled with it. Everything else forks on the reason — and a reason of
 * null, which the endpoint returns for a refusal whose details would not parse, lands on
 * {@link armUnknown} by the same route an unrecognised token does. Both are "the door
 * turned you away and this screen cannot say why", which is the honest sentence for each.
 * </p>
 *
 * <p>
 * <b>`offline` forks the OPEN only.</b> A refusal a cut-off door decided alone is the same
 * refusal for the same reason — the board applied the club's own rule to the list it had —
 * and a second sentence about the network there would be the page explaining a mechanism
 * instead of answering the question. The open is different because the club's own record
 * of it is late, which is a fact about what the member will and will not see next.
 * </p>
 */
export function describeDecision(
  decision: { reason: string | null; released: boolean; offline: boolean },
  ctx: DecisionContext,
): MemberDecisionCopy {
  const build = decision.released
    ? (decision.offline ? armOkOffline : armOk)
    : (ARMS[reasonKey(decision.reason)] ?? armUnknown);
  const arm = build(ctx);
  return { tone: arm.tone, headline: arm.headline, body: arm.body, actions: resolveActions(arm.wants, ctx.contact) };
}

/** `front-door · 06:04` — the club's own name for the door, and the time of the SCAN. */
export function decisionStamp(doorName: string | null, at: string): string {
  return `${doorName ?? UNNAMED_DOOR} · ${formatClock(at)}`;
}

/** Dropping the card is the member's call, so the control says what it does. */
export const DECISION_DISMISS = "Dismiss";

// --- the standing line ---------------------------------------------------------------

export const STANDING_HEADING = "What opens the door for you right now";
export const STANDING_LOADING = "Checking what opens the door for you…";

export type StandingLine = {
  body: string;
  /** Does this sentence carry a clock window of its own? */
  hasClockWindow: boolean;
  /**
   * Must the code card's own door clause be suppressed while this line is on screen?
   *
   * <p>
   * TWO reasons, and the second was found by looking at the rendered page rather than by
   * reading the design. The first is duplication: a line that carries a clock window makes
   * the code card's clause a second, vaguer copy of a fact already stated better ten
   * pixels away. The second is CONTRADICTION, which is worse. A member the club has as
   * not active, or one with no qualifying booking, is told here that no code of theirs
   * opens a door — while `describeDoor()`, fed by a different request that does not know
   * the policy, was promising "It also opens the club door from 20:54 until 22:29" a
   * centimetre above. That is a screen arguing with itself, which is precisely what one
   * response and one instant exist to prevent.
   * </p>
   *
   * <p>
   * When neither holds — the active-member arm, where the clause adds clock times this
   * line does not have — and whenever this line is absent, stale or failed, the clause is
   * restored. It is the FALLBACK SOURCE of door truth on the page, not decoration.
   * </p>
   */
  suppressesCodeClause: boolean;
  action: DecisionAction | null;
};

const ACTIVE_MEMBER_RULE = "Your club opens its doors for any active member.";
const BOOKING_RULE = "Your club opens its doors only for members with a court booked.";

/**
 * Which not-active this is, in the club's own vocabulary.
 *
 * <p>
 * The wave-1 wire shape carried three membership values, so this sentence used to say
 * "not active" and stop. The endpoint now carries the club's recorded status beside it,
 * and the difference is not cosmetic: a member whose application has not been approved has
 * something to wait for, a suspended one has a conversation to have, and a turned-down one
 * has neither. Naming the wrong one sends a person to the desk for nothing.
 * </p>
 *
 * <p>
 * `active` and `none` are absent on purpose — neither is a not-active state and neither
 * reaches {@link standingNotActive}.
 * </p>
 */
export const MEMBERSHIP_DETAIL_WORDS: Record<string, string> = {
  pending_approval: "not yet approved",
  rejected: "turned down",
  suspended: "suspended",
};

/** The fallback for a status this build has never heard of — `lapsed`, one day. */
const MEMBERSHIP_DETAIL_FALLBACK = "not active";

/** The membership half, which outranks every other: the club has to move first. */
function standingNotActive(rule: string, detail: MemberDoorMembershipDetail): StandingLine {
  const word = MEMBERSHIP_DETAIL_WORDS[detail] ?? MEMBERSHIP_DETAIL_FALLBACK;
  return {
    body: `${rule} The club has yours as ${word}, so no code of yours opens a door until they change that.`,
    hasClockWindow: false,
    // The contradiction arm: the code card must not promise a window over this sentence.
    suppressesCodeClause: true,
    action: null,
  };
}

/**
 * §5's carve-out, said rather than left for a club admin to discover at their own door.
 *
 * <p>
 * `GateAccess` grants it on `User.IsAdmin` alone and it is the BOOKING check only, so this
 * arm sits below the membership one and above both booking arms. The offline half is the
 * part that would be easiest to drop and the part that matters at midnight: the list a
 * cut-off door decides from holds bookings, and an admin is not in it.
 * </p>
 */
function standingClubAdmin(): StandingLine {
  return {
    body: `${BOOKING_RULE} You're a club admin, so a door opens for you without one — but only a door that`
      + " can still reach the club's system. A door that has lost the network decides from a list of"
      + " bookings, not admins.",
    hasClockWindow: false,
    // No clock window to duplicate, and nothing to contradict: a door does open for this
    // member, so the code card's clause is the only place the times can come from.
    suppressesCodeClause: false,
    action: null,
  };
}

function standingBooking(booking: MemberDoorBooking): StandingLine {
  const starts = formatClock(booking.starts_at);
  const court = booking.court_number === null ? "" : ` on court ${booking.court_number}`;
  const opensAt = Date.parse(booking.door_opens_at);
  const open = !Number.isNaN(opensAt) && opensAt <= Date.now();
  const window = open
    ? `the door opens for you now, until your code for it runs out at ${formatClock(booking.door_closes_at)}.`
    : `the door opens for you from ${formatClock(booking.door_opens_at)}.`;
  return {
    body: `${BOOKING_RULE} Yours is at ${starts}${court}, and ${window}`,
    hasClockWindow: true,
    suppressesCodeClause: true,
    action: null,
  };
}

/** Everything the endpoint sends that bears on what opens a door for this member. */
export type StandingInput = {
  policy: MemberDoorPolicy;
  membership: MemberDoorMembership;
  membership_detail: MemberDoorMembershipDetail;
  is_club_admin: boolean;
  early_entry_minutes: number;
  next_booking: MemberDoorBooking | null;
};

/**
 * What opens the door for this member right now — the standing facts, stated in full.
 *
 * <p>
 * <b>The order of the four checks is the door's own.</b> `GateAccess` refuses a barred
 * membership before it looks at anything else, then lets a club admin past the booking
 * check, then applies the policy. A line that reordered them would be describing a
 * different building — and the one that matters most is the first: a suspended club admin
 * is refused, so the carve-out may never outrank the membership arm.
 * </p>
 *
 * <p>
 * <b>`none` is not a refusal.</b> A user with no membership row is not barred —
 * `MembershipAccess.StatusIfBarredAsync` answers null for it and `GateAccess` walks
 * straight past the check — so telling that member the club has theirs as not active is
 * the page contradicting the door they are standing at. It is a hole in the product rather
 * than a state of this member's, and W2.2 closes it on the admin's side, not here.
 * </p>
 */
export function describeStanding(door: StandingInput): StandingLine {
  const rule = door.policy === "active_member" ? ACTIVE_MEMBER_RULE : BOOKING_RULE;
  if (door.membership === "not_active") return standingNotActive(rule, door.membership_detail);
  if (door.policy === "active_member") {
    return {
      // Three states, and `none` gets its own rather than borrowing either neighbour's.
      // "Yours is active" would be as false as "yours is not active" — the club has
      // nothing on file at all — and the door opens regardless, so the sentence has to
      // say both halves.
      body: door.membership === "none"
        ? `${ACTIVE_MEMBER_RULE} The club has no membership on file for you, which is not the same as one it`
          + " has turned off — so the code on this screen still opens the club door. Worth asking the club to"
          + " put that right."
        : `${ACTIVE_MEMBER_RULE} Yours is active, so the code on this screen opens the club door.`,
      hasClockWindow: false,
      // The one arm where the clause EARNS its place: this line has no clock times and
      // the code card does.
      suppressesCodeClause: false,
      action: null,
    };
  }
  if (door.is_club_admin) return standingClubAdmin();
  if (!door.next_booking) {
    return {
      body: `${BOOKING_RULE} You have nothing booked ${bookingNearness(door.early_entry_minutes)}, so a door`
        + " won't open for you.",
      hasClockWindow: false,
      // The other contradiction arm. An ident code's clause reads "whenever the club's
      // door rules allow", directly over a sentence saying a door will not open at all.
      suppressesCodeClause: true,
      action: { kind: "book_a_court", label: ACTION_LABELS.book_a_court },
    };
  }
  return standingBooking(door.next_booking);
}

/**
 * The standing line when the read failed — with what it last heard, or without.
 *
 * <p>
 * Three silences, three sentences. A stale copy shown as though it were fresh is worse
 * than no copy, so the age and the caveat travel with it; and a member who has no cached
 * copy is told that plainly rather than shown an empty heading.
 * </p>
 */
export function standingFailed(cached: { body: string; minutesAgo: number } | null): string {
  if (!cached) {
    return "Your phone can't reach the club, so this screen can't tell you what its doors need. The code"
      + " below is the last one it managed to get.";
  }
  const ago = cached.minutesAgo <= 1 ? "A minute ago" : `${cached.minutesAgo} minutes ago`;
  return `Your phone can't reach the club. ${ago} it said: ${cached.body} That may have changed since.`;
}

// --- the offline half of the conditional (P6) ------------------------------------------

export const OFFLINE_DETAILS_SUMMARY = "What if the door is offline?";

/**
 * What a door that has lost the club's network can and cannot do.
 *
 * <p>
 * The member-voice sibling of `gateCopy.gateOfflineFallbackNotice()`. The unnamed-door
 * half is stated, because it is the one that is easiest to leave out and the one that
 * leaves a member standing at a door that was never going to open.
 * </p>
 *
 * <p>
 * <b>The cap comes off the wire, and {@link GATE_ROSTER_MAX_ENTRIES} is the fallback.</b>
 * The firmware and the API share the number, and the response now carries it — so the
 * constant here is what a member reads when the response has not landed or predates the
 * field, rather than the page's own idea of a number the board owns. A cap of zero or less
 * is not a cap the club set; it is a field that did not arrive.
 * </p>
 */
export function offlineDetailsBody(rosterMaxEntries?: number | null): string {
  const cap = rosterMaxEntries !== null && rosterMaxEntries !== undefined && rosterMaxEntries > 0
    ? rosterMaxEntries
    : GATE_ROSTER_MAX_ENTRIES;
  return "If a door has lost the club's network it decides from a list of bookings it downloaded earlier,"
    + " and nothing else. During an outage only a member with a court booked soon gets in — whichever rule"
    + ` is set above — and only if their booking is among the first ${cap} bookings by start`
    + " time. A door the club hasn't named yet is sent no list at all, so it opens nothing while it is"
    + " cut off.";
}

// --- the offline page -------------------------------------------------------------------

/** A code the page still holds, with its age said out loud and no promise attached. */
export function offlineWithCode(input: { fetchedAtClock: string; minutesAgo: number; kind: "booking" | "ident" }): string {
  const age = input.minutesAgo <= 1 ? "a minute ago" : `${input.minutesAgo} minutes ago`;
  const outlook = input.kind === "booking"
    ? "A booking code stays good until a while after your court ends, so it will probably still work."
    : "A code like this one lasts about a minute, so it has probably run out already.";
  return `Your phone can't reach the club. This is the code it last managed to get, at ${input.fetchedAtClock}`
    + ` — ${age}. ${outlook} If the door says no, the number below is the way in.`;
}

/** No live code and no way to get one. No QR is drawn: a dead QR in the dark is cruelty. */
export function offlineNoCode(contact: MemberDoorContact): string {
  return "Your phone can't reach the club, and the code it last had has run out. There's nothing this screen"
    + ` can do from here. ${reachTheClub(contact)}`;
}

/**
 * D5 — the sharpest honest sentence on this surface, and the one nothing in the contract
 * covers.
 *
 * <p>
 * A member at an `active_member` club with no booking holds an ident code, which lives
 * about a minute. With no signal they cannot get a fresh one, and a door that has also
 * lost the network holds bookings and nothing else — so the code in their hand cannot
 * work at a cut-off door however new it is. The page owes them that sentence rather than
 * a hopeful QR.
 * </p>
 */
export function offlineIdentDeadEnd(contact: MemberDoorContact): string {
  return "Your phone can't reach the club. The code on this screen lasts about a minute, and a door that has"
    + " also lost the network only opens for members with a court booked — which you don't have right now."
    + ` ${reachTheClub(contact)}`;
}

// --- the self-diagnosis --------------------------------------------------------------

export const DIAGNOSIS_TRIGGER = "The door didn't open";
export const DIAGNOSIS_HEADING = "Let's work out why";
export const DIAGNOSIS_HIDE = "Hide";

export type DiagnosisKey = "membership" | "policy" | "booking" | "window" | "code" | "connection";
export type DiagnosisState = "passed" | "attention" | "failed";

export const DIAGNOSIS_ROW_LABELS: Record<DiagnosisKey, string> = {
  membership: "Your membership",
  policy: "What this club's doors need",
  booking: "Your booking",
  window: "The door's window",
  code: "Your code",
  connection: "This phone's line to the club",
};

/** Colour is never the only signal, so every row carries its state as a word too. */
const STATE_WORDS: Record<DiagnosisState, string> = {
  passed: "Passed",
  attention: "Needs attention",
  failed: "Failed",
};

export type DiagnosisRow = {
  key: DiagnosisKey;
  label: string;
  value: string;
  state: DiagnosisState;
  stateWord: string;
};

export type DiagnosisInput = {
  membership: MemberDoorMembership;
  /** So the failing row names WHICH not-active, exactly as the standing line does. */
  membership_detail: MemberDoorMembershipDetail;
  policy: MemberDoorPolicy;
  hasBooking: boolean;
  bookingStartsClock: string | null;
  /** True inside the door's window, false before it, null when there is no window to judge. */
  doorWindowOpen: boolean | null;
  opensAtClock: string | null;
  opensInWords: string | null;
  codeSecondsLeft: number;
  connectionOk: boolean;
  contact: MemberDoorContact;
};

function row(key: DiagnosisKey, state: DiagnosisState, value: string): DiagnosisRow {
  return { key, label: DIAGNOSIS_ROW_LABELS[key], value, state, stateWord: STATE_WORDS[state] };
}

function bookingRow(input: DiagnosisInput): DiagnosisRow {
  if (input.policy === "active_member") return row("booking", "passed", "not needed at this club");
  if (!input.hasBooking) return row("booking", "failed", "none starting soon");
  return row("booking", "passed", input.bookingStartsClock ?? "one coming up");
}

function windowRow(input: DiagnosisInput): DiagnosisRow {
  if (input.doorWindowOpen === null) return row("window", "passed", "no window to wait for");
  if (input.doorWindowOpen) return row("window", "passed", "open for you now");
  return row("window", "attention", `opens for you at ${input.opensAtClock ?? "a time the club sets"}`);
}

/**
 * The membership row — and the one place on this surface where "not active" and "no
 * membership row" must not be the same answer.
 *
 * <p>
 * `MembershipAccess` bars neither `none` nor an absent row: `StatusIfBarredAsync` answers
 * null for both and `GateAccess` walks past the check. A checklist that failed this row
 * for a member with no membership would hand them the conclusion "that's the whole reason"
 * about a rule the door does not apply — sending somebody to the desk to fix a thing that
 * is not stopping them, while whatever IS stopping them goes unnamed.
 * </p>
 */
function membershipRow(input: DiagnosisInput): DiagnosisRow {
  if (input.membership === "not_active") {
    return row("membership", "failed", MEMBERSHIP_DETAIL_WORDS[input.membership_detail] ?? MEMBERSHIP_DETAIL_FALLBACK);
  }
  if (input.membership === "none") return row("membership", "passed", "nothing on file, and nothing barring you");
  return row("membership", "passed", "active");
}

function diagnosisRows(input: DiagnosisInput): DiagnosisRow[] {
  return [
    membershipRow(input),
    row("policy", "passed", input.policy === "active_member" ? "an active membership" : "a court booked"),
    bookingRow(input),
    windowRow(input),
    // Through the shared formatter, not `${seconds}s`: a booking code has a quarter of an
    // hour on it and "fresh, 900s left" is a number nobody reads as fifteen minutes.
    row("code", input.codeSecondsLeft > 0 ? "passed" : "failed",
      input.codeSecondsLeft > 0 ? `fresh, ${formatCountdown(input.codeSecondsLeft)} left` : "had run out"),
    row("connection", input.connectionOk ? "passed" : "failed",
      input.connectionOk ? "working" : "not reaching the club"),
  ];
}

/**
 * The conclusion, as a CLOSED set evaluated in one order.
 *
 * <p>
 * First failing row wins, so the member is handed ONE thing to do rather than five — and
 * the last arm, the one where nothing on the phone is wrong, is the one that matters and
 * the one that would be easiest to omit. It is never "no refusals found", never "nothing
 * to show", and never blank: an empty answer is what the whole control exists to replace.
 * </p>
 */
function concludeFrom(input: DiagnosisInput): string {
  const reach = reachTheClub(input.contact);
  if (input.membership === "not_active") {
    const word = MEMBERSHIP_DETAIL_WORDS[input.membership_detail] ?? MEMBERSHIP_DETAIL_FALLBACK;
    return `The club has your membership as ${word}. That's the whole reason, and only the club can`
      + ` change it. ${reach}`;
  }
  if (!input.connectionOk) {
    return `Your phone can't reach the club, so this check is guessing about half of it. Move somewhere with`
      + ` signal, or reach the club another way. ${reach}`;
  }
  if (input.policy === "booking_window" && !input.hasBooking) {
    return "This club's doors open only for members with a court booked, and you have none starting soon."
      + " Book one from the schedule.";
  }
  if (input.doorWindowOpen === false) {
    const when = input.opensAtClock ? ` at ${input.opensAtClock}` : "";
    const soon = input.opensInWords ? `, in ${input.opensInWords}` : "";
    return `The door's window hasn't opened yet. It opens for you${when}${soon}. Everything else is fine —`
      + " hold your code up to the scanner again then.";
  }
  if (input.codeSecondsLeft <= 0) {
    return "The code you held up had run out. There's a fresh one on this screen now — try that one.";
  }
  return "Everything on this phone looks right, so whatever went wrong is at the door: it may have lost the"
    + ` club's network, or its scanner may need a wipe. ${reach}`;
}

export function buildDiagnosis(input: DiagnosisInput): { rows: DiagnosisRow[]; conclusion: string } {
  return { rows: diagnosisRows(input), conclusion: concludeFrom(input) };
}

// --- my door history -------------------------------------------------------------------

export const HISTORY_TITLE = "My door history";
export const HISTORY_ANCHOR = "door-history";

export const HISTORY_INTRO = "Every time one of your codes was presented at a club door. Only yours — no other"
  + " member can see these, and the club's own door log can't be filtered to a person.";

/**
 * P2, stated rather than implied. The board released a lock; nothing on this product has
 * ever observed a door move, and nothing here says anybody went anywhere.
 */
export const HISTORY_P2_NOTICE = "\"Lock released\" means the door's board reported that it released the lock."
  + " There's no sensor on the door, so nothing here says the door was pushed — only that your code was"
  + " presented, and what the door decided.";

export const HISTORY_LOADING = "Loading your door history…";

export const HISTORY_FAILED = "Couldn't load your door history. That's this page failing to read it — it"
  + " doesn't mean there's nothing there.";

export const HISTORY_EMPTY = "Nothing has been recorded against your codes at a club door. That's a real answer,"
  + " not a failed read — it means no code of yours has been presented at a door this club kept a record of.";

export const HISTORY_MORE_FAILED = "Couldn't load any more. The rows above are still good.";

export const HISTORY_SHOW_MORE = "Show more";
export const HISTORY_RETRY = "Try again";

/** The offline marker on a row: the door decided from the list it had already downloaded. */
export const HISTORY_OFFLINE_LINE = "From the door's own list — it couldn't reach the club at the time.";

const CHIP_LABELS: Record<string, string> = {
  not_recognised: "Code not recognised",
  member_not_active: "Membership not active",
  no_booking: "No booking",
  too_early: "Too early",
  method_not_supported: "Door misconfigured",
  not_a_gate: "Door misconfigured",
};

const CHIP_TONES: Record<string, ChipTone> = {
  not_recognised: "warning",
  member_not_active: "danger",
  no_booking: "warning",
  too_early: "info",
  method_not_supported: "danger",
  not_a_gate: "danger",
};

/**
 * The outcome chip on a row.
 *
 * <p>
 * An open reads "Lock released", never "Opened" — the amendment that settles this names
 * the feed chip explicitly, and a member's own history is a feed. A refusal this build
 * does not recognise gets a muted chip and a neutral word rather than the raw token.
 * </p>
 */
export function historyChip(row: { reason: string | null; released: boolean; offline: boolean }): { label: string; tone: ChipTone } {
  if (row.released) return { label: "Lock released", tone: "success" };
  const key = reasonKey(row.reason);
  return { label: CHIP_LABELS[key] ?? "Turned away", tone: CHIP_TONES[key] ?? "muted" };
}

/** The sentence under a row, or nothing when the chip has already said all there is. */
export function historyLine(row: { reason: string | null; released: boolean; offline: boolean }): string | null {
  if (row.offline) return HISTORY_OFFLINE_LINE;
  if (row.released) return null;
  return MEMBER_DOOR_REASON_LINES[reasonKey(row.reason)] ?? null;
}

/** The retention, from the server, or the honest absence of one. Never a fabricated number. */
export function historyRetention(days: number | null): string {
  if (days === null || days <= 0) return "The club hasn't set how long it keeps these.";
  return `The club keeps these for ${days} days, then deletes them.`;
}
