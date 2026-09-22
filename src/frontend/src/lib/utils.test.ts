import { afterEach, describe, expect, it } from "vitest";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "./currency";
import { formatCredits, formatMinutes, formatRate, formatRatePerRand, formatSignedCredits, formatZar } from "./utils";

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
    expect(formatZar(100)).toBe("CHF100.00");
    expect(formatZar(0)).toBe("CHF0.00");
    expect(formatZar(1234567.891)).toBe("CHF1234567.89");
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
    expect(formatZar(-50)).toBe("-R50.00");
    setClubCurrencySymbol("R$");
    expect(formatZar(-50)).toBe("-R$50.00");
    // Negative zero is zero, and carries no direction — as it does for credits.
    expect(formatZar(-0)).toBe("R$0.00");
  });

  it("falls back to the default symbol when the club has not said", () => {
    // An older API serves no key at all, which is the commonest case on the day this
    // ships. It must be indistinguishable from a club that chose "R".
    setClubCurrencySymbol(undefined);
    expect(formatZar(100)).toBe("R100.00");
    expect(formatRatePerRand(1.6)).toBe("1.6 credits / R1");
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

  it("agrees the noun with the rate, so a 1:1 club is not quoted 1 credits", () => {
    // Seen live on the re-quote screen: a club whose rate is exactly 1 read
    // "At 1 credits / R1". The trimming that makes 1.6000 into 1.6 is what leaves 1
    // standing beside a plural noun, so the noun belongs with the number.
    expect(formatRatePerRand(1)).toBe("1 credit / R1");
    expect(formatRatePerRand(1.0)).toBe("1 credit / R1");
    // 1.0000 IS one, and 0.9999 is not — the boundary is the trimmed number, not the input.
    expect(formatRatePerRand(1.00001)).toBe("1 credit / R1");
    expect(formatRatePerRand(0.9999)).toBe("0.9999 credits / R1");

    // Everything else is plural, including the fractions and the zero. English pluralises
    // every quantity but one, so this is not a special case list, it is the rule.
    expect(formatRatePerRand(1.6)).toBe("1.6 credits / R1");
    expect(formatRatePerRand(1.6667)).toBe("1.6667 credits / R1");
    expect(formatRatePerRand(2)).toBe("2 credits / R1");
    expect(formatRatePerRand(0.5)).toBe("0.5 credits / R1");
    expect(formatRatePerRand(0)).toBe("0 credits / R1");
  });

  it("quotes the rate against the club's own currency, not a hardcoded rand", () => {
    // "1.6 credits / R1" hardcoded the rand sign beside a number that is the club's
    // own `credits_per_zar_*`. A club on another currency was being told its rate per
    // a currency it does not take.
    setClubCurrencySymbol("CHF");
    expect(formatRatePerRand(1.6)).toBe("1.6 credits / CHF1");
    expect(formatRatePerRand(1)).toBe("1 credit / CHF1");
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
