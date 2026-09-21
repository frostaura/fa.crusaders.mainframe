import {
  DOOR_OUTCOME_CHIPS, UNRECOGNISED_EVENT, classifyDoorRow, describeActivityReason,
  describeDoorEvent, describeDoorEventChange, describeDoorEventKind, isDoorScan, type DoorRowKind,
} from "./deviceActivity";
// A13 — one club-locale formatter for the whole surface. See lib/clubClock.ts.
import { clubClock, clubDayAndClock, clubInstant } from "./clubClock";
import { POWER_LOSS_LABELS, UNNAMED_GATE, doorShutNotice } from "./gateCopy";
import {
  type AdminDoorDevice, type DeviceActivityEntry, type DoorEventEntry, type DoorLogDoor,
  type DoorSignal, type DoorToday,
} from "./api";

/**
 * What is true of a door right now, and how a door record should be read.
 *
 * <p>
 * <b>Why a second module beside {@link import("./gateCopy")}.</b> `gateCopy` answers "what
 * does this control do to a door" — naming it, shutting it, deleting it. This answers "what
 * is true of this door right now, and how should this record be read". Different question,
 * same noun, and `deviceActivity` is the precedent for splitting on the question rather than
 * on the noun. It <b>delegates</b> rather than restating: the shut branch below calls
 * {@link doorShutNotice}, so nothing in `gateCopy` is rewritten and the two cannot disagree
 * about one click. (The unnamed branch makes the same claim
 * `unnamedGateOfflineNotice` does, in the doors surface's own words — "sent an empty list"
 * rather than "an empty roster" — because "roster" is the court box's noun.)
 * </p>
 *
 * <p>
 * <b>Every generator here states both halves of its conditional.</b> That is P6, and it is
 * not a style rule: the door's honest behaviour is a pair — a door the club can reach, and a
 * door that has lost the network and goes on admitting booked members from a list it
 * downloaded up to six hours ago. Either half said alone has already shipped in this repo as
 * a falsehood, twice, in opposite directions.
 * </p>
 */

/**
 * "6m ago" spelled out, for an accessible name.
 *
 * <p>
 * A screen reader reads "6m ago" as "six em ago". The abbreviation is right on screen, where
 * space is the constraint and the reader can see the pattern, and wrong in a name, where the
 * whole point is that the fact arrives once and completely.
 * </p>
 */
const AGE_UNITS: Record<string, string> = { s: "second", m: "minute", h: "hour", d: "day" };

export function spellAge(ago: string): string {
  const match = /^(\d+)([smhd]) ago$/.exec(ago);
  if (!match) return ago;
  return `${plural(Number(match[1]), AGE_UNITS[match[2]])} ago`;
}

/** A chip is a word and a tone. Colour is never the signal; the word is. */
export type DoorChip = { label: string; tone: "success" | "danger" | "muted" | "warning" };

// --- who a door is, on a row and in a heading -------------------------------------

/**
 * The name `DeviceRegistryService` gives a gate the moment it registers itself.
 *
 * <p>
 * <b>A11: it is a placeholder, not a name, and the screens presented it as one.</b> A door
 * nobody had named rendered as the heading "Door gate", the identity line "no door name yet"
 * and the chip "Needs a door name" — three different vocabularies for one state, the loudest
 * of which was a word the club never chose and cannot tell apart from the other four doors
 * in the same state.
 * </p>
 */
export const GATE_PLACEHOLDER_NAME = "Door gate";

/**
 * What to call a door on screen — its own name, or what it actually is (A11).
 *
 * `Unnamed scanner (gate-44c103)` names exactly one board and says the naming is outstanding
 * in the same breath, which is what "Door gate" could do neither of.
 */
export function doorDisplayName(device: { name?: string | null; device_code?: string | null }): string {
  const name = (device.name ?? "").trim();
  if (name !== "" && name !== GATE_PLACEHOLDER_NAME) return name;
  const code = (device.device_code ?? "").trim();
  return code === "" ? "Unnamed scanner" : `Unnamed scanner (${code})`;
}

/**
 * What a log row says about the door it happened at, including a door that is GONE.
 *
 * <p>
 * <b>A1 / A2 / E-C1 / C1.</b> The page read `entry.door.name` and a deleted door turned the
 * whole club log white. The ruling is that the history survives the board: the row carries
 * what it stored at write time, and the screen names it and says it has been removed rather
 * than either crashing or silently dropping the rows.
 * </p>
 *
 * <p>
 * Four arms and no guessing. A stored display name is the best answer; a stored `gate_key`
 * is the next; a row that has neither says only that the door is gone; and `door` missing
 * altogether is treated as removed, because a scan that happened at no door is not a state
 * this product can produce and "removed" is the only honest reading of it.
 * </p>
 */
export type DoorRowIdentity = {
  /** What to print. Never empty, never `undefined`, never the word "null". */
  label: string;
  /** Said once beside the name, so a reader is not left wondering why it has no link. */
  removed: boolean;
  /** The door's own page, or null — a removed door has none, and a dead link is worse. */
  id: string | null;
};

/** Said beside a removed door's name. A row is not dropped and is not left unexplained. */
export const REMOVED_DOOR_NOTE = "a door that has since been removed";

/** When the row stored no name and no key either — all that is left is that it is gone. */
export const REMOVED_DOOR_UNNAMED = "A door that has since been removed";

export function doorRowIdentity(door: DoorLogDoor | null | undefined): DoorRowIdentity {
  // `door` absent is the shape WIRE-R2 §1 says cannot happen, and it is the shape that
  // shipped. Trusting that promise is the defect, not the mitigation.
  const removed = door == null || door.removed === true;
  const name = (door?.name ?? "").trim();
  const key = (door?.gate_key ?? "").trim();
  const id = door?.id ?? null;
  if (name !== "" && name !== GATE_PLACEHOLDER_NAME) return { label: name, removed, id };
  if (key !== "") return { label: key, removed, id };
  if (removed) return { label: REMOVED_DOOR_UNNAMED, removed, id: null };
  return { label: "An unnamed door", removed, id };
}

/** True of the name {@link doorDisplayName} builds for a door nobody has named. */
function isUnnamedScanner(name: string): boolean {
  return name.startsWith("Unnamed scanner");
}

/**
 * One option in the log's door picker.
 *
 * A11: a door nobody has named reads "Unnamed scanner (gate-0a1b2c)" and stops there. The
 * old label — "Door gate — no door name yet" — presented the placeholder as the club's word
 * for the board AND then contradicted it, in one option, on the control an admin picks a
 * door with.
 */
export function doorPickerLabel(device: { name: string; gate_key: string | null }): string {
  if (device.gate_key) return `${device.name} (${device.gate_key})`;
  if (isUnnamedScanner(device.name)) return device.name;
  return `${device.name} — ${UNNAMED_GATE}`;
}

/**
 * What the picker's "Removed doors" group calls one of them (A2).
 *
 * The stored name, else the stored key, else the key the rows were written against — which
 * is at least a string an admin can match against a board they remember.
 */
export function removedDoorName(door: { key: string; name?: string | null; gate_key?: string | null }): string {
  const name = (door.name ?? "").trim();
  if (name !== "" && name !== GATE_PLACEHOLDER_NAME) return name;
  const key = (door.gate_key ?? "").trim();
  return key !== "" ? key : door.key;
}

