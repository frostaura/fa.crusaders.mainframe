import { clubClock } from "./clubClock";
import { relative } from "./deviceLiveness";
import type {
  ControlBoardBooking, ControlBoardCourt, ControlBoardDevice, ControlBoardLights, DeviceLink,
} from "./adminApi";

/**
 * Every sentence the Control Board says, and the reason the vocabulary is the design.
 *
 * <p>
 * <b>The server does not know whether a court's lights are on.</b> `Lights/IRelayClient.cs`
 * says so in its own words — not registered in the container, because the court box is
 * pull-only and does its own switching — and the court-box heartbeat response carries no
 * relay state at all. What the API has is a projection of what it BELIEVES, fed by the
 * activation it granted and the release event the box uploaded afterwards.
 * </p>
 *
 * <p>
 * So this module holds two separate vocabularies and never mixes them. One is <b>what the
 * club expects</b>, derived from the booking and the check-in: SHOULD BE LIT, DUE, NO-SHOW,
 * FREE, HELD, UNKNOWN. The other is <b>what the box last said</b>, and it is always
 * qualified. An unqualified "ON" on a wall screen is how a club leaves a court lit all night
 * believing the software knows.
 * </p>
 *
 * <p>
 * <b>Three arms everywhere, not two.</b> `lights.stale` is absent from an API that has not
 * shipped the field yet, and reading absent as `false` is the screen asserting freshness out
 * of a gap. Every generator below takes `true` / `false` / `undefined` and the third arm says
 * less rather than guessing.
 * </p>
 *
 * <p>
 * <b>Every state is a WORD.</b> A colour-blind admin reading a tablet from across a room gets
 * `DUE` and `NO-SHOW`, not amber and red, and under forced colours the fills are discarded
 * entirely. Pure functions, no JSX, both halves of every conditional — the discipline
 * `lib/doorsCopy.ts` set.
 * </p>
 */

// ---------------------------------------------------------------------------------------
// What the club expects — derived from the booking, never from the relay
// ---------------------------------------------------------------------------------------

/**
 * The six states a court can be in, as far as the BOOKINGS are concerned.
 *
 * `unknown` is not a defensive default and not an error: it is the honest answer when the
 * box that drives this court has not called in, because a booking alone cannot tell you
 * whether anybody is playing.
 */
export type CourtExpectation = "lit" | "due" | "no_show" | "free" | "held" | "unknown";

export const EXPECTATION_WORD: Record<CourtExpectation, string> = {
  lit: "SHOULD BE LIT",
  due: "DUE",
  no_show: "NO-SHOW",
  free: "FREE",
  held: "HELD",
  unknown: "UNKNOWN",
};

/**
 * What the tile says in small print under the big word — one sentence, always present.
 *
 * Both halves of every conditional: `DUE` says what is expected AND that nobody has arrived,
 * because "DUE" alone reads as a warning to an admin who cannot see the court.
 */
export function expectationMeaning(state: CourtExpectation, graceMinutes: number | null): string {
  switch (state) {
    case "lit":
      return "Somebody identified at the box, so the box will have switched the lights on.";
    case "due":
      return graceMinutes === null
        ? "Booked, and nobody has identified at the box yet."
        : `Booked, and nobody has identified at the box yet. There are ${graceMinutes} minutes of grace.`;
    case "no_show":
      return "Booked, and nobody identified at the box inside the grace window.";
    case "free":
      return "Nothing is booked on this court right now.";
    case "held":
      return "The club is holding this court. Members cannot book it.";
    case "unknown":
      return "The box that drives this court has not called in, so nothing here can be said about it.";
  }
}

/**
 * The court's expectation, from the payload alone.
 *
 * <p>
 * <b>The box's silence outranks the booking.</b> A court whose box is offline is `unknown`
 * even when a booking covers now and somebody checked in an hour ago, because "should be lit"
 * is a claim about the present and the present is exactly what the server has stopped
 * hearing about.
 * </p>
 *
 * <p>
 * `link` absent is NOT treated as silence — an API that has not shipped the field is not an
 * offline board, and treating it as one would paint a whole wall UNKNOWN on the day the
 * frontend ships ahead of the backend.
 * </p>
 */
