import { type DeviceActivityEntry, type DoorEventEntry } from "./api";

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
  /**
   * <b>Ruling 15.</b> A user with NO membership row at all — not suspended, not pending, not
   * turned down: never recorded. `MembershipAccess.StatusIfBarredAsync` answers null for that
   * user, so `GateAccess` used to walk straight past the membership check and, under the
   * active-member policy, open the door for somebody the club has no record of. The backend
   * closes it; this is what the door now says, and it is deliberately a different token from
   * `member_not_active` because it is a different fact and a different fix — somebody has to
   * ADD a membership, not reinstate one.
   * </p>
   */
  no_membership: "No membership on file for that person",
  /** R10 E10-4: a member code that had already acted (member-code §5, `member_code_uses`) — a
   *  second scan of one code, or a photo of it. The Night's "code already used", in this voice. */
  code_used: "The code had already been used",
  /** R11 D11-2: an offline door refused a code the server later proved genuine (replayed, too
   *  early or late, a stale saved list) — the member is named; nothing was opened. */
  refused_offline: "The board refused the code while it was offline",
  /** MCV1-10: the door refused a code it had already seen (a second scan, or a copy) while it was
   *  ONLINE — a replay, said as one, never as "refused offline". */
  replayed: "The door had already seen that code — a second scan of it, or a copy",
};

/**
 * The same eight decisions as chip labels, for a reason-first row.
 *
 * <p>
 * <b>Why here and not in a doors module.</b> {@link DOOR_REFUSAL_REASONS} is the sentence
 * for each decision and this is the two-word label for the same decision; a chip with no
 * sentence renders an unlabelled row, and a sentence with no chip is a log filter value that
 * matches nothing. The matrix test asserting the two maps have identical key sets in BOTH
 * directions is what makes the pair safe, and that test can only exist where both maps do.
 * </p>
 *
 * <p>
 * <b>`ok` reads "Lock released", never "Opened" (A1.2).</b> P2: the strongest thing this
 * product can say is that the board energised the lock. There is no sensor on any door, so
 * "Opened" on a chip an admin quotes back after somebody stood outside for ten minutes is a
 * claim the product cannot make — and a sentence underneath cannot retract a word the chip
 * has already said. The word "relay" stays absent from door copy; "the lock" is the
 * vocabulary this product already uses.
 * </p>
 */
export const DOOR_OUTCOME_CHIPS: Record<string, string> = {
  ok: "Lock released",
  not_recognised: "Not recognised",
  member_not_active: "Not active",
  no_booking: "No booking",
  too_early: "Too early",
  method_not_supported: "Door fault",
  not_a_gate: "Wrong board",
  // Ruling 15. "Not active" would be wrong twice over: there is nothing to reactivate, and an
  // admin reading the chip would go looking for a membership row that does not exist.
  no_membership: "No membership",
  // R10 E10-4: the member's history, the Night and the server's door words say it this way.
  code_used: "Code already used",
  // R11 D11-2: the server's DoorWords and the Night say it this way.
  refused_offline: "Refused offline",
  // MCV1-10: the server's word for a door's own replay refusal.
  replayed: "Replayed code",
};

/**
 * What KIND of thing one audit row is — and the reason this function exists at all.
 *
 * <p>
 * <b>The defect it closes (B1 / A2 / C4).</b> `GET /admin/devices/{id}/activity` returns
 * every audit row carrying this board's `device_id`, which is not the same set as "scans at
 * this door": an admin editing a door writes `device.updated`, a board powering on writes
 * `device.boot`, a club-wide shut writes `doors.shut_all`. The feed had no notion of a
 * non-scan row, so it fell through to a catch-all that painted each of them as a
 * <b>green "Refused"</b> chip — editing a door's name added a refusal to its own page, and
 * a door with thirteen admin edits and zero scans reported "13 refused scans, newest 1 min
 * ago" while the club log and the CSV correctly showed none. Two reviewers found it
 * independently and a third confirmed the cause.
 * </p>
 *
 * <p>
 * <b>Four arms, and the fourth is the point.</b> A released scan and a refused scan are
 * outcomes. An action this build recognises but which decided nothing is an EVENT — neutral,
 * never chipped, never counted. An action this build has never seen is
 * <b>`unknown`</b>: the set grows from the firmware and the backend, never from this screen,
 * so the honest render is a neutral "Unrecognised event" row carrying the raw token, and
 * never a guess at an outcome. Guessing is exactly what shipped.
 * </p>
 */
