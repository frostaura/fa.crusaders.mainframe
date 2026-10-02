import { afterEach, describe, expect, it } from "vitest";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "./currency";
import { cn, formatMinutes, formatMoney, MINUS } from "./utils";

afterEach(resetClubCurrencySymbol);

/**
 * Real money, pinned. Rand is only ever a package price or what the club received; every other
 * amount is minutes (`lib/minutes.ts`, P13), so the club's symbol is scoped to `formatMoney`.
 */
describe("money formatting", () => {
  it("renders rand for the screens that really handle rand", () => {
    expect(formatMoney(100)).toBe("R100.00");
  });

  it("puts the club's own symbol in front of a rand amount", () => {
    setClubCurrencySymbol("CHF");
    expect(formatMoney(100)).toBe("CHF100.00");
    expect(formatMoney(0)).toBe("CHF0.00");
    expect(formatMoney(1234567.891)).toBe("CHF1234567.89");
  });

  it("puts the sign OUTSIDE the symbol, because R-50.00 is not a thing anyone writes", () => {
    // `net_zar` on the club revenue card goes negative in any period whose refunds beat its sales.
    expect(formatMoney(-50)).toBe("−R50.00");
    setClubCurrencySymbol("R$");
    expect(formatMoney(-50)).toBe("−R$50.00");
    // Negative zero is zero, and carries no direction.
    expect(formatMoney(-0)).toBe("R$0.00");
  });

  it("falls back to the default symbol when the club has not said", () => {
    setClubCurrencySymbol(undefined);
    expect(formatMoney(100)).toBe("R100.00");
  });
});

describe("durations", () => {
  it("says a duration the way a person says it", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(60)).toBe("1 h");
    expect(formatMinutes(75)).toBe("1 h 15 min");
    expect(formatMinutes(225)).toBe("3 h 45 min");
    expect(formatMinutes(0)).toBe("0 min");
  });
});

/** R1 (F3 follow-up) — one minus sign, U+2212, in every displayed amount; never a hyphen, never "−0.00". */
describe("one minus sign", () => {
  it("formatMoney uses U+2212 and no hyphen", () => {
    expect(formatMoney(-5)).toContain(MINUS);
    expect(formatMoney(-5)).not.toContain("-");
  });

  it("gives a figure that rounds to zero no sign at all", () => {
    expect(formatMoney(-0.004)).not.toContain(MINUS);
  });
});

describe("cn — our named spacing steps (R3)", () => {
  it("lets a caller's size override the touch height instead of keeping both", () => {
    expect(cn("h-touch", "h-auto")).toBe("h-auto");
    expect(cn("min-h-touch", "min-h-0")).toBe("min-h-0");
    expect(cn("size-touch", "size-4")).toBe("size-4");
    expect(cn("pb-tabbar", "pb-4")).toBe("pb-4");
  });
});
