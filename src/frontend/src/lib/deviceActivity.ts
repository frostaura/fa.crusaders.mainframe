import { type DeviceActivityEntry } from "./api";

/**
 * Everything the Devices page says about a board's own trail, and about boards nobody has
 * acknowledged.
 *
 * <p>
 * <b>A module rather than strings in the JSX, for the reason {@link gateCopy} exists.</b>
 * The court-box half of that screen wrote one consequence at three call sites and shipped
 * three rounds running with the three disagreeing. This panel has the same shape — an
 * action, a reason and an empty state, all describing one decision — and the refusal
 * dictionary in particular is read by the panel and by its tests, which is already two.
 * </p>
 *
 * <p>
 * <b>Separate from `gateCopy` because this list is not a door's.</b> `gateCopy` is what the
 * console says about a DOOR: naming it, taking it out of service, deleting it. The activity
 * endpoint serves court boxes too, and the same panel renders `device.activation` and
 * `device.release` rows beside `gate.denied_too_early` ones. Putting kind-neutral copy in
 * the door module would be the same category error as the round that let box copy render on
 * a gate row. The door-specific half of it — {@link DOOR_REFUSAL_REASONS} — lives here with
 * the rest of the panel, because the panel is its only reader.
 * </p>
 */

/**
 * The door refusal dictionary.
 *
 * <p>
 * Every token here has travelled through the firmware, the wire corpus and the spec since
 * the gate shipped, and not one had ever been turned into a sentence: an admin asked "why
 * would the front door not let me in" had a database query as the only answer, and
 * `too_early` is a token rather than an answer. This is where that stops.
 * </p>
 *
 * <p>
 * Each sentence says what the DOOR decided, in the third person, because the reader is an
 * admin looking at somebody else's scan — not the member who was refused. "Your booking has
 * not started yet" would be the member's sentence and is the wrong voice on this screen.
 * </p>
 */
export const DOOR_REFUSAL_REASONS: Record<string, string> = {
  /** The decision went through. Kept in the dictionary because the token can arrive on
   *  actions other than `gate.opened` — see {@link describeActivityReason}. */
  ok: "Allowed",
  /** No live access code matched what was scanned. Deliberately indistinguishable from an
   *  expired code at the door, so the sentence must not claim which it was. */
  not_recognised: "The code was not recognised",
  /** The code resolved, the membership did not: suspended, pending approval or rejected. */
  member_not_active: "That membership is not active",
  /** Under the strict policy, or for a booking code outside every booking it holds. */
  no_booking: "No booking that opens this door",
  /** A booking code presented before its own door window opened. The one reason a member
   *  can fix by waiting, which is why it must not read like a lockout. */
  too_early: "Too early for that booking",
  /** The board asked in a way this door does not answer — a scan kind the gate route does
   *  not implement. A firmware or configuration fault, not a member's mistake. */
  method_not_supported: "The board asked in a way a door does not answer",
  /** A `gate_open` from a row whose kind is CourtBox. Mirrors `not_a_court_box`. */
  not_a_gate: "That board is a court box, not a door",
};

/** What an OFFLINE open reads as: the board decided, and uploaded the row afterwards. */
const OFFLINE_OPENED = "Opened while offline";

/**
 * What an offline refusal reads as.
 *
 * <p>
 * It names nobody and it says why it names nobody. An offline board that does not find a
 * code in its cached roster has no way to resolve it to a member — there is nothing to
 * identify, which is a different thing from a member the club failed to identify. "Unknown
 * member" would claim the second.
 * </p>
 */
const OFFLINE_REFUSED = "Refused while offline — the door cannot say who";

/** Actions this screen has written copy for. Anything else is humanised — see below. */
const ACTION_WORDS: Record<string, string> = {
  "gate.opened": "Door opened",
  /** An open the BOARD decided while cut off, uploaded on its next `/events` post. */
  "device.gate_open": "Door opened",
  /** An offline refusal, uploaded the same way. */
  "device.unknown_scan": "Refused",
  "device.activation": "Court activated",
  "device.release": "Court released",
  "device.boot": "Board started up",
};

/**
 * The two namespaces the audit trail actually uses. Stripped before humanising, because the
 * panel's own heading already says which kind of board this is and "Device" in front of
 * every row is noise.
 *
 * <p>
 * Only these two, deliberately. Stripping a namespace nobody has defined — guessing that
 * anything before the first dot is one — would silently shorten an action whose prefix
 * carried meaning, and this list is the one place that guess can be made.
 * </p>
 */
const ACTION_NAMESPACES = ["gate.", "device."];

/**
 * An action nobody wrote copy for, read out rather than hidden.
 *
 * <p>
 * The set of actions grows from the firmware and the backend, never from this screen, so a
 * panel that showed only what it recognised would be a trail that looks complete and is
 * not — and the row it dropped would be exactly the new one somebody is looking for. The
 * raw token is still available to the reader: the panel carries it as the row's `title`.
 * </p>
 */