export type DoorRowKind = "released" | "refused" | "event" | "unknown";

/**
 * A board's own uploads that are a REFUSAL, not an open.
 *
 * `device.gate_open` alone is an open the board decided while cut off. `device.gate_open_`
 * plus an outcome — `device.gate_open_not_a_gate` — is that same upload REFUSED by the
 * server after the fact, and it is written by the same path one suffix along. It humanised
 * to "Gate open not a gate" and chipped green, which is the family of the bug above rather
 * than a separate one.
 */
const OFFLINE_OPEN_ACTION = "device.gate_open";

/**
 * Non-scan actions the door surfaces can meet, and what each one IS in a volunteer's words.
 *
 * <p>
 * Enumerated rather than pattern-matched, because the whole failure here was a pattern that
 * matched things it had never been shown. `src/lib/door-actions.test.ts` reads the backend's
 * own sources at test time and fails if any action it can emit is missing from this map or
 * from the scan rules above it — so a new backend action lands as a red test on the screen
 * that has to render it, rather than as a green "Refused" chip in a club.
 * </p>
 */
export const DOOR_EVENT_WORDS: Record<string, string> = {
  "device.registered": "The board registered itself",
  "device.auto_registered": "The board registered itself",
  "device.updated": "This door's details or state were changed",
  "device.deleted": "This door was deleted",
  "device.boot": "Board started up",
  "device.api_key_regenerated": "The club's device key was replaced",
  // v3 (device-api.md §6, §8): the key and network changes that reach every board over the air.
  "device.api_key_rotated": "The club started handing its boards a new device key",
  "device.api_key_retired": "The club's old device key stopped working",
  "device.api_key_restored": "A device key the boards already hold was put back",
  "device.network_updated": "The club's WiFi or server address for its boards was changed",
  "device.network_pushed": "The club's network settings were sent to this board",
  "device.event_time_clamped": "The board's clock was out and was corrected",
  "doors.shut_all": "Every door was shut together",
  "doors.reopened_all": "The doors shut together were reopened",
  "doors.log_exported": "Someone downloaded the door log",
  /**
   * The power-dip restore (ruling 8 / item 17), in the three rows it actually writes.
   *
   * <p>
   * These arrived with the backend's live lane and reached this screen with no copy at all,
   * so each rendered as "Unrecognised event" on the page an admin reconciles a court box's
   * night from — which is the exact failure this dictionary exists to prevent, one lane
   * later. The words say what happened to the COURT rather than what happened on the wire:
   * an admin reading this feed is working out why a court went dark.
   * </p>
   */
  "device.relay_restore_served": "Board restarted; the club told it which courts were lit",
  "device.relay_restore_confirmed": "The board put the lit courts back on after restarting",
  "device.relay_restore_failed": "The board did not put the lit courts back on after restarting",
  /** v3 (§4): the box re-lit a court the club's record says is paid for, after its controller restarted. */
  "device.relay_relit": "The board switched a paid court's lights back on",
  /** A court box's own rows. A gate never writes these; the dictionary is shared. */
  "device.activation": "Court activated",
  /** R11 D11-2: a court box's offline refusal of a code, uploaded later — named when genuine. */
  "device.court_unknown_scan": "The box refused a code while offline",
  "device.release": "Court released",
  "device.release_unpaired": "Court released with nothing paired",
  "device.turnstile_spun": "Turnstile spun",
  "device.their_private_business": "A scan the club does not record",
};

/**
 * Which of the four this row is.
 *
 * Prefix rules only where the backend genuinely builds an action by concatenation
 * (`gate.denied_<reason>`, `device.gate_open_<outcome>`, `device.activation_<outcome>`) —
 * everywhere else it is an exact lookup, so an action nobody has written copy for reaches
 * the `unknown` arm instead of borrowing somebody else's.
 */