/**
 * <b>The server caps this list at 50, so a full one is not a complete one.</b>
 *
 * <p>
 * A picker that lists fifty removed doors and stops looks exactly like a club that has
 * removed fifty doors — and the one an admin is hunting for after an incident is, by
 * definition, the one that is not in the list. The same class of falsehood as A6's count,
 * one control along: a page length presented as a total.
 * </p>
 */
export const REMOVED_DOORS_CAP = 50;

export function removedDoorsCapNotice(shown: number): string | null {
  return shown < REMOVED_DOORS_CAP
    ? null
    : `These are the ${REMOVED_DOORS_CAP} most recently removed doors. There may be more.`;
}

/**
 * <b>A6 — "50 scans, newest first" read as a total, and the file had 70.</b>
 *
 * <p>
 * It was the length of one cursor page, printed as if it were the answer to the question the
 * page exists to answer, and it is the number an admin repeats to a committee. WIRE-R2 §3
 * gives the log a `total` for the filtered range, so the heading can say how much of it is on
 * screen. Where the API sends no total the sentence says "so far" rather than inventing one —
 * falling back to the page length is how the wrong number got printed in the first place.
 * </p>
 */
export function doorLogCountLine(
  showing: number, total: number | null, more = true,
): string {
  const scans = showing === 1 ? "scan" : "scans";
  if (total === null) {
    // A-M9 / R3-20: "so far" was printed at the END of the list too, so an admin who had
    // pressed "Load older scans" until it went away still could not tell whether they were
    // looking at all of them. `more` is whether the API handed back another cursor — the one
    // fact that settles it — and with no cursor left the page HAS the total: it is what is
    // on screen. It is not invented from a page length; it is the end of the range.
    return more
      ? `Showing ${showing} ${scans} so far, newest first.`
      : `Showing all ${showing} ${scans} in this range, newest first.`;
  }
  if (showing >= total) return `Showing all ${plural(total, "scan")} in this range, newest first.`;
  return `Showing ${showing} of ${plural(total, "scan")} in this range, newest first.`;
}

/**
 * <b>E6 / R3-19 — the heading said "All scans, all doors" over a filtered log.</b>
 *
 * <p>
 * It is the one line a reader takes the page's meaning from, it is what a printed or
 * screenshotted page is read as afterwards, and it was a constant. An admin filtering to one
 * door's refusals on Tuesday, screenshotting it for a committee, handed over a picture headed
 * "All scans, all doors" — which is a caption that contradicts its own contents.
 * </p>
 *
 * <p>
 * Every clause is omitted when the filter is at its default, so the unfiltered page reads
 * exactly as it always did and an admin who has narrowed nothing is not made to read a
 * sentence about it.
 * </p>
 */
export function doorLogHeading(filters: {
  doorName: string | null;
  outcomeLabel: string | null;
  rangeLabel: string | null;
}): string {
  const what = filters.outcomeLabel ? `${filters.outcomeLabel} scans` : "All scans";
  const where = filters.doorName ? `at ${filters.doorName}` : "all doors";
  const head = `${what}, ${where}`;
  return filters.rangeLabel ? `${head} — ${filters.rangeLabel.toLowerCase()}` : head;
}

/**
 * <b>A-C2 / R3-13 — a stale door link, and the three lies it told at once.</b>
 *
 * <p>
 * `/admin/doors/log?door=<an id that is no longer a door>` showed "All doors" in the picker,
 * "No scans at any door in the last 24 hours" on the page, and exported a nought-row CSV
 * under the ordinary filename. Each of those is a claim about the CLUB derived from a filter
 * pointing at nothing — and the sentence in the middle is the one a committee reads as "the
 * doors recorded nothing that night".
 * </p>
 *
 * <p>
 * The link is not rare: it is what every bookmark, every emailed link and every browser
 * history entry pointing at a door becomes the day that board is replaced. The rows are still
 * there — deleting a door deletes no scans — and the sentence says both halves: this filter
 * matches nothing, and the records were not destroyed.
 * </p>
 */
export const LOG_DOOR_GONE = "That door is no longer on the club's list, so this filter matches"
  + " nothing. It is not that nothing happened: a deleted door's past scans are kept until the"
  + " club's retention rule takes them.";

export const LOG_DOOR_GONE_HINT = "Pick it under “Removed doors” if it is there, or choose All"
  + " doors.";

/**
 * Said where the CSV button is, instead of the button, while the filter names no real door.
 *
 * A-C2's third lie: the export ran, produced a nought-row file under the ordinary filename,
 * and said nothing. A file named for the club's whole log and holding nothing is the worst of
 * the three, because it outlives the screen that produced it.
 */
export const LOG_CSV_BLOCKED_DOOR_GONE = "There is nothing to export while the door filter names"
  + " a door the club no longer has — a file of nought rows under the usual name is worse than"
  + " no file.";

/**
 * <b>A-L3 / R3-12 — "A specific day" with no day chosen listed the last 24 hours.</b>
 *
 * The page fell back to its default period, so the When control said one thing and the rows
 * were another — and the rows were a rolling window presented as a calendar day. It asks for
 * the day instead and lists nothing.
 */
export const LOG_PICK_A_DAY = "Pick a day to see its scans. Nothing is listed until you do — the"
  + " rows below would be the last 24 hours, which is not the day you asked for.";

/** The row's whole door clause — the name, and the removal said once after it. */
export function doorRowName(door: DoorLogDoor | null | undefined): string {
  const identity = doorRowIdentity(door);
  if (!identity.removed) return identity.label;
  if (identity.label === REMOVED_DOOR_UNNAMED) return REMOVED_DOOR_UNNAMED;
  return `${identity.label} — ${REMOVED_DOOR_NOTE}`;
}

/** How long a cached roster lives on a board. Mirrors the firmware's `ROSTER_MAX_AGE_MS`. */
const ROSTER_MAX_AGE_MS = 6 * 3_600_000;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The liveness chip (D1 / A2.1).
 *
 * <p>
 * It reads <b>Reporting</b>, not "Working" and not "Online". The product knows exactly one
 * thing: the board answered the club N seconds ago. There is no door sensor, the relay may
 * be dead, the lock may be seized and the release may be too short for a heavy door — which
 * is the very fault the "may not be releasing" signal exists to guess at. "Working" is P2's
 * forbidden implication compressed into one word, and it is the word an admin quotes back
 * after a member has stood outside for ten minutes.
 * </p>
 *
 * <p>
 * Shut outranks liveness, because nobody expects a shut door to call in and showing it beside
 * the doors that have genuinely gone quiet is how a club learns to ignore the state that
 * matters.
 * </p>
 */
export function doorStateChip(device: AdminDoorDevice, online: boolean | null): DoorChip | null {
  if (!device.enabled) return { label: "Shut", tone: "muted" };
  // A8: `null` is "this page cannot currently say". While the reads themselves are failing,
  // "Not reporting" is a claim about a DOOR derived from a frozen age — the thing that has
  // gone quiet is the browser. A chip that says nothing is better than one that is wrong,
  // and the page carries the sentence explaining why the chips are missing.
  if (online === null) return null;
  return online ? { label: "Reporting", tone: "success" } : { label: "Not reporting", tone: "danger" };
}

