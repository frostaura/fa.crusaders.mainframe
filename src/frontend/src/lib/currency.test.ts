import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CURRENCY_SYMBOL,
  clubCurrencySymbol,
  isAcceptableCurrencySymbol,
  readCurrencySymbol,
  resetClubCurrencySymbol,
  setClubCurrencySymbol,
  spokenCurrencyName,
} from "./currency";

afterEach(resetClubCurrencySymbol);

/**
 * The club's currency symbol — the unit of account's own sign.
 *
 * <p>
 * The owner's ruling, given twice: the wallet, court prices and top-ups are all denominated
 * in the club's currency, written as a symbol IN FRONT of the amount. "cr" and the word
 * "credits" are gone as units. What that does and does not claim is set out at the head of
 * `currency.ts`.
 * </p>
 */
describe("the club's currency symbol", () => {
  it("defaults to the rand sign, because the club is in Durban North", () => {
    expect(DEFAULT_CURRENCY_SYMBOL).toBe("R");
    expect(clubCurrencySymbol()).toBe("R");
  });

  it("accepts the multi-character symbols real currencies use", () => {
    // A one-character rule would have been enough for ZAR and wrong for most of the world.
    for (const symbol of ["R", "$", "€", "kr", "R$", "CHF", "US$", "₹", "zł", "Kč"]) {
      expect(isAcceptableCurrencySymbol(symbol), symbol).toBe(true);
      expect(readCurrencySymbol(symbol), symbol).toBe(symbol);
    }
  });

  it("trims, because a trailing space is what a person types after a symbol", () => {
    // The owner wrote the setting as "R " with the space that separates it from the
    // amount. The space is the FORMATTER's business, not the value's, or every club
    // that pastes one gets a double gap.
    expect(readCurrencySymbol("  R  ")).toBe("R");
    expect(readCurrencySymbol("R$ ")).toBe("R$");
    expect(readCurrencySymbol("R\n")).toBe("R");
    expect(readCurrencySymbol("\tR$\n")).toBe("R$");
    // Only the ENDS are packaging. Whitespace INSIDE is not a symbol and is refused —
    // otherwise "R X" saves and prints as a symbol with a hole in it.
    expect(isAcceptableCurrencySymbol("R X")).toBe(false);
    expect(isAcceptableCurrencySymbol("R\nX")).toBe(false);
  });

  it("is a symbol, not an essay, and not a sentence a club could inject", () => {
    // Bounded at 4 characters: past that it is not a symbol, and it is also the string
    // that goes into an HTML email body and onto a 20-column device screen's neighbours.
    for (const bad of [
      "", "   ", "RANDS", "R 50", "50", "R50", "<b>", "&nbsp;", "\"R\"", "R\nX",
      null, undefined, 42, {}, [],
    ]) {
      expect(isAcceptableCurrencySymbol(bad), JSON.stringify(bad)).toBe(false);
      expect(readCurrencySymbol(bad), JSON.stringify(bad)).toBe(DEFAULT_CURRENCY_SYMBOL);
    }
  });

  /**
   * Unknown is never "some other club's".
   *
   * <p>
   * The store is a module singleton because the formatters are pure functions called from
   * `lib/*Copy.ts`, which are not components and cannot read a React context. That makes
   * the one real hazard a stale value surviving a change of club in the same tab — a
   * signed-out screen, a second sign-in, an admin on two clubs. So a profile with NO
   * symbol resets to the default rather than leaving the previous club's standing.
   * </p>
   */
  describe("cross-club isolation", () => {
    it("replaces the previous club's symbol rather than keeping it", () => {
      setClubCurrencySymbol("R");
      expect(clubCurrencySymbol()).toBe("R");
      setClubCurrencySymbol("CHF");
      expect(clubCurrencySymbol()).toBe("CHF");
    });

    it("falls back to the default when the next club has not said", () => {
      setClubCurrencySymbol("CHF");
      setClubCurrencySymbol(undefined);
      expect(clubCurrencySymbol()).toBe(DEFAULT_CURRENCY_SYMBOL);
    });

    it("falls back to the default when the next club's value is unusable", () => {
      setClubCurrencySymbol("CHF");
      setClubCurrencySymbol("RANDS");
      expect(clubCurrencySymbol()).toBe(DEFAULT_CURRENCY_SYMBOL);
    });
  });

  /**
   * The spoken name, which is the half nobody looks at.
   *
   * <p>
   * A screen reader handed "R240.00" announces the R as a letter. The visible text is a
   * symbol; the ACCESSIBLE name has to be a sentence a person understands, so it needs a
   * word. There is no way to derive "rand" from "R" in general, so the few symbols the
   * product is likely to meet are named, and everything else degrades to no noun at all —
   * which still reads as a sentence, because the sentence around it says what the number is.
   * </p>
   */
  describe("the spoken name", () => {
    it("names the currencies a club is likely to be in", () => {
      expect(spokenCurrencyName("R")).toBe("rand");
      expect(spokenCurrencyName("$")).toBe("dollars");
      expect(spokenCurrencyName("€")).toBe("euros");
      expect(spokenCurrencyName("£")).toBe("pounds");
      expect(spokenCurrencyName("CHF")).toBe("Swiss francs");
    });

    it("answers nothing rather than guessing, for one it does not know", () => {
      // A wrong noun is worse than none: "240.00 dollars" for a club on ₹ is a lie a
      // sighted member would never be told. No noun still leaves a usable sentence.
      expect(spokenCurrencyName("₸")).toBeNull();
      expect(spokenCurrencyName("Kč")).toBeNull();
    });

    it("reads the club's own symbol when it is not given one", () => {
      setClubCurrencySymbol("€");
      expect(spokenCurrencyName()).toBe("euros");
      setClubCurrencySymbol("R");
      expect(spokenCurrencyName()).toBe("rand");
    });
  });
});
