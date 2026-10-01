import { describe, expect, it } from "vitest";
import {
  PACKAGES_COPY, baselineOf, minutesComplaint, parsePackageMinutes, parsePrice, perHour, priceComplaint, savingOf, shelfWith,
  type ShelfItem,
} from "./packagesCopy";
import { AMOUNT_COPY } from "./amountCopy";
import type { AdminPackage } from "./adminApi";

const item = (id: string, minutes: number, price_zar: number): ShelfItem => ({ id, name: id, minutes, price_zar });
const HOUR = item("1h", 60, 120);
const FIVE = item("5h", 300, 550);
const TEN = item("10h", 600, 1000);

/** §4.3, the contract's own worked example — the console must say what the member's shelf says. */
describe("the saving against the shelf's smallest package (§4.3)", () => {
  it("is R50 (8%) for 5 h and R200 (16%) for 10 h against 1 h at R120", () => {
    const baseline = baselineOf([TEN, FIVE, HOUR]);
    expect(baseline).toBe(HOUR);
    expect(savingOf(FIVE, baseline)).toEqual({ zar: 50, pct: 8 });
    expect(savingOf(TEN, baseline)).toEqual({ zar: 200, pct: 16 });
  });

  it("keeps the percentages and scales the rand at a 10% discount (R45 and R180)", () => {
    const base = item("1h", 60, 108);
    expect(savingOf(item("5h", 300, 495), base)).toEqual({ zar: 45, pct: 8 });
    expect(savingOf(item("10h", 600, 900), base)).toEqual({ zar: 180, pct: 16 });
  });

  it("says nothing for the baseline itself, for no saving, and drops a percentage that rounds to 0", () => {
    expect(savingOf(HOUR, HOUR)).toBeNull();
    expect(savingOf(item("2h", 120, 240), HOUR)).toBeNull();
    expect(savingOf(item("2h", 120, 250), HOUR)).toBeNull();
    // R0.50 off R240: a real saving, but under 1% — the rand is said, the percentage is not.
    expect(savingOf(item("2h", 120, 239.5), HOUR)).toEqual({ zar: 0.5, pct: null });
  });

  it("measures a saving against the SMALLEST package — never the largest (mutation check, §1.4)", () => {
    // Against 10 h (R100/h) a 5 h at R550 saves nothing; against 1 h it saves R50.
    expect(savingOf(FIVE, baselineOf([FIVE, TEN, HOUR]))).toEqual({ zar: 50, pct: 8 });
  });

  it("rounds the rand DOWN to the cent, in the buyer's favour — never to the nearest (§1.2)", () => {
    // R100 an hour: 7 minutes are worth R11.666…, so R11.66 saves R0.0066… — no whole cent.
    expect(savingOf(item("7m", 7, 11.66), item("1h", 60, 100))).toBeNull();
    // 13 minutes are worth R21.666…: R21.60 saves R0.066… → R0.06, never R0.07.
    expect(savingOf(item("13m", 13, 21.6), item("1h", 60, 100))?.zar).toBe(0.06);
  });

  it("breaks a tie on minutes by the lower price", () => {
    expect(baselineOf([item("a", 60, 130), item("b", 60, 120)])?.id).toBe("b");
  });

  it("measures on the draft's OWN shelf: same group, on sale, the draft standing in for its old self", () => {
    const pkg = (over: Partial<AdminPackage>): AdminPackage => ({
      id: "x", name: "x", minutes: 60, price_zar: 120, group: null, sort_order: 0, status: "active",
      created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z", ...over,
    });
    const all = [
      pkg({ id: "club-1h" }),
      pkg({ id: "league-30", minutes: 30, price_zar: 10, group: { id: "g1", name: "League" } }),
      pkg({ id: "retired", minutes: 15, price_zar: 1, status: "archived" }),
      pkg({ id: "edited", minutes: 300, price_zar: 600 }),
    ];
    const draft = item("edited", 300, 550);
    const shelf = shelfWith(all, null, draft);
    expect(shelf.map((s) => s.id)).toEqual(["club-1h", "edited"]);
    expect(savingOf(draft, baselineOf(shelf))).toEqual({ zar: 50, pct: 8 });
  });
});

describe("the fields, at the server's bounds (§3.5)", () => {
  it("takes whole minutes from 1 to 60 000, never a fraction", () => {
    expect(parsePackageMinutes("300")).toBe(300);
    expect(parsePackageMinutes("30.5")).toBeNull();
    expect(minutesComplaint("30.5")).toBe(AMOUNT_COPY.tooPrecise("minutes"));
    expect(minutesComplaint("0")).toBe(AMOUNT_COPY.zero);
    expect(minutesComplaint("60001")).toMatch(/^The most this can be is 41 d 16 h 1 min|^The most this can be is /);
    expect(minutesComplaint("60000")).toBeNull();
  });

  it("takes a rand price above R0, in whole cents, up to R100 000", () => {
    expect(parsePrice("550")).toBe(550);
    expect(parsePrice("12,50")).toBe(12.5);
    expect(priceComplaint("12.505")).not.toBeNull();
    expect(priceComplaint("0")).toBe(AMOUNT_COPY.zero);
    expect(priceComplaint("100001")).not.toBeNull();
  });

  it("works out rand per hour, rounded down to the cent", () => {
    expect(perHour(550, 300)).toBe(110);
    expect(perHour(100, 45)).toBe(133.33);
    expect(perHour(100, 0)).toBeNull();
  });

  it("names a refused package in words, never a code", () => {
    for (const said of Object.values(PACKAGES_COPY.errorCodes)) expect(said).not.toMatch(/_|credit|\bcr\b/i);
  });
});