/**
 * What a page says about itself once it cannot read (A8).
 *
 * The subject is THIS PAGE, not the doors. With an admin's phone off the network every age on
 * the screen went on ticking from a frozen read, doors flipped one by one to "Not reporting",
 * and the page asserted "nothing can reach it" about boards that were, as far as anybody
 * knew, fine.
 */
export const DOORS_LIVENESS_SUSPENDED = "This page can't reach the club right now, so it can't say"
  + " whether the doors are reporting. What each door was doing at the last successful check is"
  + " still shown, with the time it was checked.";

/**
 * The second chip, and it is a second DIMENSION rather than a fourth value (D2 / A2.2).
 *
 * <p>
 * A reporting door with no name is the most dangerous state in the club: it works today and
 * opens nothing at all during the next outage. One chip slot renders that either as
 * `Reporting`, hiding the job, or as `New`, hiding the liveness — both lose the half somebody
 * needs. Keyed on the NAME being absent rather than on `auto_registered`, because the
 * consequence is what an admin can act on: a door named months ago and never edited is fine,
 * and a door whose name somebody cleared is not.
 * </p>
 */
export function doorSetupChip(device: AdminDoorDevice): DoorChip | null {
  if (device.gate_key !== null) return null;
  return { label: "Needs a door name", tone: "warning" };
}

/**
 * <b>R3-1 — whether this SHUT door has been told, and the three answers that exist.</b>
 *
 * <p>
 * <b>The falsehood this closes, in full, because it is the worst one this surface has
 * shipped.</b> `DeviceIdentity.ResolveAsync` returned `Forbid()` <i>before</i>
 * `DeviceSilenceLog.NoteContact`, so the moment a door was shut its `last_seen_at` froze. One
 * hundred and eighty seconds later the chip flipped to "Not reporting", the page said
 * "Nothing can reach Front door, so it has not been told. It may still be admitting booked
 * members from its saved list", and the reopen confirm said "It has been admitting booked
 * members from its saved list all along". Every word of that was false: the board had been
 * served a 403 within one heartbeat, had denied every scan outright and had committed an
 * empty roster. The console reported a working shut as a failed one and invited an admin to
 * go and stand at a door that was already refusing everybody.
 * </p>
 *
 * <p>
 * <b>Silence is not evidence about a shut door, in either direction</b>, and the rule this
 * function exists to enforce is that no sentence about a shut door is derived from an age.
 * `shut_heard_at` is the only evidence there is: the first 403 served after this shut began.
 * </p>
 *
 * <ul>
 *   <li><b>confirmed</b> — an instant. The board heard it and emptied its list. True for
 *       ever after, whatever the door has done since: a door that heard the shut and then
 *       lost the network is still opening for nobody.</li>
 *   <li><b>not_told</b> — an explicit `null`. Shut, and it has not called since. This is the
 *       state the cached-list caveat is actually about, and it is the only one.</li>
 *   <li><b>unknown</b> — the field is absent. An API that has not said. <b>Unknown is not
 *       false</b>: the screens say they cannot tell rather than picking the arm a frozen age
 *       points at, which is precisely how the wrong one came to be printed.</li>
 * </ul>
 */
export type DoorShutHeardState = "confirmed" | "not_told" | "unknown";

export type DoorShutHeard = { state: DoorShutHeardState; at: string | null };

export function doorShutHeard(device: {
  enabled?: boolean; shut_heard_at?: string | null;
}): DoorShutHeard {
  // An OPEN door has not been told anything; every caller guards on `enabled`, and this arm
  // exists so that one which forgets to cannot get a confident answer out of a stale field.
  if (device.enabled !== false) return { state: "unknown", at: null };
  const heard = device.shut_heard_at;
  if (heard === undefined) return { state: "unknown", at: null };
  return heard === null ? { state: "not_told", at: null } : { state: "confirmed", at: heard };
}

/**
 * The confirmation clause a shut door's notice carries, or null where there is nothing to add.
 *
 * <p>
 * The clock face is the club's, because "heard the shut at 06:09" read in the admin's own
 * zone is the R3-3 defect one sentence along.
 * </p>
 */
export function doorShutHeardLine(
  device: AdminDoorDevice, timezone: string, named = device.gate_key !== null,
): string | null {
  const heard = doorShutHeard(device);
  if (heard.state === "confirmed") {
    return `Confirmed: this door heard the shut at ${clubDayAndClock(heard.at!, timezone)}, so it`
      + " opens for nobody — it threw its saved list away when it was told.";
  }
  if (heard.state === "not_told") {
    if (!named) {
      return "Not confirmed: it has not called in since it was shut, so it has not been told. It has"
        + " no door name, so it holds no saved list and opens for nobody anyway.";
    }
    return "Not confirmed: it has not called in since it was shut, so it has not been told, and it"
      + " keeps admitting members with a booking from the list it last downloaded until that goes"
      + " stale — up to six hours after its last call.";
  }
  return null;
}

/**
 * Who shut this door, and when — A5's replacement for "You shut this door."
 *
 * <p>
 * <b>Never "you", on any arm.</b> A club has several admins; the sentence was true for at
 * most one of them and there was no way to tell from the screen which. Both facts are
 * optional on the wire, so all four arms exist and none of them invents an actor.
 * </p>
 */
export function doorShutAttribution(device: AdminDoorDevice, timezone: string): string {
  const who = device.shut_by_name ?? null;
  const at = device.out_of_service_since ? clubDayAndClock(device.out_of_service_since, timezone) : null;
  if (who === null && at === null) return "This door is shut.";
  if (who === null) return `This door was shut on ${at}.`;
  return at === null ? `Shut by ${who}.` : `Shut by ${who} at ${at}.`;
}

/**
 * The paragraph under the chips: what this state MEANS for this door right now.
 *
 * <p>
 * Five branches, and every one of them says what the door does while the club can reach it
 * AND what it does when the club cannot. The third branch prints a clock face for when the
 * cached list dies — `last_seen_at` plus six hours, the firmware's own roster age — because
 * an admin standing in a club at 09:00 needs a time, not an interval to add up.
 * </p>
 */
export function doorStateNotice(
  device: AdminDoorDevice, online: boolean | null, timezone: string,
): string | null {
  // A8: with the reads themselves failing, every sentence below is derived from a frozen age
  // and would be a claim about a door made out of a fact about the browser. Null rather than
  // {@link DOORS_LIVENESS_SUSPENDED}: the page says that ONCE, above the cards, and a copy
  // of it on every tile is the same sentence four times on one screen.
  if (online === null && device.enabled) return null;
  // A5: it said "You shut this door." to every admin who opened the page — false for all but
  // one of them, and unfalsifiable for the reader. The audit row has always carried the
  // actor; WIRE-R2 §2 puts the name on the door row, so the screen can say who and when.
  //
  // R3-1: and the shut's own CONFIRMATION comes from `shut_heard_at`, never from the age.
  // Where the API says, that clause replaces the generic both-halves paragraph — there is no
  // longer a pair to state, because this door's half is known. Where it does not say, the
  // paragraph stands exactly as it was, which is the honest render of "cannot tell".
  if (!device.enabled) {
    const heard = doorShutHeardLine(device, timezone);
    return `${doorShutAttribution(device, timezone)} ${heard ?? doorShutNotice()}`;
  }
  const named = device.gate_key !== null;
  if (online) {
    if (named) {
      return "The club decides every scan at this door as it happens. If it loses the network it opens"
        + " for members with a booking, from the list it last downloaded, until that list goes stale"
        + " six hours after its last call.";
    }
    return "The club decides every scan at this door as it happens. It has no door name, so it is sent"
      + " an empty list and opens nothing at all while it is offline.";
  }
  if (!named) {
    return "Nothing can reach it, and it has no door name, so it was sent an empty list. It opens for"
      + " nobody until it is back.";
  }
  const head = "Nothing can reach it. A change you make now arrives only when it calls in again.";
  if (device.last_seen_at === null) {
    return `${head} Until then it opens for nobody, and it has never called in, so it holds no list at`
      + " all.";
  }
  // A7: the DAY as well as the clock face. Six hours after a last call at 21:00 is 03:00
  // tomorrow, and an admin standing in a club at 09:00 reading "goes stale at 03:00" cannot
  // tell whether that has already happened. `clubDayAndClock` carries the date too (B20).
  const stale = clubDayAndClock(new Date(new Date(device.last_seen_at).getTime() + ROSTER_MAX_AGE_MS).toISOString(), timezone);
  return `${head} Until then it opens for members with a booking, from the list it last downloaded,`
    + ` and that list goes stale on ${stale}.`;
}