export function classifyDoorRow(entry: DeviceActivityEntry): DoorRowKind {
  const action = entry.action.trim();
  if (action === "gate.opened" || action === OFFLINE_OPEN_ACTION) return "released";
  if (action.startsWith("gate.denied")) return "refused";
  if (action === "device.unknown_scan") return "refused";
  // The refused half of an offline upload — see OFFLINE_OPEN_ACTION.
  if (action.startsWith(`${OFFLINE_OPEN_ACTION}_`)) return "refused";
  if (DOOR_EVENT_WORDS[action]) return "event";
  // `device.activation_<outcome>` and `device.release_<outcome>`: a court box's rows, which
  // are events on any screen that meets them and are never a door's outcome.
  if (action.startsWith("device.activation_") || action.startsWith("device.release_")) return "event";
  return "unknown";
}

/** True for the rows that ARE a scan decision — the only rows a door count may include. */
export function isDoorScan(entry: DeviceActivityEntry): boolean {
  const kind = classifyDoorRow(entry);
  return kind === "released" || kind === "refused";
}

/**
 * What a non-scan row reads as, and the honest arm when this build has never seen it.
 *
 * "Unrecognised event" rather than a humanised guess: `humanise("doors.shut_all")` gives
 * "Shut all", which reads as something a reader can act on and is not. The raw token travels
 * with it as the row's `title`, so whoever has to report a new action upstream still has it.
 */
export function describeDoorEvent(entry: DeviceActivityEntry): string {
  return DOOR_EVENT_WORDS[entry.action.trim()] ?? UNRECOGNISED_EVENT;
}

export const UNRECOGNISED_EVENT = "Unrecognised event";

/**
 * The separate `events` array the door feed now reads, humanised.
 *
 * <p>
 * The backend serves these as `{at, kind, actor_name|null}` with kinds such as `registered`,
 * `renamed`, `details_changed`, `shut`, `reopened`, `shut_all`, `reopened_all`. They are the
 * same facts as the `device.*` rows above, said in the door's own vocabulary rather than the
 * audit trail's — so both spellings are answered here and a kind nobody has written copy for
 * takes the same neutral arm as an unknown action.
 * </p>
 */
export const DOOR_EVENT_KIND_WORDS: Record<string, string> = {
  registered: "The board registered itself",
  // WIRE-R3 §6's `kind` vocabulary, which is the `change` vocabulary: the two fields have
  // converged, so a row carrying only `kind` now says which of the four an edit was.
  renamed: "Renamed",
  details_changed: "Details changed",
  shut: "Shut",
  reopened: "Reopened",
  deleted: "This door was deleted",
  /**
   * ONE kind for four things, and the copy must not pretend otherwise.
   *
   * The backend writes `device.updated` for a rename, a details change, a shut and a reopen
   * alike, and records nothing that says which. "Someone renamed this door" over a shut
   * would be a guess rendered as a fact — this round's own defect in a new place — so the
   * sentence says what is actually known and points at the fields above it.
   */
  edited: "This door's details or state were changed",
  removed: "This door was deleted",
  clock_corrected: "The board's clock was out and was corrected",
  unrecognised: UNRECOGNISED_EVENT,
};

export function describeDoorEventKind(event: DoorEventEntry): string {
  return DOOR_EVENT_KIND_WORDS[event.kind.trim()] ?? UNRECOGNISED_EVENT;
}

/**
 * <b>A5 / E-M6 / WIRE-R2 §2 — what actually changed, and who changed it.</b>
 *
 * <p>
 * `kind` could not say: the backend wrote `device.updated` for a rename, a details change, a
 * shut and a reopen alike, so a reviewer met nine identical rows reading "this door's details
 * or state were changed" and learned nothing from any of them. The server derives `change`
 * from the audit details now, and `other` is the honest arm for a row written before it did.
 * </p>
 *
 * <p>
 * <b>The actor is named, and the reason that is not P3.</b> P3 is about MEMBERS: a per-member
 * observation on an admin screen is the attendance report nobody agreed to. This is the
 * club's own admin audit — admins seeing admins — and without it the door card said "You
 * shut this door" to four admins who had not.
 * </p>
 */
