import { DOOR_OUTCOME_CHIPS } from "./deviceActivity";
import { POWER_LOSS_LABELS, doorShutNotice } from "./gateCopy";
import { type AdminDoorDevice, type DeviceActivityEntry, type DoorSignal, type DoorToday } from "./api";

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

/** How long a cached roster lives on a board. Mirrors the firmware's `ROSTER_MAX_AGE_MS`. */
const ROSTER_MAX_AGE_MS = 6 * 3_600_000;

/** A clock face in the CLUB's zone — the zone the club's own day is measured in. */
function clubClock(iso: string, timezone: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone,
  });
}

/** "Wed 18:40" — a weekday and a clock face, in club time. */
function clubDayAndClock(iso: string, timezone: string): string {
  const day = new Date(iso).toLocaleDateString("en-GB", { weekday: "short", timeZone: timezone });
  return `${day} ${clubClock(iso, timezone)}`;
}

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
export function doorStateChip(device: AdminDoorDevice, online: boolean): DoorChip {
  if (!device.enabled) return { label: "Shut", tone: "muted" };
  return online ? { label: "Reporting", tone: "success" } : { label: "Not reporting", tone: "danger" };
}

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
 * The paragraph under the chips: what this state MEANS for this door right now.
 *
 * <p>
 * Five branches, and every one of them says what the door does while the club can reach it
 * AND what it does when the club cannot. The third branch prints a clock face for when the
 * cached list dies — `last_seen_at` plus six hours, the firmware's own roster age — because
 * an admin standing in a club at 09:00 needs a time, not an interval to add up.
 * </p>
 */
export function doorStateNotice(device: AdminDoorDevice, online: boolean, timezone: string): string {
  if (!device.enabled) return `You shut this door. ${doorShutNotice()}`;
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
  const stale = clubClock(new Date(new Date(device.last_seen_at).getTime() + ROSTER_MAX_AGE_MS).toISOString(), timezone);
  return `${head} Until then it opens for members with a booking, from the list it last downloaded,`
    + ` and that list goes stale at ${stale}.`;
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
export function doorScanCountLine(today: DoorToday | null): string {
  if (today === null) return "Today's scans could not be read.";
  return `${today.released} released · ${today.refused} refused`;
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
  if (days === null) {
    return `Door scans are deleted after the number of days set under Admin settings.${tail}`;
  }
  return `Door scans are kept for ${plural(days, "day")} and then deleted, receipts and all.${tail}`;
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
  return "The file has the same rows as this page, members' names included. Once it is downloaded it"
    + ` is outside ${rule}.`;
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
export function doorLogEmptyOneDoor(doorName: string, from: string): string {
  return `No scans at the ${doorName} between ${from} and now. If members have been using it, its`
    + " board may not be reaching the club.";
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
export function doorNeedsAttention(device: AdminDoorDevice, online: boolean): string | null {
  if (!device.enabled) return `${device.name} is shut. Nobody gets in through it.`;
  if (device.gate_key === null) {
    return "A door still has no name, so it opens nothing while it is offline.";
  }
  if (!online) return `${device.name} has not been heard from.`;
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
  if (entry.action === "gate.opened" || entry.action === "device.gate_open") {
    return DOOR_OUTCOME_CHIPS.ok;
  }
  if (entry.reason && DOOR_OUTCOME_CHIPS[entry.reason]) return DOOR_OUTCOME_CHIPS[entry.reason];
  return "Refused";
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
