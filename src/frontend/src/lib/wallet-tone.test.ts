import { describe, expect, it } from "vitest";
import { LOW_BALANCE_CREDITS, walletHref, walletLabel, walletTone } from "./balance";
import { BALANCE_SENTENCE, BALANCE_TONE, TOP_UP_LABEL } from "./walletCopy";
import { walletNotice } from "./gridExplain";

/**
 * Zero, low and fine, decided ONCE.
 *
 * <p>
 * <b>Three lanes wrote this rule and they did not agree.</b> The header chip asked
 * `balance <= 0`; the wallet page asked `balance < 0.005` through `balanceLevel`; the grid's
 * empty-wallet banner asked `balance > 0`. At a balance of 0.004 — which renders as "R0.00"
 * and buys nothing, because a slot costs fifty — a member saw a green chip saying R0.00, a red wallet
 * card saying they could not book, and a grid with no banner on it at all. Every one of those
 * three screens was written by somebody who had thought about the rounding case; they simply
 * each thought about it separately.
 * </p>
 *
 * <p>
 * `walletTone` is now the only place the question is asked, and this file is what keeps it
 * that way. The rule is the documented one, because it is the one that is right: `< 0.005`
 * rather than `<= 0`, so what the member is told matches the two decimal places they can see.
 * </p>
 */

describe("one rule, asked in three places", () => {
  it.each([
    [0, "zero"],
    [-25, "zero"],
    [0.004, "zero"],
    [0.01, "low"],
    [49.99, "low"],
    [LOW_BALANCE_CREDITS, "fine"],
    [100_000, "fine"],
  ])("reads %s as %s", (balance, tone) => {
    expect(walletTone(balance)).toBe(tone);
  });

  it("reads an absent balance as nothing to warn about", () => {
    // `null` is UNKNOWN — a wallet read that has not landed — and a grid that shouted "your
    // wallet is empty" at a slow network would be wrong more often than right.
    expect(walletTone(null)).toBe("fine");
  });

  /**
   * The case the three definitions disagreed on, asserted on all three surfaces at once.
   * A balance of 0.004 is not `<= 0` and it is not spendable either.
   */
  it("agrees about a balance that rounds to zero, on the chip, the page and the grid", () => {
    expect((0.004).toFixed(2)).toBe("0.00");

    // The chip: tone, destination and the sentence a screen reader hears.
    expect(walletTone(0.004)).toBe("zero");
    expect(walletHref(0.004)).toBe("/wallet/topup");
    expect(walletLabel(0.004, false)).toMatch(/can't book until you top up/);

    // The page: every copy table answers to the same key.
    expect(BALANCE_SENTENCE[walletTone(0.004)]).toMatch(/can't book a court until you top up/);
    expect(BALANCE_TONE[walletTone(0.004)].fill).toBe("bg-danger-soft");
    expect(TOP_UP_LABEL[walletTone(0.004)]).toBe("Top up to start booking");

    // The grid: the banner is there, and it is there for the same reason.
    expect(walletNotice(0.004, null)?.id).toBe("wallet");
  });

  it("puts nobody on the top-up screen who has money to spend", () => {
    expect(walletHref(0.01)).toBe("/wallet");
    expect(walletHref(500)).toBe("/wallet");
    // Unknown is not zero. The chip that does not know yet must not send a member to a form.
    expect(walletHref(null)).toBe("/wallet");
    expect(walletNotice(0.01, null)).toBeNull();
    expect(walletNotice(null, null)).toBeNull();
  });
});