/**
 * The day boundary, named rather than assumed.
 *
 * "Today" computed in a browser is a different day from the club's for any admin travelling
 * or with a wrong device clock, and this is the one number on the page an admin quotes in a
 * committee meeting.
 */
export function doorScanCountHeading(dayStartedAt: string, timezone: string): string {
  return `Since ${clubClock(dayStartedAt, timezone)} club time`;
}

/**
 * Today's two numbers — and it is TWO, always.
 *
 * <p>
 * One headline number per door, on a list of doors, is a footfall ranking by accident: the
 * exact shape P3 exists to prevent, and the first person to sort it has built the report
 * nobody agreed to. A failed count says so instead of rendering a zero — a zero on a failed
 * read is the `admin-failed-read` defect with a different noun, and it sends an admin to look
 * for a board that is fine.
 * </p>
 */
export function doorScanCountLine(today: DoorToday | null, online: boolean | null = true): string {
  if (today === null) return "Today's scans could not be read.";
  const counts = `${today.released} released · ${today.refused} refused`;
  // <b>A-H4 / R3-25 — "Since 00:00 — 13 released · 12 refused" printed as complete, over a
  // door nothing could reach.</b> These are the club's counts of what it was TOLD, and a
  // door that has lost the network goes on deciding scans from its cached list and delivers
  // them whenever it next calls in. So on an unreachable door the pair is a floor, not a
  // total, and an admin reading it as a total concludes a busy evening was a quiet one. The
  // `null` arm takes the same qualifier: a page that cannot say whether the door is
  // reporting cannot say the counts are complete either.
  if (online === true) return counts;
  return `${counts} — as far as the club has heard`;
}

/**
 * "No scans at this door since Wed 18:40 — that is 3 days."
 *
 * <p>
 * The boundary is the club's calendar day, not a threshold somebody picked, because "has
 * anyone been through today?" is the question an admin actually has. It states the fact and
 * does not editorialise: a reporting door with no scans is normal at 09:00 and a question at
 * 20:00, and the screen is not in a position to tell which.
 * </p>
 *
 * <p>
 * Silent when there is no scan at all — that is an EMPTY feed, which is a different sentence
 * and a different fact.
 * </p>
 */
export function doorQuietNotice(
  newestAt: string | null, dayStartedAt: string, now: number, timezone: string,
): string | null {
  if (newestAt === null) return null;
  const newest = new Date(newestAt).getTime();
  if (newest >= new Date(dayStartedAt).getTime()) return null;
  const days = Math.max(1, Math.round((now - newest) / 86_400_000));
  return `No scans at this door since ${clubDayAndClock(newestAt, timezone)} — that is ${plural(days, "day")}.`;
}

/** The chip a signal wears on a tile. Words, never colour alone. */
export function doorSignalChip(kind: DoorSignal["kind"]): DoorChip {
  return kind === "refusal_spike"
    ? { label: "Refusing a lot", tone: "warning" }
    : { label: "May not be releasing", tone: "warning" };
}

/**
 * <b>A9 / B9 — a signal, explained, on the card it appears on.</b>
 *
 * <p>
 * The chips were unexplained on the overview: an admin met "May not be releasing" as two
 * words on a tile, with the explanation on a page they had not opened. Worse, the signals and
 * their advice survived a state that makes them meaningless — "usually a dirty scanner" on a
 * door the club shut hours ago, and "change how long the lock is released" on a door that has
 * not been heard from since.
 * </p>
 *
 * <p>
 * <b>Null is the answer for a shut or unreachable door, and for one this page cannot judge.</b>
 * A signal is a reading of the last N minutes of scans; on a shut door those scans are all
 * refusals the club itself caused, and on a cut-off door the club has not seen the recent ones
 * at all. The reading is not wrong so much as about a different question, and the honest thing
 * is to say what the door's state is instead.
 * </p>
 */
export type DoorSignalLine = {
  text: string;
  /** The `#setting-…` hash the action links to, or null where the action is not a setting. */
  settingHash: string | null;
  action: string;
};

export function doorSignalLine(
  device: AdminDoorDevice, online: boolean | null, signal: DoorSignal, settings: SignalNumbers,
): DoorSignalLine | null {
  if (!device.enabled || online !== true) return null;
  if (signal.kind === "refusal_spike") {
    if (settings.spikeMinutes === null) return null;
    return {
      text: `Turned away ${plural(signal.scans, "scan")} in the last ${plural(settings.spikeMinutes, "minute")}`
        + " — usually a dirty scanner, an expired code, or a stricter door policy than people expect.",
      settingHash: null,
      action: "Look at the reasons",
    };
  }
  const release = settings.unlockSeconds === null
    ? "How long the lock is released is under Admin settings."
    : `The lock is released for ${plural(settings.unlockSeconds, "second")}.`;
  return {
    text: `A code was accepted three times in under a minute, and people do not scan again when a door`
      + ` opens. ${release}`,
    settingHash: "#setting-gate-unlock-seconds",
    action: "Change how long the lock is released",
  };
}

/** The club's own numbers a signal sentence needs, or nulls where the settings read failed. */
export type SignalNumbers = { spikeMinutes: number | null; unlockSeconds: number | null };

/**
 * S1 — a door turning people away.
 *
 * <p>
 * <b>It counts scans and says so.</b> The derivation is a count of refusals, and an admin who
 * reads "11 people were turned away" goes looking for eleven members. One person trying four
 * times is four, and the sentence says that rather than leaving it to be inferred.
 * </p>
 *
 * <p>
 * Both numbers are the club's own settings interpolated, so a club that widens the window
 * reads its own window back. Where the settings read failed, the caller renders nothing at
 * all rather than this sentence with a guessed threshold in it.
 * </p>
 *
 * <p>
 * Windowed by construction: it describes the last N minutes and disappears on its own when
 * the window empties, so there is nothing to acknowledge and no table to acknowledge it in.
 * </p>
 */
