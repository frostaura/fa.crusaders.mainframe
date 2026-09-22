import { afterEach, describe, expect, it } from "vitest";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "./currency";
import { walletLabel } from "./balance";
import { BALANCE_SENTENCE, creditArrivedSentence, creditLeftSentence } from "./walletCopy";

afterEach(resetClubCurrencySymbol);

/**
 * The wallet's words, under the owner's ruling that every amount is written with the club's
 * own symbol in front of it.
 *
 * <p>
 * <b>Two different jobs, and they must not use the same formatter.</b> The wallet card and the
 * toast are READ, so they carry <code>formatMoney</code> — "R240.00". The chip's
 * <code>aria-label</code> is HEARD and nothing else: it REPLACES the chip's contents as the
 * accessible name, so a symbol in it is announced as a letter. "cr" had exactly this defect,
 * which is why the label always spelt "credits" where the chip showed "cr", and a bare "R" is
 * the same defect wearing a different hat. The label therefore carries
 * <code>spokenMoney</code> — "240.00 rand" — and this file is what keeps the two apart.
 * </p>
 */
describe("the wallet chip's accessible name", () => {
  it("is spoken as a word, never as the symbol", () => {
    // The chip SHOWS "R472.00". Its name SAYS "472.00 rand", because a screen reader handed
    // the symbol announces the letter R.
    expect(walletLabel(472, false)).toBe("Wallet balance 472.00 rand. Tap to top up.");
    expect(walletLabel(472, false)).not.toContain("R472");
  });

  it("carries no 'cr' and no 'credits' in any arm", () => {
    for (const balance of [0, 0.004, 12.5, 472, -25]) {
      for (const state of ["live", "degraded"] as const) {
        const label = walletLabel(balance, false, state);
        expect(label).not.toMatch(/\bcr\b/);
        expect(label).not.toMatch(/credits?/i);
      }
    }
  });

  it("keeps zero its own state, and still says what it stops", () => {
    // Zero is not "running low": it is a stop, and the sentence names the stop and the fix.
    const label = walletLabel(0, false);
    expect(label).toContain("0.00 rand");
    expect(label).toMatch(/can't book until you top up/);
    expect(label).not.toMatch(/running low/i);
  });

  it("says a negative balance as a minus, not as a dash a reader skips", () => {
    // A late reversal may take a balance below zero — settlement-model, in so many words.
    const label = walletLabel(-25, false);
    expect(label).toContain("−25.00 rand");
    expect(label).toMatch(/can't book until you top up/);
  });

  it("still warns about a low balance, in the same breath as the figure", () => {
    expect(walletLabel(12.5, false)).toBe("Wallet balance 12.50 rand, running low. Tap to top up.");
  });

  it("speaks a very large balance without losing the noun", () => {
    expect(walletLabel(1_234_567.891, false)).toContain("1234567.89 rand");
  });

  it("follows the club's own currency into its own word", () => {
    setClubCurrencySymbol("CHF");
    expect(walletLabel(472, false)).toBe("Wallet balance 472.00 Swiss francs. Tap to top up.");
  });

  it("drops the noun rather than inventing one, and the sentence still says what the number is", () => {
    // A club on a symbol this product cannot name gets a bare figure inside a sentence that
    // names it — "Wallet balance 472.00" — never "472.00 dollars" at a club on tenge.
    setClubCurrencySymbol("₸");
    expect(walletLabel(472, false)).toBe("Wallet balance 472.00. Tap to top up.");
  });

  it("behaves exactly as the default when the club has said nothing usable", () => {
    setClubCurrencySymbol(undefined);
    const absent = walletLabel(472, false);
    resetClubCurrencySymbol();
    expect(absent).toBe(walletLabel(472, false));
    expect(absent).toContain("rand");
  });

  it("keeps the three reads apart — loading, unavailable and empty", () => {
    // An empty wallet is not a failed read, and a failed read is not a slow one.
    expect(walletLabel(null, true)).toBe("Wallet balance, loading");
    expect(walletLabel(null, false)).toBe("Wallet balance unavailable");
    expect(walletLabel(0, false)).toMatch(/can't book until you top up/);
  });

  it("never claims a figure is live when a 30-second poll is standing in for the stream", () => {
    expect(walletLabel(472, false, "degraded")).toMatch(/checked every 30 seconds/);
    expect(walletLabel(0, false, "degraded")).toMatch(/checked every 30 seconds/);
    expect(walletLabel(472, false, "live")).not.toMatch(/checked every/);
  });
});

/**
 * The wallet's READ sentences. These are rendered, so they carry the symbol — and the
 * conversion the symbol hides is not theirs to explain: nothing on this page spans both legs.
 */
describe("what the wallet card says under the figure", () => {
  it("tells a comfortable member what the balance buys, and that a top-up buys more than it costs", () => {
    // The old sentence — "Credits are what court time is bought with. Top up in rand and the
    // club converts at your member rate." — was the conversion boundary in miniature, and with
    // one symbol on both legs "converts at your member rate" names a rate nothing shows.
    expect(BALANCE_SENTENCE.fine).not.toMatch(/credits?/i);
    expect(BALANCE_SENTENCE.fine).toMatch(/court time/i);
    // The bonus has to survive: a member who is never told it exists has no reason to top up
    // in the block the club actually sells.
    expect(BALANCE_SENTENCE.fine).toMatch(/more than you pay|adds more/i);
  });

  it("leaves no arm of the card talking in credits", () => {
    for (const sentence of Object.values(BALANCE_SENTENCE)) {
      expect(sentence).not.toMatch(/credits?/i);
      expect(sentence).not.toMatch(/\bcr\b/);
    }
  });
});

describe("the sentence a member gets when money moves while they watch", () => {
  it("names the amount with the club's symbol in front of it", () => {
    expect(creditArrivedSentence(200, "AdminAdjustment", "Sipho at the desk"))
      .toBe("Sipho at the desk added R200.00 to your wallet.");
    expect(creditArrivedSentence(200, "AdminAdjustment", null))
      .toBe("The club added R200.00 to your wallet.");
    expect(creditArrivedSentence(200, "TopUp", null))
      .toBe("Your top-up landed: R200.00 is in your wallet.");
    expect(creditArrivedSentence(200, null, null))
      .toBe("Your wallet went up by R200.00.");
  });

  it("says the other direction the same way, and never as a failure", () => {
    expect(creditLeftSentence(50, "BookingCharge")).toBe("R50.00 went on a court booking.");
    expect(creditLeftSentence(50, null)).toBe("R50.00 left your wallet.");
    expect(creditLeftSentence(50, "NoShowPenalty")).toBe("R50.00 went on a no-show charge.");
  });

  it("carries no 'credits' in any arm, in either direction", () => {
    const types = [
      "TopUp", "AdminAdjustment", "CancellationRefund", "PaymentReversal",
      "BookingCharge", "LightsPurchase", "NoShowPenalty", "LateCancellationPenalty",
    ] as const;
    for (const type of types) {
      expect(creditArrivedSentence(200, type, null)).not.toMatch(/credits?/i);
      expect(creditLeftSentence(50, type)).not.toMatch(/credits?/i);
    }
  });

  it("follows the club's own symbol, and a multi-character one does not crowd the sentence", () => {
    setClubCurrencySymbol("CHF");
    expect(creditArrivedSentence(200, "TopUp", null))
      .toBe("Your top-up landed: CHF200.00 is in your wallet.");
    expect(creditLeftSentence(50, "BookingCharge")).toBe("CHF50.00 went on a court booking.");
  });

  it("states a zero movement as a figure rather than as nothing at all", () => {
    // A rounding-sized movement is still a row on the ledger, and the sentence has to add up
    // against it. Zero has no direction, so it gets no sign.
    expect(creditArrivedSentence(0, null, null)).toBe("Your wallet went up by R0.00.");
  });
});
