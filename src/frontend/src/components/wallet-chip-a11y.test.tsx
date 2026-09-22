import { afterEach, describe, expect, it } from "vitest";
import { walletLabel } from "../lib/balance";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "../lib/currency";

afterEach(resetClubCurrencySymbol);

/**
 * The wallet chip's accessible name.
 *
 * <p>
 * It was <code>aria-label="Wallet balance"</code>. An <code>aria-label</code> REPLACES an
 * element's contents as its accessible name, so a screen reader announced "Wallet balance,
 * link" and the number — the entire reason the chip is in the chrome, and the only thing in
 * the chrome that says whether a member can afford to book — was never read out. Not quietly,
 * not abbreviated: absent.
 * </p>
 *
 * <p>
 * The low-balance state has the same shape of problem. It is carried by the chip turning
 * amber, and a colour is not an announcement.
 * </p>
 */
describe("the wallet chip says the balance out loud", () => {
  it("names the amount, not just the concept", () => {
    expect(walletLabel(472, false)).toContain("472.00");
  });

  /**
   * A SPOKEN noun, and now it is the currency's rather than an invented unit's.
   *
   * <p>
   * The chip shows "R472.00" and this sentence says "472.00 rand". Both halves matter: a
   * label that said "R472.00" would hand a screen reader a letter where a word belongs, which
   * is the identical defect "cr" had, and one that still said "credits" would be naming a unit
   * the product no longer writes anywhere a member can see.
   * </p>
   */
  it("says the currency as a word, because a symbol is read as a letter", () => {
    expect(walletLabel(472, false)).toContain("472.00 rand");
    expect(walletLabel(472, false)).not.toMatch(/\bcr\b/);
    expect(walletLabel(472, false)).not.toMatch(/credits?/i);
    // And never the symbol itself, which is the thing that cannot be spoken.
    expect(walletLabel(472, false)).not.toContain("R472");
  });

  it("announces the low-balance state that is otherwise only a colour", () => {
    expect(walletLabel(12.5, false)).toContain("12.50 rand");
    expect(walletLabel(12.5, false)).toMatch(/running low/i);
  });

  it("does not cry wolf at the threshold", () => {
    expect(walletLabel(50, false)).not.toMatch(/running low/i);
    expect(walletLabel(49.99, false)).toMatch(/running low/i);
  });

  it("distinguishes 'still loading' from 'could not be read'", () => {
    // The visible chip used to show "— cr" for BOTH, which was the same ambiguity one layer
    // down; `chipFigure` in `CreditsBadge.tsx` now separates them there too.
    expect(walletLabel(null, true)).toMatch(/loading/i);
    expect(walletLabel(null, false)).toMatch(/unavailable/i);
    expect(walletLabel(null, false)).not.toMatch(/loading/i);
  });

  it("says what pressing it does, since the chip carries no other text", () => {
    expect(walletLabel(472, false)).toMatch(/top up/i);
  });

  it("reads a zero balance as a number rather than falling through to unavailable", () => {
    // `balance || "unavailable"` would be the natural bug here, and zero is the balance a
    // member most needs to hear.
    expect(walletLabel(0, false)).toContain("0.00 rand");
    expect(walletLabel(0, false)).not.toMatch(/unavailable/i);
  });

  /**
   * Empty is not low, and this assertion used to say the opposite.
   *
   * <p>
   * There were two arms, so at exactly 0.00 a member was told their balance was "running low".
   * It is not low, it is empty, and they cannot book anything at all — measured on a real
   * account, with the grid behind it offering 31 green "Available" cells and the chip in the
   * same amber as 49.99. Three states, three sentences, three looks.
   * </p>
   */
  it("tells an empty wallet the truth instead of calling it low", () => {
    expect(walletLabel(0, false)).not.toMatch(/running low/i);
    expect(walletLabel(0, false)).toMatch(/can't book until you top up/i);
    // Both halves: the arm below it still fires, or the fix has simply moved the boundary.
    expect(walletLabel(0.01, false)).toMatch(/running low/i);
    /*
      The rounding trap, settled the other way than this file first had it.

      Two lanes wrote a paragraph about 0.004 and reached opposite conclusions. This one said
      "genuinely low, since it is not <= 0"; the wallet page's said "empty, since it prints as
      0.00 and buys nothing". The wallet page is right, and the reason is that the sentence has
      to be about the number the member can SEE: a chip reading "R0.00" while the voice says
      "running low" is the two-arm defect this very test was written to kill, wearing the other
      arm. `walletTone` now decides for the chip, the page and the grid together — so this is
      one assertion about one rule rather than three files agreeing by hand.
    */
    expect(walletLabel(0.004, false)).toMatch(/can't book until you top up/i);
    expect(walletLabel(-25, false)).toMatch(/can't book until you top up/i);
  });

  /**
   * A stream that has silently died leaves a confident stale number with nothing to say so.
   * That is the same class of defect the server-side silence detector was added to fix.
   */
  it("never claims a polled figure is live", () => {
    expect(walletLabel(472, false, "degraded")).toMatch(/checked every 30 seconds/i);
    expect(walletLabel(472, false, "live")).not.toMatch(/checked every/i);
    // The suffix reaches every arm, not just the healthy one.
    expect(walletLabel(0, false, "degraded")).toMatch(/checked every 30 seconds/i);
    expect(walletLabel(12.5, false, "degraded")).toMatch(/checked every 30 seconds/i);
  });

  /**
   * A currency symbol is not a word, and this chip's whole job is to be spoken.
   *
   * <p>
   * The spoken form has to survive the club's money symbol in BOTH directions. A screen
   * reader given "R472.00" announces the R as a letter — "R four hundred and seventy-two" —
   * which is why this label says a WORD where the visible chip shows the symbol. The word is
   * the currency's own, and it follows the club: a club on CHF hears "Swiss francs", not
   * "rand", and not the three letters.
   * </p>
   */
  it("speaks a word, whatever symbol the club has chosen", () => {
    const spokenFor: [string, string][] = [
      ["R", "472.00 rand"],
      ["CHF", "472.00 Swiss francs"],
      ["R$", "472.00 reais"],
      ["€", "472.00 euros"],
    ];
    for (const [symbol, expected] of spokenFor) {
      setClubCurrencySymbol(symbol);
      const spoken = walletLabel(472, false);
      expect(spoken, symbol).toContain(expected);
      expect(spoken, symbol).not.toContain(symbol);
      // And still not the abbreviation, which is read as two letters.
      expect(spoken, symbol).not.toMatch(/\bcr\b/);
    }
  });

  /**
   * A symbol with no name answers with no noun, and that is the right answer.
   *
   * <p>
   * `spokenCurrencyName` refuses to guess: "472.00 dollars" to a club on tenge is a lie a
   * sighted member would never be told. What is left is a bare figure inside a sentence that
   * already says what the figure is — "Wallet balance 472.00. Tap to top up." — which is
   * understandable, where a wrong currency is not.
   * </p>
   */
  it("drops the noun rather than guessing one for a symbol it cannot name", () => {
    setClubCurrencySymbol("₸"); // tenge — deliberately not in the spoken table
    const spoken = walletLabel(472, false);
    expect(spoken).toContain("472.00");
    expect(spoken).not.toContain("₸");
    expect(spoken).not.toMatch(/rand|dollar|euro/i);
  });

  it("keeps the two-argument form every existing caller uses", () => {
    // Additive: a dozen call sites and this file's own tests pass two arguments, and the
    // honesty suffix defaults to saying nothing.
    expect(walletLabel(472, false)).toBe("Wallet balance 472.00 rand. Tap to top up.");
  });
});
