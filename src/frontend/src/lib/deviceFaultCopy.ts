import type { DeviceErrorRow, DeviceErrorSeverity } from "./adminApi";
import { minutesSpoken } from "./minutes";
import { clubClock, clubShortDate } from "./clubClock";

/**
 * What a fault MEANS, and what somebody should do about it — in words a volunteer can act on.
 *
 * <p>
 * <b>Built exactly like `lib/deviceErrors.ts`: a closed table with a fall-through, never a
 * guess.</b> The lesson this file is written against cost a real screen: the doors console
 * held its own dictionary of audit actions, the server's vocabulary moved, and a door with
 * thirteen admin edits rendered "13 refused scans". So the order of resolution here is
 * <b>the server's own `headline` first</b>, then this table, then the raw code — and an
 * unknown code renders something a person can read rather than nothing, because a feed that
 * silently drops rows is a feed an admin cannot reason about.
 * </p>
 *
 * <p>
 * <b>Severity is the server's, not the board's.</b> D2 §7.3: a board cannot be trusted to
 * grade its own faults, and a table where half the severities are the firmware's opinion is
 * not sortable. Nothing here re-grades anything; it only puts the server's grade into words.
 * </p>
 *
 * <p>
 * <b>`doThis` is written for somebody standing in a club at 19:00 holding a phone.</b> Not
 * "check the logs" and not "contact support" — a physical thing to walk to, and the sentence
 * that tells them whether it is worth walking.
 * </p>
 */

export type FaultExplanation = {
  /** What is broken, in terms of what a member at the club would notice. */
  means: string;
  /** The next physical action, and what it tells you if it does not work. */
  doThis: string;
};

/**
 * Severity, in words AND with an icon, never as a colour alone.
 *
 * The words are about CONSEQUENCE rather than about magnitude: "Stops people playing" is
 * something a volunteer can triage against at a glance; "Critical" is a number in a costume.
 */
export const SEVERITY_WORD: Record<DeviceErrorSeverity, string> = {
  critical: "Stops people playing",
  error: "Stops people playing",
  warning: "Works, but worse",
  info: "Worth knowing",
};

/** Tone per severity, from the token palette. `critical` and `error` share the danger tone. */
export const SEVERITY_TONE: Record<DeviceErrorSeverity, "danger" | "warning" | "info"> = {
  critical: "danger",
  error: "danger",
  warning: "warning",
  info: "info",
};

/**
 * The closed vocabulary, both halves of it — device-reported and server-detected (D2 §7.3).
 *
 * A code that is in the server's enum and missing here is a defect this file's own test
 * catches: `deviceFaultCopy.test.ts` walks the two lists and fails on any gap, so a firmware
 * release that adds a code fails a test here rather than going dark on the page.
 */
export const DEVICE_FAULT_CODES = [
  "scanner_timeout", "scanner_overrun", "bridge_desync", "lcd_fault", "relay_fault",
  "wifi_lost", "http_timeout", "json_parse", "watchdog_reset", "brownout", "roster_stale",
  "queue_full", "events_lost", "no_push", "unknown",
] as const;

export const SERVER_FAULT_CODES = [
  "auth_failed", "unregistered_mac", "malformed_body", "clock_clamped", "event_rejected",
  "seq_regression", "outage_opened", "court_not_mapped", "walkup_refused",
  "activation_refused", "too_many_unacknowledged_devices", "error_log_overflow",
] as const;

