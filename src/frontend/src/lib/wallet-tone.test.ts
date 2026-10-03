import { describe, expect, it } from "vitest";
import { walletHref, walletLabel } from "./walletLabel";
import { LOW_BALANCE_MINUTES, walletTone } from "./walletTone";
import { BALANCE_SENTENCE, BALANCE_TONE, TOP_UP_LABEL } from "./walletCopy";
import { walletNotice } from "./gridExplain";

/**
 * Zero, low and fine, decided ONCE (P13: in whole minutes).
 *
 * <p>
 * <b>Three lanes once wrote this rule and they did not agree</b>, so a member saw a green chip, a
 * red wallet card and a grid with no banner for the same balance. `walletTone` is the only place
 * the question is asked, and this file keeps it that way: under one whole minute is empty, under
 * {@link LOW_BALANCE_MINUTES} is low.
 * </p>
 */

describe("one rule, asked in three places", () => {
  it.each([
    [0, "zero"],
    [-25, "zero"],
    [0.9, "zero"],
    [1, "low"],
    [LOW_BALANCE_MINUTES - 1, "low"],
    [LOW_BALANCE_MINUTES, "fine"],
    [100_000, "fine"],
  ])("reads %s as %s", (balance, tone) => {
    expect(walletTone(balance)).toBe(tone);
  });

  it("reads an absent balance as nothing to warn about", () => {
    // `null` is UNKNOWN — a wallet read that has not landed — never an empty wallet.
    expect(walletTone(null)).toBe("fine");
  });

  it("agrees about an empty wallet on the chip, the page and the grid", () => {
    expect(walletTone(0)).toBe("zero");
    expect(walletHref(0)).toBe("/wallet/buy");
    expect(walletLabel(0, false)).toMatch(/can't book until you buy minutes/);
    expect(BALANCE_SENTENCE[walletTone(0)]).toMatch(/can't book a court until you buy minutes/);
    expect(BALANCE_TONE[walletTone(0)].fill).toBe("bg-danger-soft");
    expect(TOP_UP_LABEL[walletTone(0)]).toBe("Buy minutes to start booking");
    expect(walletNotice(0, null)?.id).toBe("wallet");
  });

  it("puts nobody on the buy screen who has minutes to spend", () => {
    expect(walletHref(1)).toBe("/wallet");
    expect(walletHref(500)).toBe("/wallet");
    expect(walletHref(null)).toBe("/wallet");
    expect(walletNotice(null, null)).toBeNull();
  });
});
