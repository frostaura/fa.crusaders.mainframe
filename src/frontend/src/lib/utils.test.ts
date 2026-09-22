import { afterEach, describe, expect, it } from "vitest";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "./currency";
import { describeTopUpRate, formatMinutes, formatRate } from "./utils";

afterEach(resetClubCurrencySymbol);

/**
 * The rate, and the durations. <b>The amount formatters live in `money.test.ts`.</b>
 */
describe("the conversion rate", () => {
  it("keeps every decimal the rate column can hold, and trims the ones it cannot", () => {
    // The bug: 1.6667 shown as 1.67 is a quote the club will not honour, because the
    // ledger settles on the stored 1.6667.
    expect(formatRate(1.6667)).toBe("1.6667");
    expect(formatRate(1.6)).toBe("1.6");
    expect(formatRate(2.4)).toBe("2.4");
    expect(formatRate(2)).toBe("2");
  });

  /**
   * The conversion boundary, which is the one place the rate is still visible.
   *
   * <p>
   * A wallet and a card payment are now written with the same symbol, so "1.6 credits / R1"
   * has no units left to make sense of. The sentence names both legs instead, which is the
   * rule `currency.ts` imposes on every screen that spans the two: what leaves the card, and
   * what arrives in the wallet.
   * </p>
   */
  it("says what leaves the card and what arrives in the wallet", () => {
    expect(describeTopUpRate(1.6)).toBe("Every R1.00 you pay adds R1.60 to your wallet");
    expect(describeTopUpRate(2.4)).toBe("Every R1.00 you pay adds R2.40 to your wallet");
  });

  it("says it plainly for a club that gives no bonus at all", () => {
    // A club on 1:1 reads "adds R1.00", which is honest rather than silly. A sentence that
    // vanished at parity would leave that screen saying nothing about the rate.
    expect(describeTopUpRate(1)).toBe("Every R1.00 you pay adds R1.00 to your wallet");
  });

  it("follows the club's own currency on both legs", () => {
    setClubCurrencySymbol("CHF");
    expect(describeTopUpRate(1.6)).toBe("Every CHF1.00 you pay adds CHF1.60 to your wallet");
  });

  it("leaves no 'cr' and no 'credits' in it", () => {
    for (const rate of [1, 1.6, 2.4, 0.5]) {
      expect(describeTopUpRate(rate)).not.toMatch(/\bcr\b/);
      expect(describeTopUpRate(rate)).not.toMatch(/credits?/i);
    }
  });
});

describe("durations", () => {
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
