import { afterEach, describe, expect, it } from "vitest";
import { walletLabel, walletTone } from "./balance";
import { emptyWalletSentence } from "./gridCopy";
import { walletNotice } from "./gridExplain";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "./currency";

afterEach(resetClubCurrencySymbol);

/**
 * A member who owes the club money must be told so, in words, on every surface.
 *
 * <p>
 * <b>"Emptier than empty" was classified correctly and then described as zero.</b>
 * `walletTone` deliberately answers <code>"zero"</code> for a negative balance, and that
 * classification is right — the settlement model posts a late reversal as two NEW rows rather
 * than an edit, so a balance genuinely goes below zero, and a member at −25.00 credits can book
 * exactly as much as a member at 0.00, which is nothing. What was wrong is that both of them
 * were then handed the same sentence. The chip's accessible name said <i>"Wallet balance 0
 * credits"</i> and the grid's banner said <i>"You have no credits"</i>, so the one number that
 * changes what the member has to do about it — the size of the hole — was stated nowhere at
 * all, to anybody, and for a screen-reader user it was actively contradicted.
 * </p>
 *
 * <p>
 * The cost is not cosmetic. A member told they have nothing tops up the price of a slot; a
 * member told they are 25.00 credits overdrawn knows that will not be enough. The visible chip
 * has always shown the minus sign — it renders <code>formatCredits</code> unaltered — so the
 * defect fell entirely on the spoken label and the banner, which is the audience least able to
 * cross-check it against anything else on the screen.
 * </p>
 *
 * <p>
 * <b>The rounding case is settled the same way it is settled everywhere else in this product:
 * by the number the member can SEE.</b> −0.001 renders as "0.00" and is not a debt anybody can
 * act on, so it says "no credits" rather than inventing a debt of 0.00; and it must never reach
 * a sentence as <code>(-0.001).toFixed(2)</code>, which is the string "-0.00". That negated
 * zero is the same trap `formatMoney` and `formatSignedCredits` each carry a guard for.
 * </p>
 */

