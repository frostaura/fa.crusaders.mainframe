import type { AdminDevice, AdminSettings } from "./api";
import { servedBound, servedValues } from "./ecoSettings";

/**
 * The five hardware facts the Mega once had compiled in (device-api §5, §12; HW-1, HW-2, HW-5),
 * as a court box's per-board overrides beside what the Mega says it is actually running with.
 *
 * <p>
 * <b>Values and bounds are the API's.</b> Each key's enumeration or range comes from the settings
 * GET's `bounds`; this module only names them. A per-board value is three-valued like the button
 * map: absent leaves it, null is the club's, a value is the board's own.
 * </p>
 */

export const HW_KEYS = [
  "hw_relay_active_level", "hw_lcd_i2c_address", "hw_scanner_baud", "hw_scanner_line_end", "hw_scanner_gap_ms",
] as const;
export type HwKey = (typeof HW_KEYS)[number];

/** Which keys carry numbers on the wire (their served `values` may arrive as strings or numbers). */
export const HW_NUMERIC: ReadonlySet<HwKey> = new Set(["hw_lcd_i2c_address", "hw_scanner_baud", "hw_scanner_gap_ms"]);

export const HW_LABELS: Readonly<Record<HwKey, string>> = {
  hw_relay_active_level: "Relay drive level",
  hw_lcd_i2c_address: "Screen (LCD) address",
  hw_scanner_baud: "Scanner speed",
  hw_scanner_line_end: "Scanner line end",
  hw_scanner_gap_ms: "Scanner end-of-code gap (ms)",
};

