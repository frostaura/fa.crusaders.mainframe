import { describe, expect, it } from "vitest";
import { MINUS_SIGN, NO_FIGURE, NO_FIGURE_SPOKEN, minutesCompact, minutesSigned, minutesSpoken } from "./minutes";

/**
 * P13 contract §7.1, every example it gives plus the edges it states as rules. A figure here
 * is a figure a member reads, so each is pinned as a whole string, never a `toContain`.
 */
const M = MINUS_SIGN;

describe("minutesCompact — the contract's examples", () => {
  it.each([
    [0, "0 min"],
    [45, "45 min"],
    [60, "1 h"],
    [90, "1 h 30 min"],
    [1440, "1 d"],
    [1815, "1 d 6 h 15 min"],
    [-90, `${M}1 h 30 min`],
  ])("%d → %s", (n, out) => expect(minutesCompact(n)).toBe(out));
});

describe("minutesCompact — the rules", () => {
  it.each([
    [1, "1 min"],
    [59, "59 min"],
    [61, "1 h 1 min"],
    [120, "2 h"],
    [1439, "23 h 59 min"],
    [1441, "1 d 1 min"],
    [1500, "1 d 1 h"],
    [2880, "2 d"],
    [3060, "2 d 3 h"],
    [10_080, "7 d"],
    [60_000, "41 d 16 h"],
  ])("leaves out every zero part: %d → %s", (n, out) => expect(minutesCompact(n)).toBe(out));

  it.each([
    [-1, `${M}1 min`],
    [-45, `${M}45 min`],
    [-60, `${M}1 h`],
    [-1815, `${M}1 d 6 h 15 min`],
  ])("puts ONE U+2212 on the whole negative value: %d → %s", (n, out) => {
    expect(minutesCompact(n)).toBe(out);
    expect(minutesCompact(n).split(M)).toHaveLength(2);
    expect(minutesCompact(n)).not.toContain("-");
  });

  it("never prints hh:mm for an amount", () => {
    for (const n of [0, 5, 90, 1815, -90]) expect(minutesCompact(n)).not.toMatch(/\d:\d/);
  });

  it.each([
    [45.9, "45 min"],
    [90.5, "1 h 30 min"],
    [-45.9, `${M}45 min`],
    [0.4, "0 min"],
    [-0.4, "0 min"],
    [-0, "0 min"],
  ])("never shows a decimal — truncates toward zero: %d → %s", (n, out) => {
    expect(minutesCompact(n)).toBe(out);
    expect(minutesCompact(n)).not.toMatch(/[.,]\d/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("never invents a figure for %d", (n) => {
    expect(minutesCompact(n)).toBe(NO_FIGURE);
  });
});

describe("minutesSigned — a movement", () => {
  it.each([
    [60, "+1 h"],
    [-45, `${M}45 min`],
    [0, "0 min"],
    [-0, "0 min"],
    [90, "+1 h 30 min"],
    [-1815, `${M}1 d 6 h 15 min`],
    [1440, "+1 d"],
    [0.7, "0 min"],
    [-0.7, "0 min"],
    [45.5, "+45 min"],
  ])("%d → %s", (n, out) => expect(minutesSigned(n)).toBe(out));

  it("gives a zero no sign at all", () => {
    expect(minutesSigned(0)).not.toMatch(/^[+\u2212-]/);
  });

  it("never invents a figure", () => expect(minutesSigned(Number.NaN)).toBe(NO_FIGURE));
});

describe("minutesSpoken — what a screen reader hears", () => {
  it.each([
    [90, "1 hour 30 minutes"],
    [1, "1 minute"],
    [-45, "minus 45 minutes"],
    [3060, "2 days 3 hours"],
    [0, "0 minutes"],
  ])("the contract's examples: %d → %s", (n, out) => expect(minutesSpoken(n)).toBe(out));

  it.each([
    [2, "2 minutes"],
    [60, "1 hour"],
    [61, "1 hour 1 minute"],
    [120, "2 hours"],
    [1440, "1 day"],
    [1441, "1 day 1 minute"],
    [1500, "1 day 1 hour"],
    [1815, "1 day 6 hours 15 minutes"],
    [2881, "2 days 1 minute"],
    [-1, "minus 1 minute"],
    [-1440, "minus 1 day"],
    [-1815, "minus 1 day 6 hours 15 minutes"],
  ])("singular and plural, zero parts left out: %d → %s", (n, out) => expect(minutesSpoken(n)).toBe(out));

  it.each([
    [60, "plus 1 hour"],
    [1, "plus 1 minute"],
    [-45, "minus 45 minutes"],
    [0, "0 minutes"],
  ])("signed: %d → %s", (n, out) => expect(minutesSpoken(n, { signed: true })).toBe(out));

  it("never says h, d or min", () => {
    for (const n of [0, 1, 45, 60, 90, 1440, 1815, 3060, -90, -1815]) {
      for (const signed of [false, true]) {
        expect(minutesSpoken(n, { signed })).not.toMatch(/\b(h|d|min)\b/);
      }
    }
  });

  it("uses the words, not the minus sign", () => {
    expect(minutesSpoken(-90)).not.toContain(M);
    expect(minutesSpoken(-90)).not.toContain("-");
  });

  it.each([
    [45.9, "45 minutes"],
    [-45.9, "minus 45 minutes"],
    [-0.5, "0 minutes"],
  ])("truncates toward zero: %d → %s", (n, out) => expect(minutesSpoken(n)).toBe(out));

  it("never invents a figure", () => expect(minutesSpoken(Number.NaN)).toBe(NO_FIGURE_SPOKEN));
});

describe("the three agree on the number", () => {
  it("compact and spoken name the same parts for every minute of the first two days", () => {
    const unit = { d: "day", h: "hour", min: "minute" } as const;
    for (let n = 0; n <= 2 * 1440 + 61; n += 1) {
      const fromCompact = minutesCompact(n).split(" ").reduce<string[]>((acc, tok, i, all) => {
        if (i % 2 === 1) {
          const count = Number(all[i - 1]);
          const word = unit[tok as keyof typeof unit];
          acc.push(`${count} ${count === 1 ? word : `${word}s`}`);
        }
        return acc;
      }, []).join(" ");
      expect(minutesSpoken(n)).toBe(fromCompact);
    }
  });
});