describe("a balance below zero is a debt, not an absence", () => {
  it("keeps classifying a negative balance as zero — the tone was never the defect", () => {
    // Guards the fix from being made in the wrong place. `walletTone` is the one rule, and
    // "you cannot book" is as true at −25.00 as it is at 0.00.
    expect(walletTone(-25)).toBe("zero");
    expect(walletTone(-0.001)).toBe("zero");
  });

  it("speaks the debt instead of announcing a balance of zero", () => {
    const spoken = walletLabel(-25, false);
    expect(spoken).toContain("25.00 credits");
    expect(spoken).toMatch(/overdrawn/);
    // The sentence that was there: a flat, false "0 credits" for a member 25.00 in the hole.
    expect(spoken).not.toMatch(/balance 0(\.00)? credits/);
    // ...and the consequence still gets said, because it is still true.
    expect(spoken).toMatch(/can't book until you top up/);
    expect(spoken).toMatch(/Tap to top up/);
  });

  it("says a word rather than a sign, since this label exists to be read out loud", () => {
    // "−25.00" is announced as "twenty five" by some screen readers and as "dash twenty five"
    // by others; neither is the fact. The direction is carried by a word for the same reason
    // this label spells out "credits" instead of reusing the "cr" abbreviation.
    const spoken = walletLabel(-25, false);
    expect(spoken).not.toContain("-25");
    expect(spoken).not.toContain("−25");
  });

  it("still tells an empty wallet it is empty, rather than inventing a debt of zero", () => {
    expect(walletLabel(0, false)).toContain("0.00 credits");
    expect(walletLabel(0, false)).not.toMatch(/overdrawn/);
    // The negated-zero trap: -0.001 rounds to "0.00" on screen and `toFixed(2)` alone would
    // spell it "-0.00 credits".
    expect(walletLabel(-0.001, false)).not.toContain("-0.00");
    expect(walletLabel(-0.001, false)).not.toMatch(/overdrawn/);
  });

  it("carries the honesty suffix into the debt arm too", () => {
    // A stale figure is worse when it is a debt: the member is being told a number they are
    // about to act on. The suffix reaches every arm or it reaches none.
    expect(walletLabel(-25, false, "degraded")).toMatch(/checked every 30 seconds/i);
    expect(walletLabel(-25, false, "live")).not.toMatch(/checked every/i);
  });

  /**
   * The setup value varied on purpose: the SIZE of the debt, which ought not to change
   * anything. A single fixture at −25.00 would pass just as well against a sentence that
   * hard-coded "25.00", and the smallest debt the member can see is the one most likely to be
   * swallowed by a rounding guard written a hair too wide.
   */
  it.each([[-0.01, "0.01"], [-25, "25.00"], [-1234.56, "1234.56"], [-0.005, "0.01"]])(
    "states the size of the hole at %s, not just that there is one",
    (balance, spokenMagnitude) => {
      const spoken = walletLabel(balance, false);
      expect(spoken).toBe(`Wallet balance ${spokenMagnitude} credits overdrawn. You can't book until you top up. Tap to top up.`);
    },
  );

  it("speaks credits whatever money symbol the club has chosen, in the debt arm too", () => {
    // The other setup value that ought not to matter. A debt is a debt in credits: at the
    // shipped 1.6 rate, a member 25.00 credits overdrawn does not owe 25 rand, and this label
    // is spoken, where a bare "R" is announced as a letter.
    for (const symbol of ["R", "CHF", "R$", "€"]) {
      setClubCurrencySymbol(symbol);
      const spoken = walletLabel(-25, false);
      expect(spoken, symbol).toContain("25.00 credits overdrawn");
      expect(spoken, symbol).not.toContain(symbol);
    }
  });

  it("does not let a debt leak into the arms that read a balance that has not landed", () => {
    // `null` is UNKNOWN, and unknown is never a debt.
    expect(walletLabel(null, true)).toBe("Wallet balance, loading");
    expect(walletLabel(null, false)).toBe("Wallet balance unavailable");
  });
});

describe("the booking grid's banner can state a debt", () => {
  it("names what is owed instead of claiming there is nothing there", () => {
    const sentence = emptyWalletSentence(-25, 50);
    expect(sentence).toContain("25.00 cr");
    expect(sentence).toMatch(/owe/);
    expect(sentence).not.toMatch(/You have no credits/);
    // The slice price is still named — it is the other half of what the member has to work out.
    expect(sentence).toContain("A slot here costs 50.00 cr.");
  });

  it("keeps the empty-wallet sentence for a wallet that is genuinely empty", () => {
    expect(emptyWalletSentence(0, 50)).toContain("You have no credits, so you can't book yet.");
    expect(emptyWalletSentence(0, 50)).not.toMatch(/owe/);
    // Rounds to zero, so it is not a debt the member could see or act on.
    expect(emptyWalletSentence(-0.001, 50)).not.toMatch(/owe/);
    expect(emptyWalletSentence(-0.001, 50)).not.toContain("-0.00");
  });

  it("omits the price clause when the day has no price to name, in both arms", () => {
    // Both halves of every conditional: the clause is dropped, never replaced with a kindness.
    expect(emptyWalletSentence(-25, null)).not.toMatch(/A slot here costs/);
    expect(emptyWalletSentence(0, null)).not.toMatch(/A slot here costs/);
  });

  /**
   * The varied setup value here is the slice price, which the debt clause must not be reading
   * from. The old signature took the price in the argument slot the balance now occupies, so
   * a sentence that had simply been re-pointed at the wrong one of the two numbers would
   * still look right with a single fixture where they happened to differ by a sign.
   */
  it.each([[-25, 50, "You owe 25.00 cr, so you can't book yet. A slot here costs 50.00 cr."],
           [-25, 12.5, "You owe 25.00 cr, so you can't book yet. A slot here costs 12.50 cr."],
           [-7.5, 200, "You owe 7.50 cr, so you can't book yet. A slot here costs 200.00 cr."]])(
    "keeps the debt and the price apart at %s against %s",
    (balance, price, expected) => {
      expect(emptyWalletSentence(balance, price)).toBe(expected);
    },
  );

  it("reaches the grid through the notice the grid actually renders", () => {
    // The caller had the balance in its hand and dropped it, which is what made the banner
    // structurally incapable of saying this. Asserted through `walletNotice` so the wiring is
    // covered and not just the copy function.
    expect(walletNotice(-25, null)?.title).toMatch(/owe/);
    expect(walletNotice(-25, null)?.id).toBe("wallet");
    expect(walletNotice(0, null)?.title).toMatch(/You have no credits/);
  });
});