const EXPLANATIONS: Record<string, FaultExplanation> = {
  // --- what a board reports about itself ------------------------------------------------
  scanner_timeout: {
    means: "Nobody can scan a code at this box. Members can still use the keypad if they have a PIN.",
    doThis: "Check the scanner's cable where it joins the board, then switch the box off and on. If it comes back and goes again, the scanner itself is failing.",
  },
  scanner_overrun: {
    means: "The scanner sent more than the box could read, so some scans were dropped. A member may have scanned and seen nothing happen.",
    doThis: "Usually a burst at a busy time and it clears itself. If it keeps happening at quiet times, the scanner's cable is the first thing to reseat.",
  },
  bridge_desync: {
    means: "The two halves of the court box have lost track of each other. Buttons and the screen may not agree, and lights may not switch.",
    doThis: "Switch the box off at the plug, wait ten seconds and switch it back on. If it comes straight back, the board needs somebody who can open it.",
  },
  lcd_fault: {
    means: "The screen on the box is not being written to. Everything else still works, but a member gets no instructions at all.",
    doThis: "Power the box off and on. If the screen stays blank, put a printed card on the box until somebody can look at it.",
  },
  relay_fault: {
    means: "A relay did not do what it was told, so a court's lights may not have come on or gone off.",
    doThis: "Go and look at the court. If the lights are wrong, switch them at the wall and take the box out of service on Boards so the club is not alerted about a silence it created.",
  },
  wifi_lost: {
    means: "The box dropped off the club's WiFi. It goes on switching lights from the list it already has, and stops knowing about new bookings.",
    doThis: "Check the router and the box's distance from it. A box that is offline for hours will start refusing members who booked after it lost contact.",
  },
  http_timeout: {
    means: "The box reached the network but the club's system did not answer in time. Usually the internet, occasionally the server.",
    doThis: "Nothing at the box. If every board reports it at once, it is the club's connection or the server, not the hardware.",
  },
  json_parse: {
    means: "The box could not read what the club's system sent it. It will keep using what it had.",
    doThis: "Tell whoever runs the system: a board and the server have got out of step about what a message looks like, and that is a software fault, not a wiring one.",
  },
  watchdog_reset: {
    means: "The box restarted itself because it had stopped responding. Anything happening at that moment was interrupted.",
    doThis: "One on its own is normal. Several in a day means the board is unhappy — check its power supply first, because that is the commonest cause.",
  },
  brownout: {
    means: "The box's power dipped below what it needs. This is the commonest cause of a board that behaves strangely.",
    doThis: "Check the plug and the power supply, and whether anything big switches on nearby at the same time each day.",
  },
  roster_stale: {
    means: "The box is working from an old list of who may play. Somebody who booked recently may be refused at the court.",
    doThis: "Check the box is online. It refreshes its own list every few minutes once it can reach the club's system.",
  },
  queue_full: {
    means: "The box has more events waiting to upload than it can hold, so the oldest are being dropped. Some of tonight will be missing from the records.",
    doThis: "Get the box back online. Nothing at the box itself will help — it is waiting to talk to the club.",
  },
  events_lost: {
    means: "Events the box recorded have been thrown away because it could not upload them in time. Some scans and lights will not appear in the records.",
    doThis: "Get the box back online, then check the court's own history on Boards for the gap.",
  },
  no_push: {
    means: "The box is holding records it has not managed to send. Nothing is lost yet.",
    doThis: "Nothing, if the number stops growing. If it keeps growing, the box can hear the club but cannot talk to it.",
  },
  unknown: {
    means: "The board reported something the club's software does not have a name for.",
    doThis: "The board's own words are in the detail below. Pass them to whoever looks after the boards.",
  },

  // --- what the server notices about a board --------------------------------------------
  auth_failed: {
    means: "Something presented the wrong key to the club's system. If it is one of the club's own boards, that board has the old key.",
    doThis: "If a board was just reflashed, it has the wrong key — reflash it with the one on Boards. If nothing was touched, somebody is trying keys at the club's system.",
  },
  unregistered_mac: {
    means: "A board the club has never seen called in with the right key.",
    doThis: "If you have just plugged in a new board, this is it announcing itself and it will appear on Boards. If not, somebody has the club's key.",
  },
  malformed_body: {
    means: "A board sent a message the club's system could not read at all, so it was dropped. Whatever the board was saying did not reach the records.",
    doThis: "Almost always a firmware that is out of step with the server. Note the board and tell whoever runs the system.",
  },
  clock_clamped: {
    means: "A board gave an event a time that cannot be right — later than now, or more than 30 days ago — so the club's system recorded it when it arrived instead. If the board had been offline, it really happened earlier than its record shows.",
    doThis: "Normal after a power cut. If it keeps happening, that board is losing its clock and the times in its history cannot be trusted to the minute.",
  },
  event_rejected: {
    means: "The club's system refused something a board sent. That scan or that switch did not take effect.",
    doThis: "Look at what the board was trying to do, in the detail. A court that is not mapped to a relay is the usual reason.",
  },
  seq_regression: {
    means: "A board's counter went backwards, which happens when it restarts. Some records around that moment may be duplicated or missing.",
    doThis: "Nothing, if it happened once. Repeatedly means the board is restarting, and the reason for that is what to chase.",
  },
  outage_opened: {
    means: "A board stopped calling in for longer than the club allows. Nothing can be said about its courts while that lasts.",
    doThis: "Go and look at the board: power first, then network. Until it is back, its courts show as unknown on the control board.",
  },
  // BA-22: the same fault about a door says what a door does without the club.
  outage_opened_gate: {
    means: "A door stopped calling in for longer than the club allows. It goes on opening for the members on the list it last"
      + " had, and nobody new can be let in by it until it is back.",
    doThis: "Go and look at the door's board: power first, then network. Until it is back, Doors shows it as not reporting.",
  },
  court_not_mapped: {
    means: "A box switched a relay that has no court against it, so the club's system cannot tell which court it was.",
    doThis: "Open this board on Boards and set which court sits on each relay, in relay order.",
  },
  walkup_refused: {
    means: "Somebody tried to buy court time at the box and was refused.",
    doThis: "Usually the member's balance or the club's own rules, and the box will have told them. Look at the member's night if they say otherwise.",
  },
  activation_refused: {
    means: "Somebody identified at a box and the lights were not switched on for them.",
    doThis: "This is the commonest thing a member complains about. Open A person's night for them to see which rule refused it.",
  },
  too_many_unacknowledged_devices: {
    means: "More boards have registered themselves than the club has looked at. New boards are being turned away until somebody checks.",
    doThis: "Open Boards and either name the boards that are meant to be there, or delete the ones that are not.",
  },
  // --- the court box's critical codes (review round 1, F3.7: shown raw before) -----------
  restore_not_confirmed: {
    means: "After a power cut a court should have come back on, and the box has not said that it did. Somebody may be playing in the dark.",
    doThis: "Go and look at the court. If its lights are off, switch them at the wall, then power the box off and on so it re-reads what should be lit.",
  },
  restore_failed: {
    means: "After a power cut the box tried to switch a court's lights back on and could not.",
    doThis: "Switch the court's lights at the wall for the players on it, then power the box off and on. If it happens again, the relay needs looking at.",
  },
  relay_cmd_dropped: {
    means: "The box was told to switch a court's lights and the command never reached the relay.",
    doThis: "Look at the court. If the lights are wrong, switch them at the wall and power the box off and on.",
  },
  mega_link_lost: {
    means: "The two halves of the court box stopped talking. Its buttons, screen and relays may not respond.",
    doThis: "Switch the box off at the plug, wait ten seconds and switch it back on. If it comes straight back, the board needs somebody who can open it.",
  },
  // --- device contract v3 (device-api §4, §13; device-serial-protocol v3; door-gate §14) ------
  boot: {
    means: "The board started up — after a power cut, a reset, a firmware update or a restart it chose itself. Whatever it"
      + " was doing at that moment was interrupted, and a court box puts paid courts back on from the club's record.",
    doThis: "Nothing, if it happened once and the board came back. Several in a day: check its Health on Boards for why it"
      + " restarted — a power dip or a freeze points at the power supply first.",
  },
  mega_unacked: {
    means: "The court box's bridge sent the controller a command three times and never heard it was taken. If it was a"
      + " lights command, the box showed TRY AGAIN and the court may not have switched.",
    doThis: "Look at the court. If its lights are wrong, the member can scan again; if it keeps happening, power the box off"
      + " and on, and check the cable between the two boards inside it.",
  },
  relight_failed: {
    means: "The club's record says a paid court should be lit, and the box tried three times to switch it back on and could not.",
    doThis: "Go and look at the court. Switch its lights at the wall for the players on it, then check the box's Hardware on"
      + " Boards — a wrong relay drive level keeps every court dark.",
  },
  kind_mismatch: {
    means: "A door gate was answered as if it were a court box, so it kept the list it already had and did not take the new one.",
    doThis: "Open Boards and check this board is listed as a door. If two boards share one network address, give each its own.",
  },
  screen_dropped: {
    means: "The court box's screen fell behind and skipped a screen to keep up. A member may have missed a message; the"
      + " lights were never affected — they always go first.",
    doThis: "Nothing, if it is rare. If it keeps rising, the link inside the box is slow — power it off and on.",
  },
  error_log_overflow: {
    means: "This board is producing faults faster than the club's system will record them, so most of them are being counted rather than kept.",
    doThis: "A board in this state is in real trouble. The count below is how many were suppressed — go and look at the board itself.",
  },
};