export function courtExpectation(court: ControlBoardCourt): CourtExpectation {
  const link = court.device?.link;
  if (link === "offline" || link === "unlinked" || link === "out_of_service") return "unknown";
  const current = court.current;
  if (!current) return "free";
  if (current.kind === "block" || current.kind === "schedule") return "held";
  if (current.checked_in_at) return "lit";
  // No check-in. Whether that is still DUE or already a no-show is the server's call, carried
  // on the booking's own status — this screen does not re-derive a grace window, because the
  // one that matters is the one the no-show sweep actually used.
  return current.status === "no_show" ? "no_show" : "due";
}

// ---------------------------------------------------------------------------------------
// The lights' own time, and the two disagreements an admin must see (FA-8, BA-04)
// ---------------------------------------------------------------------------------------

/** Are the lights on — by the box's own word where it gave one, else by the club's record? */
function lightsOn(lights: ControlBoardLights): boolean {
  return lights.confirmed_state ? lights.confirmed_state === "on" : lights.state === "on";
}

/**
 * The LIGHTS' time left, in whole seconds, or null (FA-8). The relay's own deadline (`until`),
 * never the booking's end: a court re-lit after a power cut, or one whose grant differs from the
 * booking, has light the booking does not describe. `seconds_remaining` was computed at the read
 * (`generated_at`), so without `until` it is re-based on that instant, never counted from as_of.
 */
export function lightsSecondsLeft(
  lights: ControlBoardLights | null | undefined, now: number, generatedAt: string | null | undefined,
): number | null {
  if (!lights || !lightsOn(lights)) return null;
  if (lights.until) {
    const left = Math.round((Date.parse(lights.until) - now) / 1000);
    if (Number.isFinite(left)) return left > 0 ? left : null;
  }
  if (typeof lights.seconds_remaining === "number") {
    const base = generatedAt ? Date.parse(generatedAt) : Number.NaN;
    const elapsed = Number.isFinite(base) ? Math.max(0, (now - base) / 1000) : 0;
    const left = Math.round(lights.seconds_remaining - elapsed);
    return left > 0 ? left : null;
  }
  return null;
}

/** What the big number counts: the lights, or (with no light time) the booking. */
export type CountdownSource = "lights" | "booking";

export const COUNTDOWN_LABEL: Record<CountdownSource, string> = {
  lights: "of light left",
  booking: "of the booking left",
};

export type LightsMismatch = "lit_nothing_booked" | "checked_in_dark";

export const LIGHTS_MISMATCH_WORDS: Record<LightsMismatch, string> = {
  lit_nothing_booked: "Lights on, nothing booked. The box says this court is lit and nobody has it — switch it off at the"
    + " wall if nobody is playing, and look at Faults for this box.",
  checked_in_dark: "Checked in, lights off. Somebody checked in, but the box says the lights are off — switched off early"
    + " at the box, or the relay did not close. Ask at the court.",
};

/**
 * The two disagreements between bookings and the box's own word (BA-04), each only after the
 * club's grace window, so a court switching over between two bookings is not flagged. Only the
 * box's CONFIRMED state counts: the club's own record cannot disagree with itself.
 */
export function lightsMismatch(court: ControlBoardCourt, now: number, graceMinutes: number | null): LightsMismatch | null {
  const lights = court.lights;
  if (!lights?.confirmed_state || !lights.confirmed_at || courtExpectation(court) === "unknown") return null;
  const confirmed = Date.parse(lights.confirmed_at);
  if (!Number.isFinite(confirmed)) return null;
  const graceMs = Math.max(0, graceMinutes ?? 0) * 60_000;
  if (lights.confirmed_state === "on") return litNothingBooked(court, lights, confirmed, now - graceMs);
  if (lights.confirmed_state === "off") return checkedInDark(court, confirmed, now - graceMs);
  return null;
}

