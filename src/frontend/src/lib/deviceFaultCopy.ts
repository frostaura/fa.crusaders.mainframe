import type { DeviceErrorRow, DeviceErrorSeverity } from "./adminApi";

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
    means: "A board sent something the club's system could not read at all.",
    doThis: "Almost always a firmware that is out of step with the server. Note the board and tell whoever runs the system.",
  },
  clock_clamped: {
    means: "A board's clock was wrong, so the club's system used its own time for that event instead. The record is a few minutes out.",
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
export function explainFault(row: Pick<DeviceErrorRow, "code" | "headline" | "detail">): {
  title: string;
  means: string;
  doThis: string;
  /** True when nothing in the closed table matched — the page shows the raw code alongside. */
  unrecognised: boolean;
} {
  const known = EXPLANATIONS[row.code];
  const title = (row.headline ?? "").trim()
    || (known ? row.code.replace(/_/g, " ") : `An error the club's software does not have a name for (${row.code})`);
  if (known) return { title, means: known.means, doThis: known.doThis, unrecognised: false };
  return {
    title,
    means: (row.detail ?? "").trim()
      || "The club's software does not have a name for this one, and the board did not say more.",
    doThis: `Pass the code "${row.code}" to whoever looks after the boards. Nothing on this page can interpret it.`,
    unrecognised: true,
  };
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
