import { describe, expect, it } from "vitest";
import { formatCredits, formatZar } from "./utils";

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