/** Lit by the box's word, nothing current, and lit since before the grace window began. */
function litNothingBooked(court: ControlBoardCourt, lights: ControlBoardLights, confirmed: number, graceStart: number): LightsMismatch | null {
  if (court.current) return null;
  const since = lights.since ? Date.parse(lights.since) : confirmed;
  return Number.isFinite(since) && since < graceStart ? "lit_nothing_booked" : null;
}

/** Checked in before the grace window began, and the box said "off" AFTER the check-in. */
function checkedInDark(court: ControlBoardCourt, confirmed: number, graceStart: number): LightsMismatch | null {
  const at = court.current?.checked_in_at;
  if (!at) return null;
  const checkedIn = Date.parse(at);
  return Number.isFinite(checkedIn) && confirmed > checkedIn && checkedIn < graceStart ? "checked_in_dark" : null;
}

// ---------------------------------------------------------------------------------------
// What the box last said — always qualified
// ---------------------------------------------------------------------------------------

/**
 * The lights line: what the server believes, and how much that is worth.
 *
 * Returns `null` when there is nothing honest to say at all, so a tile renders no line rather
 * than an empty one.
 */
export function lightsLine(
  lights: ControlBoardLights | null | undefined,
  timezone: string | undefined,
): string | null {
  if (!lights) return null;
  const believed = lights.state;
  const at = lights.as_of ? clubClock(lights.as_of, timezone) : null;

  /*
   * <b>Only `confirmed_at` licenses the word "confirmed", and nothing else does.</b>
   *
   * The first version of this function read `stale === false` as confirmation, and it was
   * wrong in the one direction that matters: `stale` is a fact about how recent the SERVER's
   * own record is — the activation the API granted — and says nothing whatever about a relay.
   * Every board in the field reports no relay state until the new firmware ships, so that
   * reading would have printed "confirmed by the box" across a whole club on day one.
   */
  if (lights.confirmed_at) return boxConfirmedLine(lights, believed, clubClock(lights.confirmed_at, timezone));

  // Nothing has confirmed anything. What is left is the server's own record, and how old it
  // is — said as a record rather than as a fact, in all three arms.
  if (lights.stale === true) return staleRecordLine(believed, at);
  if (lights.stale === false) return freshRecordLine(believed, at);
  /*
   * `stale` is absent — an API that has not shipped the field. This arm has to say LESS, not
   * guess: no freshness claim in either direction, because "recent" and "stale" are both
   * claims about a field that is not there.
   */
  return unknownFreshnessLine(believed, at);
}

/** What has not been confirmed, said the same way wherever the freshness arms need it. */
const NEVER_CONFIRMED = " No box has confirmed it.";

/** The box itself reported — the only arm allowed to use the word "confirmed". */
function boxConfirmedLine(lights: ControlBoardLights, believed: string, said: string): string {
  const box = lights.confirmed_state ?? "unknown";
  // The disagreement is shown, never resolved. A box reporting a relay open while the
  // server believes it granted nothing is the contradiction an admin is there to see.
  if (box !== believed && believed !== "unknown") {
    return `The box says the lights are ${box === "on" ? "on" : box === "off" ? "off" : "in a state it cannot name"}`
      + ` (${said}), and the club's records say ${believed === "on" ? "on" : "off"}. They do not agree.`;
  }
  if (box === "on") return `Lights on — confirmed by the box at ${said}.`;
  if (box === "off") return `Lights off — confirmed by the box at ${said}.`;
  return `The box reported at ${said} and could not say what the lights are doing.`;
}

/**
 * The server's record is old, and the line says how old rather than what is true. It is the
 * LIGHTS' report that is old (R5 A5-7): the tile's health line says the box itself was heard
 * seconds ago, and "the box last reported at 18:00" beside it read as a contradiction.
 */
function staleRecordLine(believed: string, at: string | null): string {
  const since = at ? ` The lights last reported at ${at}.` : " No lights report since.";
  if (believed === "on") return `The club's records say the lights are on, but nothing has confirmed it.${since}`;
  if (believed === "off") return `The club's records say the lights are off, but nothing has confirmed it.${since}`;
  return `Nobody knows what the lights are doing on this court.${since}`;
}