export function doorRefusalSpikeNotice(doorName: string, scans: number, minutes: number): string {
  return `${doorName} turned away ${plural(scans, "scan")} in the last ${plural(minutes, "minute")}.`
    + " That is usually a dirty scanner, a member holding a code that has expired, or the club's door"
    + " policy being stricter than people expect. This counts scans, not people — one person trying"
    + " four times is four. Look at the reasons below to see which one is repeating.";
}

/**
 * S2 — a door that may not be letting go of the lock.
 *
 * <p>
 * <b>The derivation names a credential; this sentence must not (D4).</b> The rule is "the same
 * credential granted three or more times within sixty seconds at one door", and at a club of
 * two hundred people a credential is a member. A flag rendering the fingerprint — or the
 * resolved name — has become a per-member observation on an admin screen, which P3 and P4
 * forbid as plainly as a filter control would. So the subject of every sentence here is the
 * DOOR, the count is of scans, and the payload this is built from carries no member at all.
 * </p>
 *
 * <p>
 * It states its own limits in the same breath as the claim, because the claim is a guess: a
 * stuck door and somebody who scanned and walked away look identical from here, and so does a
 * release too short for a heavy door — which is why the release setting is named, both ways.
 * </p>
 */
export function doorMayNotBeReleasingNotice(doorName: string, unlockSeconds: number | null): string {
  const head = `${doorName} may not be releasing. A code was accepted three times in under a minute,`
    + " and people do not scan again when a door opens. This cannot tell a stuck door from somebody"
    + " who scanned and walked away, or from a release too short for a heavy door.";
  if (unlockSeconds === null) {
    return `${head} How long the lock is released is under Admin settings.`;
  }
  return `${head} The release is set to ${plural(unlockSeconds, "second")}.`;
}

/**
 * The two P2 banners the club log carries permanently.
 *
 * <p>
 * Not dismissible, and that is deliberate: dismissing one is how it stops being true for the
 * next reader, who is usually a committee member reading a log after an incident.
 * </p>
 */
export function doorLogHowToRead(): [string, string] {
  return [
    "A code says whose code it was, not who walked through. There is no camera and no second factor"
    + " at a door, and a member who shares their QR shares entry.",
    "“Lock released” means the board released the lock. There is no door sensor, so nothing"
    + " here can say the door was actually pushed.",
  ];
}

/**
 * W1.9's retention statement, in three halves.
 *
 * <p>
 * A guessed 90 is worse than no number: the value is a tenant setting, a club may have moved
 * it, and this sentence is the one a committee reads when it asks how long the club keeps
 * door records. Where the settings read failed, the sentence names the field instead and
 * carries no digits at all.
 * </p>
 */
export function doorRetentionNotice(days: number | null): string {
  const tail = " Money records follow a separate, longer rule.";
  // A11: ONE sentence, with the number in it when the number is known. The two arms used to
  // be different sentences making different KINDS of claim — one stated a fact about the
  // records, the other named a setting — so an admin who read the page online and again
  // during an outage was told two different things about the same rule and could not tell
  // whether the rule had changed or the page had.
  const how = days === null ? "the number of days set under Admin settings" : plural(days, "day");
  return `Door scans are kept for ${how} and then deleted, receipts and all.${tail}`;
}

/**
 * The note that lives at the CSV button, permanently, rather than in a confirm dialog.
 *
 * A CSV is the one action on this surface that moves data past every guard the product has,
 * and the honest thing is to say so where the click is — a dialog is something an admin
 * dismisses.
 */
export function doorCsvNotice(days: number | null): string {
  const rule = days === null ? "the club's retention rule" : `the club's ${days}-day rule`;
  // B3 / A15. "The same rows as this page" was not true and the reviewer proved it: the page
  // shows one page of 50 and the file carried 165. It is the same FILTERS, over everything
  // that matches them, which is a different and more useful promise — and the cap is named
  // because a club with more than that gets a truncated file and has to know.
  return `The file has every scan matching the filters above, not just the ${DOOR_LOG_PAGE_HINT} on`
    + ` this page, and up to ${CSV_MAX_ROWS.toLocaleString("en-GB")} rows. Members' names are in it.`
    + ` Once it is downloaded it is outside ${rule}.`;
}

/** WIRE-W1 §4's cap. Named on screen because a truncated export is silent otherwise. */
export const CSV_MAX_ROWS = 10_000;

const DOOR_LOG_PAGE_HINT = "rows";

/**
 * How many rows the file actually has, announced after the download (B3).
 *
 * <p>
 * The toast said "50 scans downloaded" — the length of the list on screen — over a 165-row
 * file. It is the one number an admin repeats to a committee, and it was the wrong one by a
 * factor of three. The real count comes from the response's own `X-Crusaders-Rows` header;
 * where the header is absent the sentence carries NO number rather than falling back to the
 * page length, because a wrong number is worse than no number.
 * </p>
 */
export function doorCsvDownloaded(rows: number | null, truncated = false): string {
  if (rows === null) {
    return "The file has downloaded. It holds every scan matching the filters, which may be more"
      + " than this page shows.";
  }
  // Truncation comes from the server's own `X-Crusaders-Truncated`, not from comparing the
  // count to a cap this side holds: the cap is the server's, and a client that decides
  // "this looks like the limit" is wrong the day the server's limit moves.
  if (truncated) {
    return `${plural(rows, "scan")} downloaded — that is as many as one file holds, so older scans`
      + " in this range were left out. Narrow the range to get the rest.";
  }
  return `${plural(rows, "scan")} downloaded.`;
}

/**
 * <b>A-H2 / R3-14 — the export failed and there was no word of it anywhere.</b>
 *
 * <p>
 * Offline, or on a 500, the button went back to "Download CSV" and nothing else on the page
 * changed. The toast the handler pushes is not enough on its own and the reviewer proved why:
 * it floats above the content, it times out, and on the one action whose whole output is a
 * file that either exists or does not, a message that has already gone is the same as no
 * message. So the failure is also stated beside the button, where it stays until the next
 * attempt, and it says the thing a toast never said — that no file was written.
 * </p>
 */
export function doorCsvFailed(reason: string): string {
  return `${reason} No file was downloaded — nothing has been exported, and nothing at the doors`
    + " has changed. Try again, or narrow the range if this keeps happening.";
}

/**
 * <b>A-M7 / R3-14 — a door was deleted and the next screen said nothing about it.</b>
 *
 * <p>
 * The toast is pushed and then the page navigates, which unmounts the toast host's contents
 * on the route change — so the confirmation for the single most destructive control on the
 * surface was, in practice, invisible. An admin arrived back at a list of doors with one
 * fewer row and no statement that the club had done it, which on a page that also polls looks
 * exactly like a board that has dropped off.
 * </p>
 *
 * <p>
 * It carries the two facts a delete's own confirm promised: the scans are not gone, and the
 * board is not locked out.
 * </p>
 */
export function doorDeletedNotice(name: string): string {
  return `${name} was deleted. Its past scans are still in the club log under its old name, and`
    + " the board still has the club's key — it reappears here as a new door with nothing filled"
    + " in the next time it calls in. Unplug it if you meant to retire it.";
}

/** Under the last row, when there is no further cursor. */
export function doorExhaustedNotice(retentionDays: number | null): string {
  if (retentionDays === null) return "That is everything in this range.";
  return `That is everything kept for this range. Scans older than ${plural(retentionDays, "day")} are deleted.`;
}