/**
 * What to say about this fault, in three tries.
 *
 * <p>
 * The server's own `headline` is the TITLE and wins over anything here, for the reason in the
 * header. {@link FaultExplanation} is the body. An unrecognised code still gets both halves:
 * a neutral sentence naming the raw code, never a guessed one, and never `undefined`.
 * </p>
 */
/** `uptime_ms=<n>` (the boot fault's detail) as "after 3 h 12 min", or null. */
function bootUptime(detail: string | null | undefined): string | null {
  const said = (detail ?? "").trim();
  const ms = said.startsWith("uptime_ms=") ? said.slice("uptime_ms=".length) : "";
  if (ms === "" || !Number.isInteger(Number(ms))) return null;
  const minutes = Math.floor(Number(ms) / 60_000);
  if (minutes < 1) return "It reported starting from zero, so it had only just come on.";
  // Spoken words, never "3 h 12 min" (X6-2): a sentence is read whole by a screen reader.
  return `It had been running for ${minutesSpoken(minutes)} when it said so.`;
}

/** BA-22: a restart says what it means, with its raw uptime turned into a sentence. */
function bootExplanation(row: Pick<DeviceErrorRow, "headline" | "detail">) {
  const known = EXPLANATIONS.boot;
  const uptime = bootUptime(row.detail);
  return {
    title: (row.headline ?? "").trim() || "The board restarted",
    means: uptime ? `${known.means} ${uptime}` : known.means,
    doThis: known.doThis,
    unrecognised: false,
  };
}