/** The server's record is recent — still a record, and still unconfirmed. */
function freshRecordLine(believed: string, at: string | null): string {
  if (believed === "on") return at
    ? `The club's records say the lights went on at ${at}.${NEVER_CONFIRMED}`
    : `The club's records say the lights are on.${NEVER_CONFIRMED}`;
  if (believed === "off") return at
    ? `The club's records say the lights went off at ${at}.${NEVER_CONFIRMED}`
    : `The club's records say the lights are off.${NEVER_CONFIRMED}`;
  return "Nobody knows what the lights are doing on this court.";
}

/** No freshness field at all: the same record, with every claim about its age dropped. */
function unknownFreshnessLine(believed: string, at: string | null): string {
  if (believed === "on") return at
    ? `The club's records say the lights went on at ${at}.`
    : "The club's records say the lights are on.";
  if (believed === "off") return at
    ? `The club's records say the lights went off at ${at}.`
    : "The club's records say the lights are off.";
  return "Nobody knows what the lights are doing on this court.";
}

/**
 * "Started 18:03 — Jason Fourie scanned, booked by Thandi Mokoena."
 *
 * <p>
 * Item 10 asks for "lights on by". What the club actually knows is <i>who identified at the
 * box and when</i> — the at-court identification event is the source of truth for attendance —
 * so that is what the line says. Actor ≠ subject is the thing worth seeing: a walk-up on
 * somebody else's slot is exactly the case an admin is standing there trying to understand.
 * </p>
 */
export function startedLine(
  current: ControlBoardBooking | null | undefined,
  lights: ControlBoardLights | null | undefined,
  timezone: string | undefined,
): string | null {
  if (!current?.checked_in_at) return null;
  const at = clubClock(current.checked_in_at, timezone);
  const scanner = lights?.turned_on_by?.name ?? null;
  const booker = current.booked_by?.name ?? null;
  if (scanner && booker && scanner !== booker) {
    return `Started ${at} — ${scanner} scanned, booked by ${booker}.`;
  }
  return `Started ${at} (scanned).`;
}

/** "Next 19:00 · Sipho D." — or the honest absence, which is worth saying on a wall. */
export function nextLine(next: ControlBoardBooking | null | undefined, timezone: string | undefined): string {
  if (!next?.starts_at) return "Nothing booked after this.";
  const at = clubClock(next.starts_at, timezone);
  const who = next.booked_by?.name ?? next.label ?? null;
  return who ? `Next ${at} · ${who}` : `Next ${at}`;
}

// ---------------------------------------------------------------------------------------
// Device link — the five states, in words
// ---------------------------------------------------------------------------------------

/**
 * `silent` is the state with no name on any screen today and the one an admin most wants:
 * past one heartbeat, short of the offline threshold. Derived on the server so the wall and
 * the Devices page cannot disagree.
 */
export const LINK_WORD: Record<DeviceLink, string> = {
  online: "online",
  silent: "quiet",
  offline: "not reporting",
  out_of_service: "out of service",
  unlinked: "no board",
};

/**
 * One health row: "Box 1-4 · online · heard 12s ago".
 *
 * `null` when there is no board at all to describe, so the strip renders nothing rather than
 * a row about a thing that does not exist.
 */
export function healthLine(
  device: ControlBoardDevice | null | undefined,
  now: number,
  label: string,
): string | null {
  if (!device) return null;
  const name = device.name ?? device.device_code ?? label;
  const link = device.link ? LINK_WORD[device.link] : null;
  const heard = device.last_seen_at ? `heard ${relative(device.last_seen_at, now)}` : "never heard from";
  return link ? `${name} · ${link} · ${heard}` : `${name} · ${heard}`;
}

/**
 * The same facts in parts, for a tile that folds them (R4 form factor, SPEC §3.11): at 18 boxes
 * on one court the sentence above was 30 lines on a phone and buried the court's state. The tile
 * says `summary` on one line and opens `follows`, the `others` as a list, and `advice` on request.
 */