function humanise(token: string): string {
  let rest = token.trim();
  for (const prefix of ACTION_NAMESPACES) {
    if (rest.startsWith(prefix)) { rest = rest.slice(prefix.length); break; }
  }
  const words = rest.replace(/[._]+/g, " ").trim();
  if (words === "") return "Something happened";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What this row was, in words.
 *
 * <p>
 * `gate.denied_<reason>` is handled by prefix rather than by enumerating the seven
 * suffixes, because the reason is already carried in its own field and repeating it in the
 * headline would say the same thing twice on a fifty-row list. The headline says a refusal
 * happened; {@link describeActivityReason} says why.
 * </p>
 */
export function describeActivityAction(entry: DeviceActivityEntry): string {
  const action = entry.action.trim();
  if (action.startsWith("gate.denied")) return "Refused";
  return ACTION_WORDS[action] ?? humanise(action);
}

/**
 * Why, in words — or null when the row has nothing to add.
 *
 * <p>
 * The two offline kinds answer first, because their reason is not a refusal token at all
 * but the fact that the board was on its own. An `ok` on an opened door answers null: the
 * action beside it already says the door opened, and a second column repeating the first is
 * noise on a long list. The token stays in the dictionary because it can arrive on other
 * actions, where it does say something.
 * </p>
 */
export function describeActivityReason(entry: DeviceActivityEntry): string | null {
  if (entry.action === "device.gate_open") return OFFLINE_OPENED;
  if (entry.action === "device.unknown_scan") return OFFLINE_REFUSED;
  if (entry.reason === null || entry.reason.trim() === "") return null;
  if (entry.reason === "ok" && entry.action === "gate.opened") return null;
  return DOOR_REFUSAL_REASONS[entry.reason] ?? humanise(entry.reason);
}

/**
 * Who it was, or null.
 *
 * <p>
 * The resolved member wins over the fingerprint, always. A row that resolved to a member
 * AND carries the fingerprint of their code must read as the member: printing the hash
 * beside a name it belongs to leaks a correlator into a row that did not need one, and the
 * fingerprint exists for exactly the rows where there is no name — it is what lets an admin
 * see that the same unrecognised code has been tried at the door eleven times.
 * </p>
 */
export function describeActivityWho(entry: DeviceActivityEntry): string | null {
  if (entry.member) return entry.member.name;
  if (entry.fingerprint) return `Unknown code · ${entry.fingerprint}`;
  return null;
}

/** What the panel is called, which is the one place the two kinds differ in wording. */
export function activityPanelTitle(gate: boolean): string {
  return gate ? "Door activity" : "Box activity";
}

/**
 * An empty trail, said as a fact rather than as a failure. A door nobody has walked through
 * has nothing recorded, and an admin who reads "could not load" goes looking for a fault.
 */
export function activityEmptyNotice(gate: boolean): string {
  return gate ? "Nothing recorded for this door yet." : "Nothing recorded for this box yet.";
}

/** What the panel says when the read itself failed, as the fallback to the API's own word. */
export const ACTIVITY_READ_FAILED = "Could not read that board's activity.";

/**
 * The tenant's cap on boards nobody has acknowledged (B3's contract constant,
 * `MaxUnacknowledgedDevices`). At this many `auto_registered` rows, auto-registration
 * refuses a new MAC with 409 `too_many_unacknowledged_devices`.
 */
export const MAX_UNACKNOWLEDGED_DEVICES = 16;

/** Where the warning starts — four boards of room, so an admin has time to act. */
export const UNACKNOWLEDGED_NOTICE_FROM = 12;

/**
 * The warning, or null while the club has room.
 *
 * <p>
 * <b>This exists because the refusal is not reachable from the console.</b> The 409 is
 * answered to the BOARD, on its own heartbeat, so the only party that ever sees
 * `too_many_unacknowledged_devices` is a piece of firmware with one LED. An admin who
 * flashes a new board and finds it never appears on this list has no error to read
 * anywhere — the screen simply does not grow a row. A warning before the club gets there
 * is the only form this can take on a screen.
 * </p>
 *
 * <p>
 * It names the consequence rather than the count, because a count is not a reason to act:
 * "12 boards are unnamed" reads as untidiness, and "at 16 the next board you flash will not
 * register" reads as a job.
 * </p>
 */
export function unacknowledgedBoardsNotice(count: number): string | null {
  if (count < UNACKNOWLEDGED_NOTICE_FROM) return null;
  return `${count} boards have registered themselves and nobody has named them yet.`
    + ` At ${MAX_UNACKNOWLEDGED_DEVICES} the club stops registering new boards, so the next one you`
    + " flash would never appear here. Name the ones you recognise, and delete the ones you do not.";
}
