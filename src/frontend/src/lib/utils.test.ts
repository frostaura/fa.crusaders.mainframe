import { describe, expect, it } from "vitest";
import { formatCredits, formatMinutes, formatRate, formatSignedCredits, formatZar } from "./utils";

/**
 * The money-rendering bug, pinned.
 *
 * Credits are the unit of account. A member tops up R100 and receives 160 credits at
 * the Regular rate or 240 at the League rate, and every court price is quoted in
 * credits — so a rand sign on a credit figure is not a cosmetic slip. At 1.6–2.4
 * credits per rand it overstates what a member has by 60% to 140%, and it was doing
 * that on the wallet header, the booking grid, the reports and the admin member list
 * at the same time.
 */
describe("money formatting", () => {
  it("renders credits with a credit unit and never a rand sign", () => {
    expect(formatCredits(240)).toBe("240.00 cr");
    expect(formatCredits(0)).toBe("0.00 cr");
    expect(formatCredits(8)).toBe("8.00 cr");
    expect(formatCredits(-2.4)).toBe("-2.40 cr");

    expect(formatCredits(240)).not.toContain("R");
  });

  it("spells the unit out where there is room for it", () => {
    expect(formatCredits(160, { long: true })).toBe("160.00 credits");
  });

  it("keeps two decimals, because the ledger does", () => {
    // The ledger column is numeric(10,2). A display that rounded differently would
    // disagree with a statement a member is holding.
    expect(formatCredits(10.666)).toBe("10.67 cr");
    expect(formatCredits(2.4)).toBe("2.40 cr");
  });

  it("still renders rand for the screens that really handle rand", () => {
    // Top-ups are genuinely in rand: that is what PayFast charges. The two functions
    // exist so the distinction is made once, deliberately, rather than by whoever is
    // editing a component.
    expect(formatZar(100)).toBe("R100.00");
  });
});

/**
 * The formatters the money screens were each doing by hand.
 *
 * <p>
 * The ledger table built its own sign, its own <code>toFixed(2)</code> and its own
 * literal " cr" — so the one table where the SIGN carries the meaning was the only place
 * not going through <code>formatCredits</code>. The top-up screen printed the conversion
 * rate with <code>toFixed(2)</code>, which is a money bug rather than a rounding one:
 * <code>credits_per_zar_*</code> takes four decimals, so a club on 1.6667 was quoted
 * 1.67 on screen and settled at 1.6667 in the ledger.
 * </p>
 */
describe("signed credits, rates and durations", () => {
  it("shows the sign explicitly, and uses a real minus so a column lines up", () => {
    expect(formatSignedCredits(2500)).toBe("+2500.00 cr");
    expect(formatSignedCredits(-15)).toBe("−15.00 cr");
    expect(formatSignedCredits(0)).toBe("+0.00 cr");

    // U+2212 MINUS, not a hyphen: in the tabular-nums amount column a hyphen is narrower
    // than a plus, so a debit sits half a character out from the credit above it.
    expect(formatSignedCredits(-15)).toContain("\u2212");
    expect(formatSignedCredits(-15)).not.toContain("-");
  });

  it("keeps every decimal the rate column can hold, and trims the ones it cannot", () => {
    // The bug: 1.6667 shown as 1.67 is a quote the club will not honour, because the
    // ledger settles on the stored 1.6667.
    expect(formatRate(1.6667)).toBe("1.6667");
    expect(formatRate(1.6)).toBe("1.6");
    expect(formatRate(2.4)).toBe("2.4");
    expect(formatRate(2)).toBe("2");
  });

  it("says a duration the way a person says it", () => {
    // Minutes exist on these screens because "slices" mixes units — a 60-minute walk-up
    // is one slice, and so is a 15-minute booking.
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(60)).toBe("1 h");
    expect(formatMinutes(75)).toBe("1 h 15 min");
    expect(formatMinutes(225)).toBe("3 h 45 min");
    expect(formatMinutes(0)).toBe("0 min");
  });
});