/** The table's entry for a code — a door's "stopped reporting" talks about doors (BA-22). */
function explanationFor(row: { code: string; device_kind?: string | null }): FaultExplanation | undefined {
  if (row.code === "outage_opened" && row.device_kind === "Gate") return EXPLANATIONS.outage_opened_gate;
  return EXPLANATIONS[row.code];
}

export function explainFault(
  row: Pick<DeviceErrorRow, "code" | "headline" | "detail"> & { device_kind?: string | null }, timezone?: string,
): {
  title: string;
  means: string;
  doThis: string;
  /** True when nothing in the closed table matched — the page shows the raw code alongside. */
  unrecognised: boolean;
} {
  if (row.code === "malformed_body") {
    const said = bodyFaultOf(row.detail);
    const kind = said ? READ_ANYWAY[said.kind] : undefined;
    if (said && kind) {
      // The server's headline follows the detail (`DeviceErrorCodes.HeadlineOf(code, detail)`), so it
      // is the title — except on a row filed before it did, whose headline is the dropped one; on a
      // two-boards row, whose headline is the dropped one too ("could not read" a message it read);
      // and on a row carrying the R19 board list, which the server's variant match does not see past.
      const ownTitle = said.legacy || said.kind === "twoBoards" || said.boards.length > 0;
      const headline = ownTitle ? "" : (row.headline ?? "").trim();
      return { title: headline || kind.title, means: kind.means, doThis: kind.doThis, unrecognised: false };
    }
  }
  if (row.code === "boot") return bootExplanation(row);
  const known = explanationFor(row);
  const headline = (row.headline ?? "").trim();
  const title = headline
    || (known ? row.code.replace(/_/g, " ") : `An error the club's software does not have a name for (${row.code})`);
  if (known) return { title, means: known.means, doThis: known.doThis, unrecognised: false };
  return {
    title,
    means: faultDetail(row.detail, timezone)
      || "The club's software does not have a name for this one, and the board did not say more.",
    doThis: `Pass the code "${row.code}" to whoever looks after the boards. Nothing on this page can interpret it.`,
    unrecognised: true,
  };
}

/**
 * R16 D16-5 — `malformed_body` is filed for three different things, and the server's detail says
 * which, as "<route>: <detail>" (`DeviceFaultSink.MalformedBody`). The details below are the
 * server's constants verbatim — `DeviceBody.ReplacedDetail`, `DeviceBody.NotJsonDetail`,
 * `DeviceEndpoints.VersionTooLongDetail` — and `deviceFaultCopy.r16.test.ts` holds a copy of each:
 *
 * - some characters replaced: read leniently and ACTED ON;
 * - a heartbeat version too long to keep: not kept, the rest of the check-in used;
 * - not readable at all, or far too large: DROPPED.
 *
 * Since BE16a the server's headline is variant-aware, so this file no longer overrides the title for
 * a read-anyway row; it supplies the body (`means`/`doThis`), and a title only for a row with no
 * headline or one filed before the server's plain words (`legacy`), whose headline is the dropped one.
 */