/**
 * The one-door empty state — the answer to the spec's own question.
 *
 * <p>
 * "Nobody could get in through the side door all Tuesday" has two causes that look identical
 * from a log: nobody tried, or the board never reached the club to say they did. The screen
 * cannot tell them apart, so it names the second rather than implying the first.
 * </p>
 */
export function doorLogEmptyOneDoor(
  doorName: string, from: string, online: boolean | null = null,
): string {
  const head = `No scans at ${doorName} between ${from} and now.`;
  // C7. The second sentence used to be asserted whatever the door was doing, so an admin
  // filtering a perfectly healthy door to a quiet range was sent to look for a fault. It is
  // now derived from the door's OWN liveness — and the third arm says the screen does not
  // know, rather than guessing either way.
  if (online === true) {
    return `${head} It is reporting, so the club is hearing from it — nobody has scanned at it in`
      + " this range.";
  }
  if (online === false) {
    return `${head} Nothing can reach it, so if members have been using it the club would not know.`;
  }
  return `${head} This page cannot say whether that board is reaching the club — check it on Doors.`;
}

/**
 * How stale the page is, once two polls in a row have failed.
 *
 * <p>
 * The second sentence is the one that matters. `relative(last_seen_at)` goes on being exactly
 * true while the page is stale — it counts from when each DOOR called in, not from when this
 * page last read — and an admin must not be told to distrust the number that is still right.
 * </p>
 *
 * <p>
 * Silent below two failures: one dropped request on a phone is not news, and a page that
 * announced every one of them would be a page nobody reads the third time.
 * </p>
 */
export function doorStaleChecksNotice(failures: number, secondsSinceRead: number): string | null {
  if (failures < 2) return null;
  return `The last ${failures} checks failed, so this was read ${plural(secondsSinceRead, "second")} ago.`
    + " The ages below are still counted from when each door last called in.";
}

/**
 * Why this door needs somebody — or null.
 *
 * <p>
 * <b>Three states count: silent, shut, unnamed (A2.6).</b> Not counted: refusal spikes, the
 * releasing flag, scan counts. Those are operational detail, and a badge that fires on a dirty
 * scanner is a badge an admin learns to ignore before the badge that fires on a dead board
 * ever appears.
 * </p>
 *
 * <p>
 * Shut is checked first: an admin who shut a door is not to be told it has gone quiet, which
 * is a state they created and already know about.
 * </p>
 */
export function doorNeedsAttention(device: AdminDoorDevice, online: boolean | null): string | null {
  return doorAttentionReason(device, online, [])?.reason ?? null;
}

/** Why a door needs somebody, and which of the four kinds of "needs somebody" it is. */
export type DoorAttention = {
  kind: "silent" | "shut" | "unnamed" | "signal";
  reason: string;
  /**
   * WHICH door, so the summary above the tiles can LINK to it (A10).
   *
   * The overview used to re-sort by severity every poll so the door that needed somebody was
   * first — and cards swapped under a thumb already on its way down. Name order is stable
   * now, and the summary is what carries the reader to the right card.
   */
  doorId: string;
  doorName: string;
};

/**
 * Why this door needs somebody — or null. <b>Signals count (A3).</b>
 *
 * <p>
 * <b>What was wrong.</b> A door flagged "Refusing a lot" or "May not be releasing" was
 * invisible to every cue the product has: it was never in the gear badge, never named in the
 * doors page's own banner, and — because the ordering used the same predicate — it sorted
 * below the fold on a phone, under three healthy doors. A reviewer found a front door
 * turning away thirty scans in twenty minutes by scrolling past it. The signal rendered
 * perfectly on the tile nobody could see.
 * </p>
 *
 * <p>
 * <b>A2.6 is not violated by this and it is worth saying why.</b> That amendment keeps
 * signals off ADMIN HOME — "a badge that fires on a dirty scanner is a badge an admin learns
 * to ignore before the badge that fires on a dead board ever appears" — and Home is a screen
 * an admin sees on every visit, whether or not they came about doors. `/admin/doors`, its
 * banner, and the gear that is the only route to it are a different surface with a different
 * reader: somebody who has come to look at doors, or is being told there is something to
 * look at. {@link doorNeedsAttention} keeps the three-state rule for Home's row, and this
 * one carries the four for everywhere else.
 * </p>
 *
 * <p>
 * Shut is checked before silence, because an admin who shut a door is not to be told it has
 * gone quiet — a state they created and already know about. Signals are checked LAST: a door
 * that is both unreachable and refusing is a door to go and look at, and "has not been heard
 * from" is the sentence that sends somebody to the right place.
 * </p>
 */
export function doorAttentionReason(
  device: AdminDoorDevice, online: boolean | null, signals: DoorSignal[],
): DoorAttention | null {
  const where = { doorId: device.id, doorName: doorDisplayName(device) };
  const name = where.doorName;
  if (!device.enabled) {
    // C2's family, one screen along. "Nobody gets in through it" was said of every shut
    // door — including one the club cannot reach, which has not heard the refusal and goes
    // on admitting booked members from its saved list. Found by looking at a rendered
    // overview where the banner correctly said "1 not yet" and the line under it flatly
    // contradicted it about the same door.
    // A8: `null` is "this page cannot say", and it takes the SHUT sentence without the
    // liveness clause — shut is a state the page read, not one it derived from an age.
    //
    // R3-1: `shut_heard_at` outranks liveness on BOTH arms where the API sends it. A door
    // that heard the shut opens for nobody even though it has since gone quiet, and a door
    // that is reporting has still not necessarily been told — the summary above the tiles
    // was making the opposite claim in both directions out of an age that had frozen.
    const heard = doorShutHeard(device);
    if (heard.state === "confirmed") {
      return { ...where, kind: "shut", reason: `${name} is shut and has been told. Nobody gets in through it.` };
    }
    if (heard.state === "not_told") {
      return {
        ...where,
        kind: "shut",
        reason: `${name} is shut but has not called in since, so it has not been told.`,
      };
    }
    if (online === null) return { ...where, kind: "shut", reason: `${name} is shut.` };
    if (!online) {
      return {
        ...where,
        kind: "shut",
        reason: `${name} is shut, and the club has not heard from it since — this page cannot say`
          + " whether it was told.",
      };
    }
    return { ...where, kind: "shut", reason: `${name} is shut. Nobody gets in through it.` };
  }
  if (device.gate_key === null) {
    return {
      ...where,
      kind: "unnamed",
      reason: `${name} still has no name, so it opens nothing while it is offline.`,
    };
  }
  // A8: not "has not been heard from" while the thing that cannot hear is this browser.
  if (online === false) return { ...where, kind: "silent", reason: `${name} has not been heard from.` };
  const signal = signals[0];
  if (signal && online === true) {
    return {
      ...where,
      kind: "signal",
      reason: signal.kind === "refusal_spike"
        ? `${name} is turning a lot of scans away.`
        : `${name} may not be releasing.`,
    };
  }
  return null;
}

/**
 * One line for the gear dot's tooltip, the Home row and the page's own status block.
 *
 * Names one door rather than counting them all, because a count is not a job: "3 doors need
 * attention" sends nobody anywhere, and "Side door has not been heard from" does.
 */
