import type { AdminDevice, DeviceDiag, DeviceMegaReport } from "./api";

/**
 * What a board reports about itself (device-api §13; HW-3, HW-6, ESPR-2), in plain words.
 *
 * <p>
 * After the last cable flash the club's only window into a board is its heartbeat. A crash, a
 * brown-out, a wedged screen or a heap running out must read here as what it is, or it shows up
 * as "the box is unreliable". Everything is presence-gated: a value the board did not send is
 * never shown as zero.
 * </p>
 *
 * <p>
 * The two floors are the contract's planning constants, not club settings: below them the server
 * raises a device notice, and this module marks the same values as needing attention.
 * </p>
 */

/** device-api §13: the largest free heap block and the stack low-water mark the boards are planned around. */
export const HEALTH_FLOORS = { block: 4096, stackMin: 512 } as const;

/** `diag.reset` — why this boot began — in words. */
export const RESET_WORDS: Readonly<Record<string, string>> = {
  power_on: "power came on",
  external: "its reset pin was pressed or pulled",
  software: "it restarted itself on purpose (an update, a change of network, or its own stall check)",
  exception: "it crashed",
  hw_wdt: "it froze and the hardware watchdog restarted it",
  soft_wdt: "it hung and the software watchdog restarted it",
  task_wdt: "a task hung and the watchdog restarted it",
  int_wdt: "it froze with interrupts off and the watchdog restarted it",
  panic: "it crashed",
  brownout: "the power dipped too low",
  deep_sleep: "it woke from sleep",
  unknown: "no reason was recorded",
};

/** A restart for any of these needs nobody's attention: power was applied, or the board chose to. */
const ORDINARY_RESETS = new Set(["power_on", "software"]);

export function resetWords(reset: string | null | undefined, diag?: DeviceDiag | null): string | null {
  if (!reset) return null;
  const words = RESET_WORDS[reset] ?? `it reported “${reset}”`;
  if (reset === "exception" && diag && typeof diag.exc === "number") {
    const where = typeof diag.epc1 === "number" ? ` at 0x${diag.epc1.toString(16).padStart(8, "0")}` : "";
    return `${words} (exception ${diag.exc}${where})`;
  }
  return words;
}

/** The Mega's `MCUSR`, bit by bit: bit0 power-on, bit1 external, bit2 brown-out, bit3 watchdog. */
export const MCUSR_BITS: readonly { bit: number; words: string }[] = [
  { bit: 0x01, words: "power came on" },
  { bit: 0x02, words: "its reset button was pressed or the bridge reset it" },
  { bit: 0x04, words: "the power dipped too low" },
  { bit: 0x08, words: "it froze and its watchdog restarted it" },
];