type BodyFaultKind = "replaced" | "version" | "dropped" | "twoBoards";

const REPLACED_DETAIL = "some characters could not be read and were replaced; the rest was read and used";
const NOT_JSON_DETAIL = "the message could not be read at all, so nothing in it was used";
const VERSION_DETAIL = "it reported a version longer than 32 characters, which was not kept";
/** `DeviceBody.TwoBoardsDetail` (R18 D18-5): refused whole, so a flood cannot be charged to one board while acting as another. */
const TWO_BOARDS_DETAIL = "the message named more than one board, so nothing in it was used";
/**
 * R19 D19-4 — `DeviceBody.FileAsync` adds " (boards named: <mac>, <mac>)" when a body named more
 * than one board, and files it against neither (the club's folded row). Normalised MACs, at most four.
 */
const BOARDS_NAMED = /^(.+) \(boards named: ([0-9a-f]{12}(?:, [0-9a-f]{12})*)\)$/;

/** What became of the message, by the server's detail: its kind and the words for it. */
const BODY_FAULT: Record<string, { kind: BodyFaultKind; how: string; legacy?: true }> = {
  [REPLACED_DETAIL]: { kind: "replaced", how: "some characters in it could not be read and were replaced; the rest was read and used" },
  [VERSION_DETAIL]: { kind: "version", how: "it reported a version too long to keep, so the board's record keeps the one it had" },
  [NOT_JSON_DETAIL]: { kind: "dropped", how: "it could not be read at all, so nothing in it was used" },
  [TWO_BOARDS_DETAIL]: { kind: "twoBoards", how: "it named more than one board, so nothing in it was used" },
  "body too large": { kind: "dropped", how: "it was far too large to be a board's message, so it could not be read" },
  // Filed before the server's details were words (d151a964); such rows stay in the history.
  "invalid UTF-8 read as U+FFFD": { kind: "replaced", how: "some characters in it could not be read and were replaced; the rest was read and used", legacy: true },
  "body is not JSON": { kind: "dropped", how: "it could not be read at all, so nothing in it was used" },
  malformed: { kind: "dropped", how: "it could not be read" },
};

/** What `bodyFaultOf` reads out of a detail. */
type BodyFault = { route: string; kind: BodyFaultKind; how: string; legacy: boolean; boards: string[] };

/** "activate: <detail>[ (boards named: …)]" → the route, what became of the message and the boards it named; null for any other detail. */
function bodyFaultOf(detail: string | null | undefined): BodyFault | null {
  const parts = /^([a-z-]+): (.+)$/.exec((detail ?? "").trim());
  if (!parts) return null;
  const listed = BOARDS_NAMED.exec(parts[2]);
  const known = BODY_FAULT[listed ? listed[1] : parts[2]];
  if (!known) return null;
  const boards = listed ? listed[2].split(", ") : [];
  return { route: parts[1], kind: known.kind, how: known.how, legacy: known.legacy === true, boards };
}

