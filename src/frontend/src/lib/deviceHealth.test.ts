import { describe, expect, it } from "vitest";
import type { AdminDevice } from "./api";
import {
  HEALTH_FLOORS, MCUSR_BITS, RESET_WORDS, diagLines, diagRises, driftLine, healthNeedsAttention, mcusrWords, megaDiag,
  megaLines, megaResetNeedsAttention, resetWords, servesHealth,
} from "./deviceHealth";

/**
 * A board's own health (device-api §13; HW-3, HW-6, ESPR-2). Every reset reason and every MCUSR
 * bit has words; the planning floors mark a value as needing attention exactly at the floor; a
 * value the board did not send is never shown as zero.
 */

const ALL_RESETS = [
  "power_on", "external", "software", "exception", "hw_wdt", "soft_wdt", "task_wdt", "int_wdt", "panic", "brownout",
  "deep_sleep", "unknown",
] as const;

describe("diag.reset in words", () => {
  it.each(ALL_RESETS.map((r) => [r] as const))("%s has its own words", (reset) => {
    expect(RESET_WORDS[reset]).toBeTruthy();
    expect(resetWords(reset)).toBe(RESET_WORDS[reset]);
  });

  it("names the exception and where it happened after a crash", () => {
    expect(resetWords("exception", { exc: 28, epc1: 0x40201234 })).toBe("it crashed (exception 28 at 0x40201234)");
    // Without the cause the words are still the crash, never a made-up number.
    expect(resetWords("exception", {})).toBe("it crashed");
  });

  it("says an unknown reason as the board sent it, and nothing for an absent one", () => {
    expect(resetWords("rtc_wdt")).toBe("it reported “rtc_wdt”");
    expect(resetWords(null)).toBeNull();
  });

  it.each([
    ["power_on", false], ["software", false], ["external", true], ["exception", true], ["hw_wdt", true], ["brownout", true],
  ] as const)("a %s restart needs attention: %s", (reset, attention) => {
    expect(diagLines({ reset })[0]).toEqual({ text: expect.stringMatching(/^Last restart: /), attention });
  });
});

describe("the Mega's MCUSR", () => {
  it.each(MCUSR_BITS.map((b) => [b.bit, b.words] as const))("bit 0x%s alone reads as its own words", (bit, words) => {
    expect(mcusrWords(bit.toString(16).padStart(2, "0").toUpperCase())).toBe(words);
  });

  it("joins several bits, and says when none is set", () => {
    expect(mcusrWords("0C")).toBe("the power dipped too low, and it froze and its watchdog restarted it");
    expect(mcusrWords("00")).toBe("no cause was recorded");
  });

  it("refuses anything that is not two hex digits", () => {
    for (const bad of ["", "1", "0x01", "GG", "001", null, undefined]) expect(mcusrWords(bad)).toBeNull();
  });

  it("marks a brown-out or a watchdog, never a power-on or the button", () => {
    expect(megaResetNeedsAttention("01")).toBe(false);
    expect(megaResetNeedsAttention("02")).toBe(false);
    expect(megaResetNeedsAttention("04")).toBe(true);
    expect(megaResetNeedsAttention("08")).toBe(true);
    expect(megaResetNeedsAttention("09")).toBe(true);
  });
});

describe("the planning floors", () => {
  it("marks the largest block below the floor, and not at it", () => {
    expect(diagLines({ block: HEALTH_FLOORS.block - 1 })[0].attention).toBe(true);
    expect(diagLines({ block: HEALTH_FLOORS.block })[0].attention).toBe(false);
  });

  it("marks the stack low-water mark below the floor, and not at it", () => {
    expect(diagLines({ stack_min: HEALTH_FLOORS.stackMin - 1 })[0].attention).toBe(true);
    expect(diagLines({ stack_min: HEALTH_FLOORS.stackMin })[0].attention).toBe(false);
  });

  it("shows only what was sent", () => {
    expect(diagLines({ heap: 20480 }).map((l) => l.text)).toEqual(["Free memory 20 KB."]);
    expect(diagLines({ heap: 20480, heap_min: 9000 })[0].text).toBe("Free memory 20 KB, lowest 8.8 KB since it started.");
    expect(diagLines({ block: 3000 })[0].text).toBe("Largest free block 2.9 KB, and it needs at least 4.0 KB.");
    expect(diagLines(null)).toEqual([]);
    expect(diagLines({})).toEqual([]);
  });
});