/** `MCUSR` as two hex digits, in words; null when it is not two hex digits. */
export function mcusrWords(hex: string | null | undefined): string | null {
  if (!hex || !/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
  const bits = Number.parseInt(hex, 16);
  const words = MCUSR_BITS.filter((b) => bits & b.bit).map((b) => b.words);
  return words.length === 0 ? "no cause was recorded" : words.join(", and ");
}

/** Does the Mega's last reset need attention (a brown-out or a watchdog)? */
export function megaResetNeedsAttention(hex: string | null | undefined): boolean {
  if (!hex || !/^[0-9A-Fa-f]{2}$/.test(hex)) return false;
  return (Number.parseInt(hex, 16) & 0x0c) !== 0;
}

/** The five `!DIAG` counters, in order (device-api §13). */
export const MEGA_DIAG_NAMES = ["lcd_errors", "lcd_reinits", "rx_overruns", "ceilings", "cap_offs"] as const;
export type MegaDiagName = (typeof MEGA_DIAG_NAMES)[number];

export const MEGA_DIAG_WORDS: Readonly<Record<MegaDiagName, (n: number) => string>> = {
  lcd_errors: (n) => `${n} screen bus error${n === 1 ? "" : "s"} (the screen did not answer)`,
  lcd_reinits: (n) => `${n} screen reset${n === 1 ? "" : "s"} (it refreshes itself every so often, and after an error)`,
  rx_overruns: (n) => `${n} lost byte${n === 1 ? "" : "s"} from the bridge`,
  ceilings: (n) => `${n} screen${n === 1 ? "" : "s"} sent back to the start because they lasted too long`,
  cap_offs: (n) => `${n} court${n === 1 ? "" : "s"} switched off by the safety limit on lights the box put back on`,
};

/** The counters as a record; absent when the board sent no `diag` array of five integers. */
export function megaDiag(mega: DeviceMegaReport | null | undefined): Record<MegaDiagName, number> | null {
  const raw = mega?.diag;
  if (!Array.isArray(raw) || raw.length < MEGA_DIAG_NAMES.length || !raw.slice(0, 5).every((n) => Number.isInteger(n) && n >= 0)) {
    return null;
  }
  return Object.fromEntries(MEGA_DIAG_NAMES.map((name, i) => [name, raw[i]])) as Record<MegaDiagName, number>;
}

/**
 * How much each counter rose since an earlier reading on this page. A counter that went DOWN means
 * the Mega restarted (they count since its boot), so the rise is the new value itself.
 */
export function diagRises(
  before: Record<MegaDiagName, number> | null, after: Record<MegaDiagName, number> | null,
): Partial<Record<MegaDiagName, number>> {
  if (!before || !after) return {};
  const out: Partial<Record<MegaDiagName, number>> = {};
  const restarted = MEGA_DIAG_NAMES.some((name) => after[name] < before[name]);
  for (const name of MEGA_DIAG_NAMES) {
    const rise = restarted ? after[name] : after[name] - before[name];
    if (rise > 0) out[name] = rise;
  }
  return out;
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;

export type HealthLine = { text: string; attention: boolean };

/** The board's own `diag`, line by line, each marked when it needs attention. */
export function diagLines(diag: DeviceDiag | null | undefined): HealthLine[] {
  if (!diag) return [];
  const lines: HealthLine[] = [];
  const reset = resetWords(diag.reset, diag);
  if (reset) lines.push({ text: `Last restart: ${reset}.`, attention: !!diag.reset && !ORDINARY_RESETS.has(diag.reset) });
  if (typeof diag.heap === "number") {
    const low = typeof diag.heap_min === "number" ? `, lowest ${kb(diag.heap_min)} since it started` : "";
    lines.push({ text: `Free memory ${kb(diag.heap)}${low}.`, attention: false });
  }
  if (typeof diag.block === "number") {
    lines.push({
      text: `Largest free block ${kb(diag.block)} (needs at least ${kb(HEALTH_FLOORS.block)}).`,
      attention: diag.block < HEALTH_FLOORS.block,
    });
  }
  if (typeof diag.stack_min === "number") {
    lines.push({
      text: `Stack headroom at its lowest: ${diag.stack_min} bytes (needs at least ${HEALTH_FLOORS.stackMin}).`,
      attention: diag.stack_min < HEALTH_FLOORS.stackMin,
    });
  }
  if (typeof diag.sketch_free === "number") lines.push({ text: `Room for an update: ${kb(diag.sketch_free)}.`, attention: diag.sketch_free === 0 });
  if (typeof diag.flash_mb === "number") lines.push({ text: `Flash: ${diag.flash_mb} MB.`, attention: false });
  return lines;
}

/** The Mega's own report: its last restart, and its counters with their rises since the page opened. */
export function megaLines(mega: DeviceMegaReport | null | undefined, rises: Partial<Record<MegaDiagName, number>>): HealthLine[] {
  if (!mega) return [];
  const lines: HealthLine[] = [];
  const reset = mcusrWords(mega.reset);
  if (reset) lines.push({ text: `The Mega last restarted because ${reset}.`, attention: megaResetNeedsAttention(mega.reset) });
  const counters = megaDiag(mega);
  if (counters) {
    for (const name of MEGA_DIAG_NAMES) {
      const rise = rises[name];
      if (counters[name] === 0 && !rise) continue;
      const risen = rise ? ` — ${rise} more since you opened this page` : "";
      lines.push({ text: `${MEGA_DIAG_WORDS[name](counters[name])} since the Mega started${risen}.`, attention: (rise ?? 0) > 0 && name !== "lcd_reinits" });
    }
  }
  return lines;
}

/** The *could not read part of the server's answer* notice (§11.2), naming the keys. */
export function driftLine(drift: readonly string[] | null | undefined): string | null {
  if (!drift || drift.length === 0) return null;
  return `It could not read part of the club's last answer: ${drift.join(", ")}. It keeps what it had for those`
    + " and carries on; tell whoever looks after the boards, because the club's system sent something this firmware does not understand.";
}

/** Whether anything about this board's health needs attention — for a badge beside its name. */
export function healthNeedsAttention(device: Pick<AdminDevice, "diag" | "mega" | "drift">): boolean {
  if (driftLine(device.drift)) return true;
  if (device.mega?.lcd === "00") return true;
  if (megaResetNeedsAttention(device.mega?.reset)) return true;
  return diagLines(device.diag).some((line) => line.attention);
}

/** Whether this API serves any v3 telemetry for the board at all. */
export function servesHealth(device: Pick<AdminDevice, "diag" | "mega" | "drift">): boolean {
  return device.diag !== undefined || device.mega !== undefined || device.drift !== undefined;
}
