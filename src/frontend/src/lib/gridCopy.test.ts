import { afterEach, describe, expect, it } from "vitest";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "./currency";
import { emptyWalletSentence, groupRateSentence } from "./gridCopy";
import { walletNotice } from "./gridExplain";

afterEach(resetClubCurrencySymbol);

/**
 * The two grid sentences that name money, under the owner's ruling that every amount wears the
 * club's own symbol in front of it.
 *
 * <p>
 * <b>"You have no credits" is where mechanical substitution reads worst.</b> "Credits" there is
 * a NOUN the sentence leans on, not a unit bolted to a number, so swapping it for the symbol
 * produces nonsense and deleting it produces "You have no, so you can't book yet." The fix is
 * to write the sentence around the AMOUNT instead — which is also more useful, because a member
 * whose balance is 0.004 and a member whose balance is −25.00 are in the same state for
 * different reasons and only one of them is fixed by a small top-up.
 * </p>
 */
describe("the grid's empty-wallet banner", () => {
  it("states the balance rather than naming a unit", () => {
    expect(emptyWalletSentence(null)).toBe("Your balance is R0.00, so you can't book yet.");
  });

  it("names what a slot costs here, so the member knows what to top up to", () => {
    expect(emptyWalletSentence(50))
      .toBe("Your balance is R0.00, so you can't book yet. A slot here costs R50.00.");
  });

  it("carries no 'credits' and no 'cr'", () => {
    for (const cheapest of [null, 0, 50, 12.5]) {
      expect(emptyWalletSentence(cheapest)).not.toMatch(/credits?/i);
      expect(emptyWalletSentence(cheapest)).not.toMatch(/\bcr\b/);
    }
  });

  it("follows the club's own symbol on both figures at once", () => {
    setClubCurrencySymbol("CHF");
    expect(emptyWalletSentence(50))
      .toBe("Your balance is CHF0.00, so you can't book yet. A slot here costs CHF50.00.");
  });

  it("behaves exactly as the default when the club has said nothing usable", () => {
    setClubCurrencySymbol("");
    const absent = emptyWalletSentence(50);
    resetClubCurrencySymbol();
    expect(absent).toBe(emptyWalletSentence(50));
  });

  it("tells a member who OWES the club what they owe, rather than calling it zero", () => {
    // `walletTone` reads a negative balance as "zero" — the settlement model posts a late
    // reversal as two new rows and says in so many words that a balance may go negative. A
    // banner that said "R0.00" to somebody at −25.00 would understate the top-up they need by
    // the whole of what they owe.
    expect(emptyWalletSentence(50, -25))
      .toBe("Your balance is -R25.00, so you can't book yet. A slot here costs R50.00.");
  });

  it("says a balance that only rounds to zero as the zero the member can see", () => {
    expect(emptyWalletSentence(null, 0.004)).toBe("Your balance is R0.00, so you can't book yet.");
  });

  it("says a free court as free rather than hiding the clause", () => {
    // A club that has set a court to zero is a real configuration, and "costs R0.00" is the
    // honest reading of it — the banner is about the wallet, not about the court.
    expect(emptyWalletSentence(0)).toContain("A slot here costs R0.00.");
  });
});

/**
 * The sentence is only as true as what the banner hands it. `walletNotice` has the balance and
 * the sentence does not, so the pass-through is its own assertion — without one, a caller that
 * quietly stopped forwarding it would leave every empty-wallet banner saying "R0.00" to a
 * member who owes the club, with the copy test still green.
 */
describe("the banner the grid actually renders", () => {
  it("hands the member's real balance to the sentence, not a zero", () => {
    expect(walletNotice(-25, null)?.title)
      .toBe("Your balance is -R25.00, so you can't book yet.");
  });

  it("says R0.00 for a balance that only rounds to zero", () => {
    expect(walletNotice(0.004, null)?.title).toBe("Your balance is R0.00, so you can't book yet.");
  });

  it("stays silent while the wallet read has not landed", () => {
    // Three states, not two: unknown is not empty, and a slow network must not send a member
    // who has money to a top-up form.
    expect(walletNotice(null, null)).toBeNull();
    expect(walletNotice(0.01, null)).toBeNull();
  });
});

describe("the DayBar's “your rate” sentence", () => {
  it("names the group and the price with the symbol in front of it", () => {
    expect(groupRateSentence([{ name: "League members" }], 32, 45))
      .toBe("You're a league member. You pay R32.00 for 45 minutes on this court.");
  });

  it("still works for a member whose rate has no group behind it", () => {
    expect(groupRateSentence([], 50, 15))
      .toBe("This is your rate. You pay R50.00 for 15 minutes on this court.");
  });

  it("carries no unit noun of its own", () => {
    const line = groupRateSentence([{ name: "Seniors" }], 8.5, 15);
    expect(line).not.toMatch(/credits?/i);
    expect(line).toContain("R8.50");
  });

  it("follows the club's own symbol, multi-character included", () => {
    setClubCurrencySymbol("R$");
    expect(groupRateSentence([{ name: "Seniors" }], 8.5, 15))
      .toBe("You're a senior. You pay R$8.50 for 15 minutes on this court.");
  });
});