export function duplicateBoxesParts(court: ControlBoardCourt, now: number): {
  summary: string; follows: string; others: string[]; advice: string;
} | null {
  const count = court.boxes_on_court ?? 0;
  if (count <= 1) return null;
  const main = court.device ?? null;
  const rest = court.other_boxes ?? [];
  const names = [main, ...rest].map((box) => box?.name ?? box?.device_code ?? null);
  const clash = (name: string | null) => name !== null && names.filter((n) => n === name).length > 1;
  const mainName = main ? boxLabel(main, clash(names[0])) : "one box";
  return {
    summary: `${count} boxes claim this court`,
    follows: `This tile follows ${mainName}, the one heard from most recently.`,
    others: rest.map((box, i) => `${boxLabel(box, clash(names[i + 1]))} — ${box.last_seen_at ? `heard ${relative(box.last_seen_at, now)}` : "never heard from"}`),
    advice: "Only one box should switch a court's lights — take the others out of service on Boards.",
  };
}

export const DUPLICATE_BOXES_REVIEW = "Review";
export const DUPLICATE_BOXES_HIDE = "Hide";
export const DUPLICATE_BOXES_OTHERS = "Also claiming it";
export const DUPLICATE_BOXES_BOARDS = "Open Boards";

/** A box's name, with its reported code (and MAC, when sent) where another box shares the name. */
function boxLabel(
  box: { name?: string | null; device_code?: string | null; mac_address?: string | null },
  clashes: boolean,
): string {
  const name = box.name ?? box.device_code ?? "an unnamed box";
  if (!clashes) return name;
  const ids = [
    box.device_code && box.device_code !== name ? box.device_code : null,
    box.mac_address ? `MAC ${box.mac_address}` : null,
  ].filter(Boolean);
  return ids.length > 0 ? `${name} (${ids.join(", ")})` : name;
}

// ---------------------------------------------------------------------------------------
// The board's own honesty, and how fresh it is
// ---------------------------------------------------------------------------------------

/**
 * The standing line under the wall. Never behind a tooltip, never collapsed.
 *
 * This is the sentence that stops the whole screen being a lie. It is one paragraph and it is
 * always on the page, because a club that puts this on a tablet will read it once and then
 * trust the tiles for a year.
 */
export const BOARD_STANDING_NOTICE
  = "What the club expects. The court boxes switch the lights themselves and do not report back "
  + "in real time, so this is what should be happening, from the bookings and the check-ins. "
  + "Each court shows its own box's link, and says when the box last confirmed anything.";

/**
 * Why there is no on/off control here, said once and in words.
 *
 * A greyed-out "Turn on lights" is a promise the product cannot keep, and this audience will
 * press it and then stand at a dark court. An absent control plus this sentence is honest; a
 * disabled one is not.
 */
export const BOARD_NO_REMOTE_CONTROL
  = "Lights cannot be switched off from here. A member identifying at the box turns a court on, and a box that lost"
  + " power or restarted puts paid courts back on by itself from the club's record — which never switches a court off."
  + " A court lit when nobody is playing is switched off with its OFF button at the box, or at the wall.";

/** How this page is getting its updates right now. Four states, and none of them inferred. */
export type FreshnessMode = "connecting" | "live" | "polling" | "lost";

/**
 * "Live — the club pushes changes as they happen." etc.
 *
 * <p>
 * D2 §8.8 is explicit that the UI must state which mode it is in and must never show a stale
 * number with no qualifier. Loading, live, degraded-to-polling and failed are four states and
 * this audience cannot be asked to infer any of them.
 * </p>
 */
export function freshnessLine(mode: FreshnessMode, pollSeconds: number, readAt: string | null): string {
  switch (mode) {
    case "connecting":
      return "Connecting to the club…";
    case "live":
      return readAt
        ? `Live · the club pushes changes as they happen. Last change ${readAt}.`
        : "Live · the club pushes changes as they happen.";
    case "polling":
      return readAt
        ? `Re-reading every ${pollSeconds} seconds · read at ${readAt}. The live connection dropped.`
        : `Re-reading every ${pollSeconds} seconds. The live connection dropped.`;
    case "lost":
      return readAt
        ? `Can't reach the club. What you can see was read at ${readAt}.`
        : "Can't reach the club, and nothing has been read yet.";
  }
}