/** "a", "a and b", "a, b and c". */
function listOf(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The kinds with words of their own: the two whose message WAS used, and one refused for naming two
 * boards (R19 — read perfectly well, so "could not read" is false). A dropped one is the closed
 * table's `malformed_body`.
 */
const READ_ANYWAY: Partial<Record<BodyFaultKind, { title: string; means: string; doThis: string }>> = {
  twoBoards: {
    title: "A message named more than one board, so nothing in it was used",
    means: "A message reached the club's system naming more than one board. It cannot tell which board sent it, so nothing in it was used — a scan in it lit no court and opened no door — and it is filed against no board.",
    doThis: "One board's software is mixing up whose message it is sending. Note the boards in the detail and tell whoever looks after the boards; if it keeps happening, check what sits on the network between them and the club.",
  },
  replaced: {
    title: "A board sent a few unreadable characters, and the rest was used",
    means: "A board sent a message with a few characters the club's system could not read. It read the rest and acted on it — a scan that came through garbled is refused at the court as a code nobody holds.",
    doThis: "Nothing, if it happened once. If it keeps happening, that board or its scanner cable is sending bad characters — note the board and tell whoever runs the system.",
  },
  version: {
    title: "A board reported a version too long to keep",
    means: "A board's check-in named a software version too long for the club's records, so its record kept the one it had. The rest of the check-in was used and the board carries on as normal.",
    doThis: "Nothing at the court. The version shown for this board on Boards may be out of date — tell whoever looks after the boards, because its software is reporting itself wrongly.",
  },
};

/** What the board was sending, by the route it sent it to (the last part of `/api/v1/device/…`). */
const DEVICE_ROUTE: Record<string, string> = {
  activate: "a scan asking for the lights",
  events: "its upload of scans and switches",
  "pay-for": "a pay-for at the box",
  walkup: "a walk-up at the box",
  heartbeat: "its regular check-in",
  gate: "a scan at a door",
};

/** "activate: <detail>" → "What the board was sending: a scan asking for the lights — it could not be read at all, …." */
function bodyFaultLine(text: string): string | null {
  const said = bodyFaultOf(text);
  if (!said) return null;
  const line = `What the board was sending: ${DEVICE_ROUTE[said.route] ?? "a message"} — ${said.how}.`;
  if (said.boards.length === 0) return line;
  // R19 D19-4 — filed on the club's row, not a board's: say which boards, and why on neither.
  const lead = said.kind === "twoBoards" ? "The boards it named" : "It named more than one board";
  return `${line} ${lead}: ${listOf(said.boards)} — so it is filed against ${said.boards.length === 2 ? "neither" : "none of them"}.`;
}

// ---------------------------------------------------------------------------------------
// The page's own sentences
// ---------------------------------------------------------------------------------------

export const FAULTS_READ_FAILED
  = "Couldn't read the fault list. That does not mean there are none — nothing on this page is "
  + "a claim about the club's boards while that is true.";

/** The GOOD empty, and it says what it is an absence OF. */
export function faultsEmptyNotice(boards: number | null, days: number | null): string {
  const window = days === null ? "recently" : `in the last ${days} days`;
  if (boards === null) return `No faults ${window}.`;
  const which = boards === 1 ? "The club's one board has" : `All ${boards} of the club's boards have`;
  return `No faults ${window}. ${which} called in.`;
}

/**
 * Resolving does not fix anything, and the page has to say so before somebody presses it.
 *
 * <p>
 * D3 designed an Acknowledge / Mark resolved pair, where acknowledge silenced a badge for two
 * hours and resolve was only offered once the board had been heard from without the fault.
 * <b>D2's wire has neither</b> — one `resolve` with a note, and no server-side guard on
 * resolving a fault that is still happening. Rather than invent an endpoint, the page is
 * honest about the one verb it has: resolving is a note somebody writes, not a repair, and a
 * fault that recurs opens a fresh row with a truthful first-seen time.
 * </p>
 */
export const RESOLVE_MEANING
  = "Marking a fault resolved records what you did about it and takes it off this list. It does "
  + "not stop the fault: if the board reports it again, it comes back as a new one.";

export function resolveConfirm(count: number): string {
  return count === 1
    ? "Mark it resolved? It comes back if the board reports it again."
    : `Mark all ${count} resolved? Any that are still happening come back.`;
}

/** "47 times · first 20 Sept, 18:02 · last 4 minutes ago" — the three numbers that separate
 *  "it happened once at 3 a.m." from "it is happening now". */
export function occurrenceLine(count: number, first: string, last: string): string {
  const times = count === 1 ? "Once" : `${count} times`;
  return `${times} · first ${first} · last ${last}`;
}

/** What a resolved row says, so the history is readable rather than merely filtered out. */
export function resolvedLine(by: string | null, at: string, note: string | null): string {
  const who = by ? `Marked resolved by ${by} at ${at}.` : `Marked resolved at ${at}.`;
  return note && note.trim() ? `${who} "${note.trim()}"` : who;
}

/** Some boards unreachable: the list is incomplete and says which way. */
export function faultsPartialNotice(reported: number, total: number, silent: string[]): string | null {
  if (silent.length === 0) return null;
  const which = silent.length === 1 ? silent[0] : `${silent.length} boards`;
  return `${reported} of ${total} boards reported. ${which} hasn't called in, so anything wrong with it isn't here.`;
}

/**
 * A board's name as a heading: its CODE as well as its name (F3.7). Every court box is called
 * "Court box" out of the factory, so a page of faults headed by name alone was a page of
 * identical headings.
 */
export function boardLabel(row: Pick<DeviceErrorRow, "device_code" | "device_name">): string {
  const name = (row.device_name ?? "").trim();
  const code = (row.device_code ?? "").trim();
  if (name && code && name !== code) return `${name} (${code})`;
  return name || code || "Unnamed board";
}

/**
 * R6 L6-15 — the reason a refused scan or walk-up carries is a bare code the server wrote
 * (`DeviceActivateEndpoint`, `WalkUpRefusalOf`); the card said "out_of_hours". Each in words.
 */
const REFUSAL_REASON: Record<string, string> = {
  out_of_hours: "The club was closed at that time.",
  insufficient_balance: "The member didn't have enough minutes.",
  no_time_available: "The court had no time left to sell before the next booking.",
  court_in_use: "The court was already booked.",
  walk_up_refused: "The club's rules didn't allow a walk-up then.",
  no_booking: "The member had no booking on that court then.",
  too_early: "The member scanned before their booking started.",
  ended: "The member's booking had already ended.",
  not_chargeable: "That booking couldn't be charged, so the lights stayed off.",
};

const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/g;

/** The year of an instant in the club's own calendar. */
function clubYear(at: string | number, timezone: string | undefined): string {
  return clubShortDate(at, timezone, { weekday: false, year: true }).split(" ").pop() ?? "";
}

/**
 * R17 D17-3 — "Tue 6 Oct, 12:10", and "Sun 5 Mar 2028, 12:00" when the year is not this one: a fault
 * detail can carry a board's wrong idea of the date, and a date with no year read as this year's.
 */
function faultInstant(iso: string, timezone: string | undefined): string {
  const year = clubYear(iso, timezone) !== clubYear(Date.now(), timezone);
  return `${clubShortDate(iso, timezone, { year })}, ${clubClock(iso, timezone)}`;
}

/**
 * R17 D17-3 — a `clock_clamped` detail. The server writes `claimed <instant>`, or for a claim past what
 * the calendar holds `DeviceTime.BeyondStorableDetail` / `BeforeStorableDetail`; a row filed before it
 * did carries the saturated instant itself (`9999-12-31T23:59:59.9999999+00:00`, which the club's zone
 * pushed into year 10000 and printed as "Sat 1 Jan, 01:59"). Null for any other detail.
 */
const SATURATED_CLAIM: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:a time beyond what can be stored|9999-12-31T23:59:59)/, "a time beyond what can be stored"],
  [/^(?:a time too long ago to be stored|0001-01-01T00:00:00)/, "a time too long ago to be stored"],
];

