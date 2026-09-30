import { afterEach, describe, expect, it } from "vitest";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "./currency";
import { cn, describeTopUpRate, formatCredits, formatMinutes, formatRate, formatSignedCredits, formatMoney, MINUS } from "./utils";

afterEach(resetClubCurrencySymbol);

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
    expect(formatCredits(-2.4)).toBe("−2.40 cr");

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
    expect(formatMoney(100)).toBe("R100.00");
  });

  /**
   * The club's symbol reaches real money and stops there.
   *
   * <p>
   * `currency_symbol` is the unit a member hands the gateway. Putting it on a credit
   * figure is the defect this file's first paragraph describes and `money.spec.ts`
   * guards — at the default 1.6 rate a 240-credit wallet shown as "R240.00" overstates
   * the member's rand position by 60%.
   * </p>
   */
  it("puts the club's own symbol in front of a rand amount", () => {
    setClubCurrencySymbol("CHF");
    expect(formatMoney(100)).toBe("CHF100.00");
    expect(formatMoney(0)).toBe("CHF0.00");
    expect(formatMoney(1234567.891)).toBe("CHF1234567.89");
  });

  it("never lets the club's symbol touch a credit figure", () => {
    setClubCurrencySymbol("CHF");
    expect(formatCredits(240)).toBe("240.00 cr");
    expect(formatCredits(240, { long: true })).toBe("240.00 credits");
    expect(formatSignedCredits(-15)).toBe("−15.00 cr");
    for (const rendered of [formatCredits(240), formatSignedCredits(240)]) {
      expect(rendered).not.toContain("CHF");
      expect(rendered).not.toContain("R");
    }
  });

  it("puts the sign OUTSIDE the symbol, because R-50.00 is not a thing anyone writes", () => {
    // A preceding symbol forces the choice that a trailing unit never did. "-R50.00"
    // is how a negative amount of money is written; "R-50.00" reads as a symbol
    // followed by a malformed number. `net_zar` on the club revenue card goes negative
    // in any period whose refunds beat its top-ups, so this renders in production.
    expect(formatMoney(-50)).toBe("−R50.00");
    setClubCurrencySymbol("R$");
    expect(formatMoney(-50)).toBe("−R$50.00");
    // Negative zero is zero, and carries no direction — as it does for credits.
    expect(formatMoney(-0)).toBe("R$0.00");
  });

  it("falls back to the default symbol when the club has not said", () => {
    // An older API serves no key at all, which is the commonest case on the day this
    // ships. It must be indistinguishable from a club that chose "R".
    setClubCurrencySymbol(undefined);
    expect(formatMoney(100)).toBe("R100.00");
    expect(describeTopUpRate(1.6)).toBe("Every R1.00 you pay adds 1.60 cr to your wallet");
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
    // Zero is the exception, and it changed: it used to render "+0.00 cr" here and
    // "−0.00 cr" on the reports card, which hardcoded its own minus. Nothing moved, so
    // nothing carries a direction.
    expect(formatSignedCredits(0)).toBe("0.00 cr");
    expect(formatSignedCredits(-0)).toBe("0.00 cr");

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

  /**
   * The conversion boundary — the one sentence in the product that spans both units.
   *
   * It used to read "1.6 credits / R1", which is accurate and which asks the reader to do
   * the multiplication the sentence exists to save them. It now names what leaves the card
   * and what arrives in the wallet, each in its own unit — and the two being visibly
   * different units is the point, because a member paying R100 for 160 cr must not be able
   * to read that as R160.
   */
  it("says what leaves the card and what arrives in the wallet", () => {
    expect(describeTopUpRate(1.6)).toBe("Every R1.00 you pay adds 1.60 cr to your wallet");
    expect(describeTopUpRate(2.4)).toBe("Every R1.00 you pay adds 2.40 cr to your wallet");
  });

  it("keeps the money leg and the wallet leg in different units", () => {
    // The whole guard, as one assertion: exactly one R, and it is on the money leg.
    const sentence = describeTopUpRate(1.6);
    expect(sentence.match(/R/g)).toHaveLength(1);
    expect(sentence).toContain("R1.00");
    expect(sentence).toContain("1.60 cr");
    expect(sentence).not.toContain("R1.60");
  });

  it("follows the club's own symbol on the money leg only", () => {
    setClubCurrencySymbol("CHF");
    expect(describeTopUpRate(1.6)).toBe("Every CHF1.00 you pay adds 1.60 cr to your wallet");
  });

  it("says it plainly for a club that gives no bonus at all", () => {
    // A club on 1:1 reads "adds 1.00 cr". A sentence that vanished at parity would leave
    // that screen saying nothing about the rate at all.
    expect(describeTopUpRate(1)).toBe("Every R1.00 you pay adds 1.00 cr to your wallet");
  });

  it("retires the singular trap the old wording carried", () => {
    // "1 credit / R1" needed the noun to agree with the number, and a club on exactly 1
    // was told "At 1 credits / R1" — seen live on the re-quote screen. "cr" does not
    // inflect, so the agreement problem cannot come back.
    for (const rate of [0, 0.5, 1, 1.0001, 1.6, 2]) {
      expect(describeTopUpRate(rate), String(rate)).not.toMatch(/\bcredits?\b/);
    }
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

/** R1 (F3 follow-up) — one minus sign, U+2212, in every displayed amount; never a hyphen, never "−0.00". */
describe("one minus sign", () => {
  it.each([
    ["formatCredits", () => formatCredits(-5)],
    ["formatCredits long", () => formatCredits(-5, { long: true })],
    ["formatMoney", () => formatMoney(-5)],
    ["formatSignedCredits", () => formatSignedCredits(-5)],
  ])("%s uses U+2212 and no hyphen", (_name, render) => {
    expect(render()).toContain(MINUS);
    expect(render()).not.toContain("-");
  });

  it("gives a figure that rounds to zero no sign at all", () => {
    expect(formatCredits(-0.001)).toBe("0.00 cr");
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