export function doorsAttentionSummary(reasons: string[]): string | null {
  if (reasons.length === 0) return null;
  const [first, ...rest] = reasons;
  if (rest.length === 0) return first;
  return `${first} ${plural(rest.length, "other door")} ${rest.length === 1 ? "needs" : "need"} attention.`;
}

/**
 * The chip at the head of a feed row — the row's outcome, first, before who and when.
 *
 * <p>
 * <b>A grant reads "Lock released", never "Opened" (A1.2).</b> P2: the strongest thing this
 * product can say is that the board reported it energised the lock. There is no sensor on any
 * door, and a sentence underneath cannot retract a word the chip has already said.
 * </p>
 *
 * <p>
 * An offline refusal has no reason token at all — a board that cannot resolve a code has
 * nothing to name — so it falls to the plain word rather than to a blank chip. So does a
 * refusal reason this build has not seen: a chip with no label is a row an admin cannot read,
 * and the set of reasons grows from the firmware, never from this screen.
 * </p>
 */
export function doorOutcomeChip(entry: DeviceActivityEntry): string {
  if (classifyDoorRow(entry) === "released") return DOOR_OUTCOME_CHIPS.ok;
  if (entry.reason && DOOR_OUTCOME_CHIPS[entry.reason]) return DOOR_OUTCOME_CHIPS[entry.reason];
  return "Refused";
}

/**
 * What one feed row IS, before anything decides how to paint it.
 *
 * <p>
 * <b>The whole of B1 / A2 / C4 is here.</b> `DoorFeedRow` chose its chip tone with
 * `action.startsWith("gate.denied") ? "warning" : "success"` — a two-way test on a four-way
 * fact — so every row that was not a recognised refusal came out success-green, including
 * `device.updated` (an admin edit), `device.boot` and `doors.shut_all`. It then labelled them
 * "Refused", because `doorOutcomeChip`'s own catch-all was the word "Refused". Green, and
 * saying refused, about somebody renaming a door.
 * </p>
 *
 * <p>
 * The tone now falls out of the classification and cannot be chosen at a call site:
 * <b>a refusal is NEVER success-toned</b>, an event and an unrecognised row are never toned
 * as an outcome at all, and there is no branch left that can guess.
 * </p>
 */
export type DoorRowRender = {
  kind: DoorRowKind;
  /** The chip's word, or null where this row is not an outcome and must not wear one. */
  chip: string | null;
  tone: DoorChip["tone"];
  /**
   * The sentence under the chip. Never null for a refusal — {@link NO_REASON_RECORDED} is
   * the arm for a refusal the trail could not say a reason for, because a refusal row with
   * an empty second line reads as a rendering fault and leaves the reader guessing.
   */
  detail: string | null;
};

/**
 * A refusal the audit trail carries no reason for.
 *
 * <p>
 * Five of eight refusals on one reviewed screen had no reason line at all. A missing reason
 * is a real state — an offline board that cannot resolve a code has nothing to name, and a
 * row written before a reason was recorded has nothing to read — and it is a different fact
 * from "the reason is uninteresting". Said out loud, once, rather than left blank.
 * </p>
 */
export const NO_REASON_RECORDED = "No reason recorded";

/**
 * When an offline row happened, and when the club learned of it (A4).
 *
 * <p>
 * <b>The contradiction this closes.</b> A reviewer read "Last heard from 21:00" beside scans
 * "decided at the door at 21:25" and could not reconcile them. Both were true: an offline
 * row is stamped with the SCAN, and the board delivers it whenever it next calls in — and
 * that upload IS contact, so `last_seen_at` moves to the upload. The row now says both
 * instants, so the pair reads as two facts rather than as a clock that disagrees with
 * itself.
 * </p>
 *
 * <p>
 * <b>No delay is rendered when `delivered_at` is null.</b> It is non-null on offline rows
 * only, so a null means the scan was decided at the club as it happened and there is no
 * second instant to report. The earlier draft filled that gap with "the club was told when
 * the door next called in", which invents a delay for a row that had none.
 * </p>
 */
/**
 * <b>E8 / C-H4 / A-H1 / R3-17 — "the door told us at 19:22" about a 19:48 scan.</b>
 *
 * <p>
 * A board has no real-time clock. It reports an offset from its own boot, and a board whose
 * clock has drifted hands the server a scan instant from the future or the past — which is
 * why the server writes `device.event_time_clamped` about it. The row said nothing, and
 * printed the two instants in an order that cannot have happened: delivered BEFORE decided.
 * A reader who meets that has two choices, and both are wrong — believe it, or stop trusting
 * every time on the page.
 * </p>
 *
 * <p>
 * <b>The guard runs from the instants themselves as well as from the flag</b>, so a row an
 * older API cannot mark is still never printed in an impossible order. `time_uncertain` adds
 * the case the instants cannot show: a time the server CLAMPED, which comes out plausible
 * precisely because it was corrected.
 * </p>
 */
export function doorTimeIsUncertain(entry: {
  at: string; delivered_at?: string | null; time_uncertain?: boolean;
}): boolean {
  if (entry.time_uncertain === true) return true;
  if (!entry.delivered_at) return false;
  // Strictly earlier. Equal is the ordinary case of a row decided and delivered in one call.
  return new Date(entry.delivered_at).getTime() < new Date(entry.at).getTime();
}

/** What a row whose own clock is in doubt says about its time, wherever that time is shown. */
export const TIME_UNCERTAIN_NOTE = "The door's clock was out, so this time is approximate.";

export function doorScanTiming(
  at: string, deliveredAt: string | null | undefined, timezone?: string, uncertain = false,
): string | null {
  // R3-17: an uncertain row never prints the pair as a sequence. The DELIVERY instant is the
  // server's own clock and is sound; the scan instant is the board's and is not, so the row
  // says which is which rather than implying an order between them.
  if (uncertain) {
    if (!deliveredAt) return TIME_UNCERTAIN_NOTE;
    return `${TIME_UNCERTAIN_NOTE} The club was told at ${clubClock(deliveredAt, timezone)}.`;
  }
  // A7: the row prints the clock face itself now, so a row with ONE instant has nothing left
  // for this line to add and returns null rather than repeating the time underneath itself.
  if (!deliveredAt) return null;
  const decided = clubClock(at, timezone);
  const told = clubClock(deliveredAt, timezone);
  // A3: "decided at the door at 09:38 — the door told us at 09:38" is one fact printed
  // twice, and nine rows of it taught a reviewer to read the pair as a clock disagreeing
  // with itself. When the two land in one minute the row says so in words and prints one.
  if (decided === told) return `Decided at the door at ${decided}, and the club heard within the minute.`;
  return `Decided at the door at ${decided} — the door told us at ${told}.`;
}

/** The long form, for a `title` where the fact has to arrive once and completely. */
export function doorScanTimingLong(
  at: string, deliveredAt: string | null | undefined, timezone?: string, uncertain = false,
): string {
  // R3-17: the accessible name is where the fact has to arrive once and completely, so the
  // doubt travels with it. A `title` a sighted reader can hover and a name a screen-reader
  // user hears must not disagree about whether a time can be trusted.
  if (uncertain) {
    const told = deliveredAt ? ` The club was told at ${clubInstant(deliveredAt, timezone)}.` : "";
    return `${clubInstant(at, timezone)}. ${TIME_UNCERTAIN_NOTE}${told}`;
  }
  if (!deliveredAt) return clubInstant(at, timezone);
  const decided = clubInstant(at, timezone);
  const told = clubInstant(deliveredAt, timezone);
  if (clubClock(at, timezone) === clubClock(deliveredAt, timezone)) {
    return `Decided at the door at ${decided}, and the club heard within the minute.`;
  }
  return `Decided at the door at ${decided} — the door told us at ${told}.`;
}