/** What the failed-read band says above tiles that are being kept on screen on purpose. */
export function boardStaleBand(readAt: string | null): string {
  return readAt
    ? `Can't reach the club. What you can see below was read at ${readAt} and is not being updated.`
    : "Can't reach the club, and nothing has been read yet.";
}

/**
 * Boxes silent, the rest fine — named, so an admin knows which shelf to walk to.
 *
 * <p>
 * Counted in BOXES, not tiles (review round 4, A4-5): one box drives up to four courts, so one
 * silent box read "4 boxes haven't called in". Courts whose box is not known are each their own.
 * </p>
 */
export function partialBoardNotice(
  silent: ReadonlyArray<Pick<ControlBoardCourt, "name" | "court_id" | "device">>, readAt: string | null,
  timezone?: string,
): string | null {
  if (silent.length === 0) return null;
  // BA-09: "what we last knew" is when the BOXES last spoke, not when this page last read the
  // club — the read time moved forward every few seconds while the boxes had been silent for
  // half an hour. The oldest last-heard across the silent boxes is the honest figure.
  const heard = silent.map((c) => (c.device?.last_seen_at ? Date.parse(c.device.last_seen_at) : Number.NaN))
    .filter((t) => Number.isFinite(t));
  const lastHeard = heard.length === silent.length && heard.length > 0
    ? clubClock(new Date(Math.min(...heard)).toISOString(), timezone) : null;
  const boxes = new Set(silent.map((c) => c.device?.device_id ?? c.device?.device_code ?? `court:${c.court_id}`));
  const courts = silent.length === 1 ? "that court" : "those courts";
  const which = boxes.size > 1
    ? `${boxes.size} boxes haven't called in`
    : silent.length === 1 ? `${silent[0].name}'s box hasn't called in` : `The box for ${courtList(silent.map((c) => c.name))} hasn't called in`;
  if (lastHeard) return `${which}. What you see for ${courts} is what we last heard from ${boxes.size > 1 ? "them" : "it"} at ${lastHeard}.`;
  // When a box's last-heard time is not known, no time is given rather than the page's own.
  return readAt
    ? `${which}, so what you see for ${courts} may be out of date.`
    : `${which}, so nothing can be said about ${courts}.`;
}

function courtList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const BOARD_EMPTY_NOTICE = "This club has no courts set up yet, so there is nothing to watch.";
export const BOARD_EMPTY_HINT = "Add the club's courts under Courts, then this wall fills itself in.";

/** The wall-view switch, and the thing people ask about it straight afterwards. */
export const WALL_VIEW_LABEL = "Wall view";
export const WALL_VIEW_HINT
  = "Fills the screen with the courts, bigger, for a tablet on a wall: the menus and the explanations go until you switch"
  + " it off. Use your browser's own full screen as well to hide its address bar.";

/**
 * The countdown, as a screen reader hears it — once per state change, never per second.
 *
 * The digits themselves are `aria-hidden`; a live region that spoke them would say a number
 * every second for the length of a squash match.
 */
export function courtAnnouncement(name: string, state: CourtExpectation, minutesLeft: number | null): string {
  const word = EXPECTATION_WORD[state].toLowerCase();
  if (minutesLeft === null) return `${name}, ${word}.`;
  const minutes = minutesLeft === 1 ? "1 minute left" : `${minutesLeft} minutes left`;
  return `${name}, ${word}, ${minutes}.`;
}

/**
 * The fault resolve's note (R5 A5-5). The page promised that resolving "records what you did about
 * it", and the dialog had nowhere to say it: every resolve sent an empty note and the change record
 * carried no reason. The note is required — it is the whole of what resolving records.
 */
export const FAULT_RESOLVE_NOTE = {
  label: "What did you do?",
  help: "Kept with the fault and on the club's change record, so the next person knows what was tried.",
  placeholder: "Reseated the scanner cable, restarted the box…",
  missing: "Say what you did — it is kept with the fault and on the club's change record.",
} as const;