function claimedLine(text: string, timezone: string | undefined): string | null {
  const claimed = /^claimed (.+)$/.exec(text)?.[1];
  if (!claimed) return null;
  const saturated = SATURATED_CLAIM.find(([shape]) => shape.test(claimed))?.[1];
  const instant = /^\d{4}-\d{2}-\d{2}T/.test(claimed) && !Number.isNaN(Date.parse(claimed));
  const when = saturated ?? (instant ? faultInstant(claimed, timezone) : null);
  return when ? `The board gave it ${when}, so it was recorded at the time it arrived instead.` : null;
}

/**
 * A fault's detail in words (F3.7): "served 4 relay(s), the box reported 0" said as a sentence,
 * and any UTC instant the server wrote into it shown in the club's own time.
 */
export function faultDetail(detail: string | null | undefined, timezone: string | undefined): string {
  const text = (detail ?? "").trim();
  const reason = REFUSAL_REASON[text];
  if (reason) return reason;
  const body = bodyFaultLine(text) ?? claimedLine(text, timezone);
  if (body) return body;
  // An unknown bare code still reads as words rather than as an identifier.
  if (/^[a-z]+(?:_[a-z]+)+$/.test(text)) return `Reason given: ${text.replace(/_/g, " ")}.`;
  const relays = /^served (\d+) relay\(s\), the box reported (\d+)$/.exec(text);
  if (relays) {
    const served = Number(relays[1]);
    const reported = Number(relays[2]);
    const courts = served === 1 ? "1 court" : `${served} courts`;
    return `The club's system expected ${courts} to be lit; the box reported ${reported === 0 ? "none" : reported}.`;
  }
  return text
    .replace(ISO_INSTANT, (iso) => faultInstant(iso, timezone))
    .replace(/\b(\d+) relay\(s\)/g, (_m, n: string) => (n === "1" ? "1 relay" : `${n} relays`));
}