/**
 * Why some offline rows name a member and others cannot (A3).
 *
 * <p>
 * A reviewer read nine offline rows where some carried a name and some said the door could
 * not say who, and there was nothing on the page to reconcile them. It is not a fault and it
 * is not a privacy setting: a cut-off board decides from the list it last downloaded, so a
 * code that IS on that list resolves to its holder and a code that is not resolves to
 * nothing at all. Said once, where the offline rows are, rather than left to be inferred.
 * </p>
 */
export const OFFLINE_WHO_NOTE = "An offline row names somebody when the code was on the door's saved"
  + " list — that is what the list is. A code that is not on it resolves to nobody at all, so the"
  + " door has no name to record.";

/**
 * What the "Door events" block is, said once at the top of it.
 *
 * It exists because the alternative reading is the one that shipped: a reader who sees
 * these rows beside the scans and is not told otherwise counts them. The sentence says both
 * halves — these are not scans, and they are not in any of the numbers.
 */
export const DOOR_EVENTS_NOTE = "Things that happened to this door, rather than scans at it. None"
  + " of these are counted in the numbers above or in the club's log.";

export function doorRowRender(entry: DeviceActivityEntry): DoorRowRender {
  const kind = classifyDoorRow(entry);
  if (kind === "released") {
    return { kind, chip: DOOR_OUTCOME_CHIPS.ok, tone: "success", detail: describeActivityReason(entry) };
  }
  if (kind === "refused") {
    return {
      kind,
      chip: doorOutcomeChip(entry),
      // Never "success", whatever the reason token turns out to be.
      tone: "warning",
      detail: describeActivityReason(entry) ?? NO_REASON_RECORDED,
    };
  }
  if (kind === "event") {
    return { kind, chip: null, tone: "muted", detail: describeDoorEvent(entry) };
  }
  // The raw token is the detail here, and deliberately: it is the only thing a reader can
  // report upstream, and hiding it would make a new action unsearchable.
  return { kind, chip: null, tone: "muted", detail: `${UNRECOGNISED_EVENT} · ${entry.action}` };
}

/**
 * The events a door's page shows beside its scans, whether or not the API sends them yet.
 *
 * <p>
 * Two sources, one list. Where the API serves its own `events` array those are the truth;
 * where it does not, the non-scan rows still arriving inside `items` are lifted out and
 * rendered identically — so the page is right against both backends and there is exactly one
 * place that decides what an event looks like. Deduplicated on the instant and the words,
 * because during the changeover a row can legitimately arrive down both paths.
 * </p>
 */
export type DoorEventRow = {
  at: string;
  text: string;
  token: string | null;
  /**
   * How many identical events this row stands for (A-L4 / R3-17 / WIRE-R3 §6).
   *
   * 1 for an ordinary row. The server groups and sends a `count`; this side also collapses
   * rows that are identical in BOTH the words and the minute, because nine "the board's
   * clock was out and was corrected" rows at one minute filled a door's whole event block
   * and said one thing nine times — and they arrive that way from any backend that has not
   * grouped them yet.
   */
  count: number;
};

/** A row's minute, which is the window identical events are collapsed within. */
function minuteOf(at: string): string {
  return at.slice(0, 16);
}

export function doorEventRows(
  items: DeviceActivityEntry[] | null, events: DoorEventEntry[] | null | undefined,
): DoorEventRow[] {
  // The raw token travels with an UNRECOGNISED row only. On a recognised one it is noise —
  // the sentence already says what happened — and on an unrecognised one it is the only
  // thing a reader can report upstream.
  const rows: DoorEventRow[] = (events ?? []).map((e) => ({
    at: e.at,
    // A5 / E-L3: `change` where the API sends it, `kind` where it does not. Nine identical
    // "this door's details or state were changed" rows told an admin nothing, and the actor
    // has been on the audit row since the gate shipped.
    text: describeDoorEventChange(e),
    token: describeDoorEventKind(e) === UNRECOGNISED_EVENT && !e.change ? e.action : null,
    // The server's own count where it has grouped them, never invented from rows that merely
    // look alike — a count is a claim about what happened, not about what is on screen.
    count: typeof e.count === "number" && e.count > 0 ? e.count : 1,
  }));
  for (const entry of items ?? []) {
    if (isDoorScan(entry)) continue;
    const text = describeDoorEvent(entry);
    rows.push({
      at: entry.at, text, token: text === UNRECOGNISED_EVENT ? entry.action : null, count: 1,
    });
  }
  // A-L4: identical words, identical minute → one row carrying the count. The exact-instant
  // dedupe this replaces existed for the changeover (a row arriving down both paths) and did
  // nothing for nine rows a second apart, which is the shape a clock correction actually has.
  const byKey = new Map<string, DoorEventRow>();
  for (const row of rows) {
    const key = `${minuteOf(row.at)}|${row.text}`;
    const seen = byKey.get(key);
    if (!seen) { byKey.set(key, { ...row }); continue; }
    // Keep the NEWEST instant of the group, so the collapsed row sorts where the most recent
    // of them would have.
    if (row.at > seen.at) seen.at = row.at;
    seen.count += row.count;
  }
  return [...byKey.values()].sort((a, b) => b.at.localeCompare(a.at));
}

/** "Details changed by Priya Naidoo" · "The board's clock was out and was corrected — 9 times". */
export function doorEventText(row: DoorEventRow): string {
  return row.count > 1 ? `${row.text} — ${row.count} times` : row.text;
}

/** The door-card value as a heading reads it. An unknown value is the honest default. */
export function describePowerLoss(value: string | null | undefined): string {
  const label = POWER_LOSS_LABELS[value ?? ""] ?? POWER_LOSS_LABELS.not_established;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * The overview's failed read.
 *
 * <p>
 * The false claim here is worse than the members page's: an admin who reads "no doors" while
 * a door is shut goes to look for a board that is fine. So the sentence says what the page
 * cannot know AND that the doors themselves are unchanged by this failure.
 * </p>
 */
export const DOORS_READ_FAILED = "The doors could not be read, so this page cannot say which of them"
  + " are working. Nothing has changed at the doors themselves.";

export const DOORS_EMPTY_NOTICE = "No doors have called in yet.";

export const DOORS_EMPTY_HINT = "A door registers itself the first time it is powered on with the"
  + " club's device key. The key is on the Devices page.";

/** The log's failed read. Same rule, same reason: a request failed, not a door. */
export const LOG_READ_FAILED = "These scans could not be read, so this page cannot say what happened"
  + " at the doors. Nothing at the doors has changed.";

export const LOG_EMPTY_FILTERED = "No scans match those filters.";

export const LOG_EMPTY_FILTERED_HINT = "Try a longer time range, or set Outcome back to All outcomes.";

export const LOG_EMPTY_NOTHING = "No scans at any door in the last 24 hours.";

/** A failed next page keeps the rows already on screen, and says they are still right. */
export const LOG_OLDER_FAILED = "Older scans could not be read.";