export const DOOR_EVENT_CHANGE_WORDS: Record<string, string> = {
  registered: "The board registered itself",
  renamed: "Renamed",
  details: "Details changed",
  /**
   * WIRE-R3 §6 renames two of these, and BOTH spellings resolve.
   *
   * Rows written under `details`/`removed` and rows written under
   * `details_changed`/`deleted` are inside retention at the same time, and a screen that
   * knows only the newer one renders the older as "Unrecognised event" — which is the honest
   * arm for a genuinely unknown action and the wrong answer for one we have words for.
   */
  details_changed: "Details changed",
  shut: "Shut",
  reopened: "Reopened",
  shut_all: "Shut with every other door",
  reopened_all: "Reopened with the doors shut together",
  removed: "Deleted",
  deleted: "Deleted",
  clock_corrected: "The board's clock was out and was corrected",
  /** A row written before the server recorded which of the four an edit was. */
  other: "Details or state changed",
};

export function describeDoorEventChange(event: DoorEventEntry): string {
  const change = (event.change ?? "").trim();
  const words = change === "" ? null : DOOR_EVENT_CHANGE_WORDS[change] ?? null;
  // No `change` at all is an older API, and `kind` is what it has to say. An unrecognised
  // `change` is the same honest arm as an unrecognised action: read it out rather than guess.
  const head = words ?? (change === "" ? describeDoorEventKind(event) : UNRECOGNISED_EVENT);
  const actor = (event.actor_name ?? "").trim();
  // Board-side events have no actor and must not be given one — "The board registered itself
  // by Priya Naidoo" is a sentence about a thing that did not happen.
  if (actor === "" || change === "registered" || change === "clock_corrected") return head;
  return `${head} by ${actor}`;
}

/**
 * The nine actions that ARE a scan, exactly as the backend enumerates them.
 *
 * <p>
 * Held as a literal set as well as by the rules in {@link classifyDoorRow}, so
 * `door-actions.test.ts` can assert the two agree in BOTH directions: no scan action is
 * classified as an event, and no event action is classified as a scan. A prefix rule that
 * silently widened would otherwise be invisible until a club saw a green "Refused".
 * </p>
 */
export const DOOR_SCAN_ACTIONS = [
  "gate.opened",
  "gate.denied_not_recognised",
  "gate.denied_member_not_active",
  "gate.denied_no_booking",
  "gate.denied_too_early",
  "gate.denied_method_not_supported",
  "gate.denied_not_a_gate",
  "device.gate_open",
  "device.unknown_scan",
] as const;

/**
 * Actions that are CLUB-wide rather than a door's, and never appear on a door's own feed.
 *
 * Kept in the dictionary all the same: they reached the feed before the backend separated
 * the two arrays, and a screen that met one again should read it rather than guess at it.
 */
export const DOOR_FLEET_ACTIONS = ["doors.shut_all", "doors.reopened_all", "doors.log_exported"] as const;

/**
 * What an OFFLINE grant reads as: the board decided, and uploaded the row afterwards.
 *
 * <p>
 * It said "Opened while offline" and sat directly beside a chip reading "Lock released" —
 * one row saying two different things about one decision, and the half A1.2 rules against.
 * P2 is the reason: there is no sensor on any door, so the strongest true statement is that
 * the board released the lock.
 * </p>
 */
const OFFLINE_OPENED = "Lock released while offline";

/**
 * What an offline refusal reads as.
 *
 * <p>
 * <b>E-L2 / WIRE-R2 §3.</b> It rendered as "Refused / No reason recorded", which reads as a
 * gap in the trail. There is no gap: the board looked the code up in the list it last
 * downloaded and did not find it, and that IS the reason. It is also why the row names
 * nobody — an unmatched code resolves to nothing at all, which is a different thing from a
 * member the club failed to identify, and "Unknown member" would claim the second. The one
 * line that reconciles the naming and the not-naming is {@link OFFLINE_WHO_NOTE}, printed
 * once beside the rows rather than repeated on each of them.
 * </p>
 */
const OFFLINE_REFUSED = "Code not on the door's saved list";

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
  // R11 D11-2: the server proved the code genuine and named the member — the saved-list
  // sentence would be false. Checked before the action rule, which answers for the rest.
  if (entry.reason === "refused_offline") return DOOR_REFUSAL_REASONS.refused_offline;
  // MCV1-10: a replay the door refused while online is uploaded as `replayed` — never the
  // offline sentence, even on a row the server still files under the unknown-scan action.
  if (entry.reason === "replayed") return DOOR_REFUSAL_REASONS.replayed;
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
