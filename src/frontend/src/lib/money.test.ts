import { afterEach, describe, expect, it } from "vitest";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "./currency";
import { formatMoney, formatSignedMoney, spokenMoney } from "./utils";

afterEach(resetClubCurrencySymbol);

/**
 * One amount, one formatter, one symbol — and the symbol goes in FRONT.
 *
 * <p>
 * <b>The owner's ruling, given twice.</b> "Instead of a `cr` suffix, have a configurable
 * currency symbol instead which would precede amounts", then: "remember the wording changes
 * from credits and cr to the currency symbol." So the wallet balance, the price of a slot
 * and a top-up are all written the same way — <code>R50.00</code> — and neither "cr" nor the
 * word "credits" survives as a unit.
 * </p>
 *
 * <p>
 * <b>What that collapses, stated plainly.</b> There used to be two formatters because there
 * are two quantities: what a member pays the gateway, and what their wallet holds, which
 * convert at <code>credits_per_zar_*</code> (shipped: 1.6 Regular, 2.4 League). They are now
 * written identically, so the ONLY place the rate is visible is the conversion itself — the
 * top-up screen and the top-up email — and those must state both legs in words. See
 * `currency.ts` for the full reasoning and the risk that remains.
 * </p>
 */
describe("money formatting", () => {
  it("puts the club's symbol in front of the amount", () => {
    expect(formatMoney(240)).toBe("R240.00");
    expect(formatMoney(0)).toBe("R0.00");
    expect(formatMoney(8)).toBe("R8.00");
  });

  it("uses the club's own symbol, never a hardcoded rand", () => {
    setClubCurrencySymbol("CHF");
    expect(formatMoney(240)).toBe("CHF240.00");
    setClubCurrencySymbol("R$");
    expect(formatMoney(1234567.891)).toBe("R$1234567.89");
  });

  it("keeps two decimals, because the ledger does", () => {
    // The ledger column is numeric(10,2). A display that rounded differently would
    // disagree with a statement a member is holding.
    expect(formatMoney(10.666)).toBe("R10.67");
    expect(formatMoney(2.4)).toBe("R2.40");
  });

  it("leaves no 'cr' and no 'credits' anywhere in what it renders", () => {
    // The whole of the owner's second instruction, as one assertion.
    for (const value of [0, 8, -12.5, 240, 1_000_000]) {
      expect(formatMoney(value)).not.toMatch(/\bcr\b/);
      expect(formatMoney(value)).not.toMatch(/credits?/i);
    }
  });

  it("puts the sign OUTSIDE the symbol, because R-50.00 is not a thing anyone writes", () => {
    // A preceding symbol forces the choice that a trailing unit never did. "-R50.00"
    // is how a negative amount of money is written; "R-50.00" reads as a symbol
    // followed by a malformed number. A wallet goes negative — settlement-model.md
    // allows it on a reversal — and the club revenue card's net goes negative in any
    // period whose refunds beat its top-ups.
    expect(formatMoney(-50)).toBe("-R50.00");
    setClubCurrencySymbol("R$");
    expect(formatMoney(-50)).toBe("-R$50.00");
    // Negative zero is zero, and carries no direction.
    expect(formatMoney(-0)).toBe("R$0.00");
  });

  it("falls back to the default symbol when the club has not said", () => {
    // An older API serves no key at all, which is the commonest case on the day this
    // ships. It must be indistinguishable from a club that chose "R".
    setClubCurrencySymbol(undefined);
    expect(formatMoney(100)).toBe("R100.00");
  });
});

/**
 * The signed form, for the one column where the direction is the meaning.
 */
describe("signed money", () => {
  it("shows the sign explicitly, and uses a real minus so a column lines up", () => {
    expect(formatSignedMoney(2500)).toBe("+R2500.00");
    expect(formatSignedMoney(-15)).toBe("−R15.00");

    // U+2212 MINUS, not a hyphen: in the tabular-nums amount column a hyphen is narrower
    // than a plus, so a debit sits half a character out from the credit above it.
    expect(formatSignedMoney(-15)).toContain("−");
    expect(formatSignedMoney(-15)).not.toContain("-");
  });

  it("gives zero no direction, because nothing moved", () => {
    // This used to render "+0.00 cr" on one screen and "−0.00 cr" on another. On the one
    // screen whose whole job is to reconcile, a signed zero reads as a movement that did
    // not happen. Note `-0 === 0`, so a negated zero lands here.
    expect(formatSignedMoney(0)).toBe("R0.00");
    expect(formatSignedMoney(-0)).toBe("R0.00");
  });

  it("keeps the sign outside the symbol here too", () => {
    setClubCurrencySymbol("CHF");
    expect(formatSignedMoney(2500)).toBe("+CHF2500.00");
    expect(formatSignedMoney(-15)).toBe("−CHF15.00");
  });
});

/**
 * The spoken form — the half nobody looks at, and the half the owner asked to be careful of.
 *
 * <p>
 * An <code>aria-label</code> REPLACES an element's contents as its accessible name. "cr" was
 * read as two letters, which is why the label always spelt "credits" where the chip showed
 * "cr". A bare symbol is the same problem wearing a different hat: a screen reader handed
 * "R240.00" announces the R as a letter. So the spoken form names the currency in words
 * where the product knows the word, and drops the noun rather than inventing one where it
 * does not — the sentence around it still says what the number is.
 * </p>
 */
describe("the spoken form of an amount", () => {
  it("says a word, not a letter", () => {
    expect(spokenMoney(240)).toBe("240.00 rand");
    expect(spokenMoney(0)).toBe("0.00 rand");
    expect(spokenMoney(-12.5)).toBe("−12.50 rand");
  });

  it("never contains the symbol, which is the thing that is mis-announced", () => {
    for (const symbol of ["R", "CHF", "R$", "€"]) {
      setClubCurrencySymbol(symbol);
      expect(spokenMoney(240), symbol).not.toContain(symbol);
    }
  });

  it("follows the club's currency into its own word", () => {
    setClubCurrencySymbol("€");
    expect(spokenMoney(240)).toBe("240.00 euros");
    setClubCurrencySymbol("CHF");
    expect(spokenMoney(240)).toBe("240.00 Swiss francs");
  });

  it("drops the noun rather than inventing one for a currency it cannot name", () => {
    // A wrong noun is worse than none. "240.00" inside "Wallet balance …. Tap to top up."
    // is still a sentence a person understands.
    setClubCurrencySymbol("₸");
    expect(spokenMoney(240)).toBe("240.00");
  });

  it("leaves no 'cr' and no 'credits' either", () => {
    expect(spokenMoney(240)).not.toMatch(/\bcr\b/);
    expect(spokenMoney(240)).not.toMatch(/credits?/i);
  });
});