describe("the Mega's !DIAG counters", () => {
  const mega = (diag: unknown) => ({ diag } as never);

  it("reads five non-negative integers, and nothing else", () => {
    expect(megaDiag(mega([1, 2, 3, 4, 5]))).toEqual({ lcd_errors: 1, lcd_reinits: 2, rx_overruns: 3, ceilings: 4, cap_offs: 5 });
    expect(megaDiag(mega([1, 2, 3]))).toBeNull();
    expect(megaDiag(mega([1, 2, -3, 4, 5]))).toBeNull();
    expect(megaDiag(mega([1, 2, 3.5, 4, 5]))).toBeNull();
    expect(megaDiag(null)).toBeNull();
  });

  it("measures a rise from the first reading, and a Mega restart as a rise from zero", () => {
    const first = megaDiag(mega([0, 10, 0, 1, 0]));
    expect(diagRises(first, megaDiag(mega([2, 11, 0, 1, 0])))).toEqual({ lcd_errors: 2, lcd_reinits: 1 });
    // ceilings went DOWN: the Mega restarted, so every counter now is new since the reading.
    expect(diagRises(megaDiag(mega([0, 10, 0, 5, 0])), megaDiag(mega([0, 1, 0, 2, 0])))).toEqual({ lcd_reinits: 1, ceilings: 2 });
    expect(diagRises(null, first)).toEqual({});
  });

  it("marks a rise in screen errors or ceilings, but not the routine screen refresh", () => {
    const lines = megaLines(mega([1, 4, 0, 2, 0]), { lcd_errors: 1, lcd_reinits: 4, ceilings: 2 });
    const byText = (re: RegExp) => lines.find((l) => re.test(l.text))!;
    expect(byText(/screen bus error/).attention).toBe(true);
    expect(byText(/sent back to the start/).attention).toBe(true);
    expect(byText(/screen resets/).attention).toBe(false);
    // A zero counter with no rise is not a line at all.
    expect(lines.some((l) => /lost byte/.test(l.text))).toBe(false);
  });
});

describe("drift and the whole-board verdict", () => {
  const device = (extra: Partial<AdminDevice>) => ({ ...extra } as AdminDevice);

  it("names the keys a board could not read", () => {
    expect(driftLine(["roster", "config.lcd_layout"])).toMatch(/could not read part of the club's last answer: roster, config\.lcd_layout\./);
    expect(driftLine([])).toBeNull();
    expect(driftLine(undefined)).toBeNull();
  });

  it("needs attention for drift, a missing screen, a bad Mega reset or a value under a floor", () => {
    expect(healthNeedsAttention(device({ drift: ["roster"] }))).toBe(true);
    expect(healthNeedsAttention(device({ mega: { lcd: "00" } }))).toBe(true);
    expect(healthNeedsAttention(device({ mega: { lcd: "27" } }))).toBe(false);
    expect(healthNeedsAttention(device({ mega: { reset: "08" } }))).toBe(true);
    expect(healthNeedsAttention(device({ diag: { block: 100 } }))).toBe(true);
    expect(healthNeedsAttention(device({ diag: { reset: "power_on", block: 9000, stack_min: 900 } }))).toBe(false);
  });

  it("is served only when the API sends any of the three", () => {
    expect(servesHealth(device({}))).toBe(false);
    expect(servesHealth(device({ diag: null }))).toBe(true);
  });
});