export const HW_DESCRIPTIONS: Readonly<Record<HwKey, string>> = {
  hw_relay_active_level: "Which level switches a court on. Wrong, and courts stay dark when lit — a released relay never lights one.",
  hw_lcd_i2c_address: "Which address the screen's backpack answers on. Searching finds it; set it only if searching cannot.",
  hw_scanner_baud: "How fast the QR scanner talks. Auto finds it while the box is idle.",
  hw_scanner_line_end: "How a scanned code ends: auto accepts CR, LF or a pause; CR/LF waits for the scanner's own end.",
  hw_scanner_gap_ms: "With auto, a pause this long ends a scanned code.",
};

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, "0")}`;

const LEVEL_WORDS: Readonly<Record<string, string>> = { low: "low (active-low module)", high: "high (active-high module)" };
const LINE_END_WORDS: Readonly<Record<string, string>> = { crlf: "CR/LF only", auto: "auto (CR, LF or a pause)" };

/** Each key's value in words; anything a formatter does not know reads as itself. */
const HW_WORDS: Readonly<Record<HwKey, (value: string | number) => string>> = {
  hw_relay_active_level: (v) => LEVEL_WORDS[String(v)] ?? String(v),
  hw_lcd_i2c_address: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) return String(v);
    return n === 0 ? "search for it" : hex(n);
  },
  hw_scanner_baud: (v) => (Number(v) === 0 ? "auto-detect" : `${v} baud`),
  hw_scanner_line_end: (v) => LINE_END_WORDS[String(v)] ?? String(v),
  hw_scanner_gap_ms: (v) => `${v} ms`,
};

/** One value, in words. */
export function hwValueWords(key: HwKey, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "not set";
  return HW_WORDS[key](value);
}

/** The values the API offers for an enumerated key, as strings for a select; null when it serves none. */
export function hwChoices(settings: AdminSettings | null, key: HwKey): string[] | null {
  if (!settings) return null;
  const held = settings as unknown as Record<string, unknown>;
  const values = servedValues(held, key);
  return values ? [...values] : null;
}

/** The served range of a numeric key (the gap), or null. */
export function hwRange(settings: AdminSettings | null, key: HwKey): { min: number; max: number } | null {
  return settings ? servedBound(settings as unknown as Record<string, unknown>, key) : null;
}

/** The club's value of a key, as the settings GET serves it. */
export function hwClubValue(settings: AdminSettings | null, key: HwKey): string | number | undefined {
  const v = settings ? (settings as unknown as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" || typeof v === "number" ? v : undefined;
}

/** What the board runs with for this key: its own value, else the club's. */
export function hwEffective(device: AdminDevice, settings: AdminSettings | null, key: HwKey): string | number | undefined {
  const own = device[key];
  return own === null || own === undefined ? hwClubValue(settings, key) : own;
}

/** What the Mega reports it is running with, per key (`mega` in the heartbeat, from `!HW`). */
const HW_REPORTED: Readonly<Record<HwKey, (mega: NonNullable<AdminDevice["mega"]>) => string | null>> = {
  hw_relay_active_level: (m) => (m.relay ? hwValueWords("hw_relay_active_level", m.relay) : null),
  hw_lcd_i2c_address: (m) => {
    if (!m.lcd) return null;
    return m.lcd === "00" ? "no screen answered" : `0x${m.lcd.toUpperCase()}`;
  },
  hw_scanner_baud: (m) => {
    if (typeof m.scan_baud !== "number") return null;
    return m.scan_baud === 0 ? "still detecting" : `${m.scan_baud} baud`;
  },
  hw_scanner_line_end: (m) => (m.scan_end ? hwValueWords("hw_scanner_line_end", m.scan_end) : null),
  // The gap is not in `!HW`: the Mega applies it and reports nothing back about it.
  hw_scanner_gap_ms: () => null,
};

export function hwReported(device: AdminDevice, key: HwKey): string | null {
  return device.mega ? HW_REPORTED[key](device.mega) : null;
}

/** Does this board's reported hardware need attention? `00` — no screen answered — always does (HW-2). */
export function noLcdAnswered(device: Pick<AdminDevice, "mega">): boolean {
  return device.mega?.lcd === "00";
}

/** Whether this API serves the hardware overrides for this board at all. */
export function servesHardware(device: AdminDevice): boolean {
  return device.kind !== "Gate" && HW_KEYS.some((key) => device[key] !== undefined);
}

/**
 * The commissioning procedure (`lights-controller.md`, *Commissioning the hardware facts*) as a
 * checklist an admin walks at the box. Each step is a person looking at something; the panel shows
 * what the box says beside the setting it governs.
 */
export const COMMISSIONING_STEPS: readonly { title: string; detail: string }[] = [
  {
    title: "Record the relay module before power is applied",
    detail: "Photograph its markings: part number, trigger level, rating, triac (AC) or MOSFET (DC), and whether it switches"
      + " a contactor coil or the lights themselves. A triac module cannot switch a DC coil off — if that is fitted, stop and"
      + " call an electrician.",
  },
  {
    title: "Prove that off is off",
    detail: "Box powered, nothing booked: every court must be dark. Power-cycle the box twice and watch the courts as it"
      + " starts — none may flash. A court lit now is a wiring or module fault: stop.",
  },
  {
    title: "Find the relay drive level",
    detail: "Light court A with a test walk-up. Lit: the level is right. Dark while the screen says it is on: set this"
      + " board's Relay drive level to low, wait one heartbeat, and court A lights. Switch it off and confirm dark. Repeat for"
      + " B, C and D; a crossed channel is fixed with the court map, never a wire.",
  },
  {
    title: "Check the screen",
    detail: "Screen address shows the backpack that answered (none answered: check the four wires and the contrast screw"
      + " first). Two rows of sixteen is compact, four of twenty is expanded — set the club's layout to match.",
  },
  {
    title: "Check the scanner",
    detail: "Scan a member code. Scanner shows the speed it locked on and how lines end. Nothing arrives: set the speed to"
      + " 9600, then 115200, before suspecting the scanner.",
  },
  {
    title: "Check the buttons",
    detail: "Press each of the eight without scanning and note what the screen names; if the order is not the assumed one,"
      + " set this board's button map to what you saw.",
  },
  {
    title: "Write down what you found",
    detail: "Part numbers, the level, the address, the panel size, the scanner model and its line end, the button order —"
      + " in the go-live checklist, so nobody re-derives them.",
  },
];

/** What changing the relay drive level does to a lit court — said before it is saved. */
export const RELAY_LEVEL_CONFIRM = "Within one heartbeat the box re-drives every court it has lit at the new level. If the"
  + " lights were working, the courts that are lit now go dark until you set it back; if they were dark while the screen said"
  + " on, they light. A court that is off stays off either way: a released relay never lights one.";
