import { afterEach, describe, expect, it } from "vitest";
import { walletLabel, walletTone } from "./balance";
import { emptyWalletSentence } from "./gridCopy";
import { walletNotice } from "./gridExplain";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "./currency";

afterEach(resetClubCurrencySymbol);

/**
 * A member who owes the club minutes must be told so, in words, on every surface.
 *
 * <p>
 * <b>"Emptier than empty" was classified correctly and then described as zero.</b>
 * `walletTone` deliberately answers <code>"zero"</code> for a negative balance — a late reversal
 * posts NEW rows, so a balance genuinely goes below zero, and a member 25 minutes overdrawn can
 * book exactly as much as an empty one, which is nothing. What was wrong is that both were handed
 * the same sentence, so the size of the hole — the one number that changes what the member has to
 * do — was stated nowhere, and for a screen-reader user it was contradicted.
 * </p>
 *
 * <p>
 * <b>Whole minutes (P13).</b> The ledger holds whole minutes; a fraction a caller let through is
 * truncated the way `<Minutes>` paints it, so −0.5 is not a debt anybody could see or act on, and
 * no sentence ever says "minus zero".
 * </p>
 */

describe("a balance below zero is a debt, not an absence", () => {
  it("keeps classifying a negative balance as zero — the tone was never the defect", () => {
    expect(walletTone(-25)).toBe("zero");
    expect(walletTone(-0.5)).toBe("zero");
  });

  it("speaks the debt instead of announcing a balance of zero", () => {
    const spoken = walletLabel(-25, false);
    expect(spoken).toContain("25 minutes overdrawn");
    expect(spoken).not.toMatch(/balance 0 minutes/);
    expect(spoken).toMatch(/can't book until you buy minutes/);
    expect(spoken).toMatch(/Tap to buy minutes/);
  });

  it("says a word rather than a sign, since this label exists to be read out loud", () => {
    const spoken = walletLabel(-25, false);
    expect(spoken).not.toContain("-25");
    expect(spoken).not.toContain("−25");
    expect(spoken).not.toMatch(/minus/);
  });

  it("still tells an empty wallet it is empty, rather than inventing a debt of zero", () => {
    expect(walletLabel(0, false)).toContain("0 minutes");
    expect(walletLabel(0, false)).not.toMatch(/overdrawn/);
    expect(walletLabel(-0.5, false)).not.toMatch(/overdrawn|minus|−0|-0/);
  });

  it("carries the honesty suffix into the debt arm too", () => {
    expect(walletLabel(-25, false, "degraded")).toMatch(/checked every 30 seconds/i);
    expect(walletLabel(-25, false, "live")).not.toMatch(/checked every/i);
  });

  /** The SIZE of the debt varied on purpose: a single fixture would pass a hard-coded "25". */
  it.each([[-1, "1 minute"], [-25, "25 minutes"], [-90, "1 hour 30 minutes"], [-1500, "1 day 1 hour"]])(
    "states the size of the hole at %s, not just that there is one",
    (balance, spokenMagnitude) => {
      expect(walletLabel(balance, false)).toBe(`Wallet balance ${spokenMagnitude} overdrawn. You can't book until you buy minutes. Tap to buy minutes.`);
    },
  );

  it("speaks minutes whatever money symbol the club has chosen, in the debt arm too", () => {
    for (const symbol of ["R", "CHF", "R$", "€"]) {
      setClubCurrencySymbol(symbol);
      const spoken = walletLabel(-25, false);
      expect(spoken, symbol).toContain("25 minutes overdrawn");
      expect(spoken, symbol).not.toContain(symbol);
    }
  });

  it("does not let a debt leak into the arms that read a balance that has not landed", () => {
    expect(walletLabel(null, true)).toBe("Wallet balance, loading");
    expect(walletLabel(null, false)).toBe("Wallet balance unavailable");
  });
});

describe("the booking grid's banner can state a debt", () => {
  it("names what is owed instead of claiming there is nothing there", () => {
    const sentence = emptyWalletSentence(-25, 45);
    expect(sentence).toContain("25 minutes");
    expect(sentence).toMatch(/owe/);
    expect(sentence).not.toMatch(/You have no minutes/);
    // What a slot takes is still named — it is the other half of what the member has to work out.
    expect(sentence).toContain("A slot here takes 45 minutes.");
    // Whole minutes, never a decimal, and never the old unit (P13).
    expect(sentence).not.toMatch(/\d\.\d|credit|\bcr\b/);
  });

  it("keeps the empty-wallet sentence for a wallet that is genuinely empty", () => {
    expect(emptyWalletSentence(0, 45)).toContain("You have no minutes left, so you can't book yet.");
    expect(emptyWalletSentence(0, 45)).not.toMatch(/owe/);
    // A fraction of a minute is not a debt the member could see or act on.
    expect(emptyWalletSentence(-0.4, 45)).not.toMatch(/owe/);
    expect(emptyWalletSentence(-0.4, 45)).not.toContain("−0");
  });

  it("omits the slot clause when the day has no slot length to name, in both arms", () => {
    // Both halves of every conditional: the clause is dropped, never replaced with a kindness.
    expect(emptyWalletSentence(-25, null)).not.toMatch(/A slot here/);
    expect(emptyWalletSentence(0, null)).not.toMatch(/A slot here/);
  });

  /**
   * The varied setup value here is the slot length, which the debt clause must not be reading
   * from — a sentence re-pointed at the wrong one of the two numbers would still look right
   * with a single fixture.
   */
  it.each([[-25, 45, "You owe 25 minutes, so you can't book yet. A slot here takes 45 minutes."],
           [-90, 15, "You owe 1 hour 30 minutes, so you can't book yet. A slot here takes 15 minutes."],
           [-1500, 60, "You owe 1 day 1 hour, so you can't book yet. A slot here takes 1 hour."]])(
    "keeps the debt and the slot apart at %s against %s",
    (balance, slice, expected) => {
      expect(emptyWalletSentence(balance, slice)).toBe(expected);
    },
  );

  it("reaches the grid through the notice the grid actually renders, pointing at the package shelf", () => {
    // The caller had the balance in its hand and dropped it, which is what made the banner
    // structurally incapable of saying this. Asserted through `walletNotice` so the wiring is
    // covered and not just the copy function.
    expect(walletNotice(-25, null)?.title).toMatch(/owe/);
    expect(walletNotice(-25, null)?.id).toBe("wallet");
    expect(walletNotice(0, null)?.title).toMatch(/You have no minutes left/);
    expect(walletNotice(0, null)?.action).toEqual({ label: "Buy minutes", to: "/wallet/buy" });
  });
});

describe("a short wallet — some minutes, but fewer than a slot takes (P13)", () => {
  const day = (sliceMinutes: number) => ({ sliceMinutes }) as Parameters<typeof walletNotice>[1];

  it("says so before the member picks, with the way to buy a package", () => {
    const n = walletNotice(10, day(15));
    expect(n?.id).toBe("wallet-short");
    expect(n?.title).toBe("You have 10 minutes left and a slot here takes 15 minutes. Buy a package to book.");
    expect(n?.action).toEqual({ label: "Buy minutes", to: "/wallet/buy" });
  });

  it("says nothing when one slot is affordable, nothing for an admin, and nothing for an unknown day", () => {
    expect(walletNotice(15, day(15))).toBeNull();
    expect(walletNotice(10, day(15), true)).toBeNull();
    expect(walletNotice(10, null)).toBeNull();
    expect(walletNotice(null, day(15))).toBeNull();
  });
});
