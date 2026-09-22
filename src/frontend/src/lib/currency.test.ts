import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CURRENCY_SYMBOL,
  clubCurrencySymbol,
  isAcceptableCurrencySymbol,
  readCurrencySymbol,
  resetClubCurrencySymbol,
  setClubCurrencySymbol,
} from "./currency";

afterEach(resetClubCurrencySymbol);

/**
 * The symbol is the club's, it is REAL MONEY's, and an absent one is the default.
 *
 * <p>
 * `currency_symbol` names the unit a member actually pays the gateway in. It is not the
 * credit unit and must never become it — see the decision recorded at the head of
 * `currency.ts`.
 * </p>
 */
describe("the club's currency symbol", () => {
  it("defaults to the rand sign, because the club is in Durban North", () => {
    expect(DEFAULT_CURRENCY_SYMBOL).toBe("R");
    expect(clubCurrencySymbol()).toBe("R");
  });

  it("accepts the multi-character symbols real currencies use", () => {
    // A one-character rule would have been enough for ZAR and wrong for most of the
    // world. R$ is two, CHF is three, and a club that types one must not be refused.
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
    // A pasted value carries whatever came with it. Trailing whitespace of any kind is
    // the value's packaging, not the value.
    expect(readCurrencySymbol("R\n")).toBe("R");
    expect(readCurrencySymbol("\tR$\n")).toBe("R$");
    // Only the ENDS are packaging. Whitespace INSIDE is not a symbol and is refused —
    // otherwise "R X" saves and prints as a symbol with a hole in it.
    expect(isAcceptableCurrencySymbol("R X")).toBe(false);
    expect(isAcceptableCurrencySymbol("R\nX")).toBe(false);
  });

  it("is a symbol, not an essay, and not a sentence a club could inject", () => {
    // Bounded at 4 characters: past that it is not a symbol, and it is also the string
    // that goes into an HTML email body and a 20-column device screen's neighbours.
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
});
