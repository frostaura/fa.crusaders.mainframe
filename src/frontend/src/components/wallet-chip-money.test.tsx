import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { chipFigure, clubMovementSentence } from "./CreditsBadge";
import { ToastProvider, useToast } from "./Toast";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "../lib/currency";
import { spokenMoney } from "../lib/utils";

afterEach(resetClubCurrencySymbol);

/**
 * The wallet chip's own two strings, and the one announcement in the product that tells a
 * member the club moved their money.
 *
 * <p>
 * Both used to compose their own unit beside a bare <code>toFixed(2)</code> — the chip wrote
 * <code>"— cr"</code> and the sentence wrote <code>"200.00 credits"</code> — which is exactly
 * the shape `lib/currency.ts` exists to stop: six screens each remembering the unit for
 * themselves is how they end up disagreeing.
 * </p>
 */
describe("the wallet chip's figure", () => {
  /**
   * <b>Three states, three figures.</b> "— cr" covered two of them.
   *
   * <p>
   * A balance that has not arrived yet and one that could not be read are different facts:
   * the first resolves on its own and the second does not. `walletLabel` has told them apart
   * in the accessible name for a round already ("loading" against "unavailable"), while the
   * visible chip showed the same dash for both — so a sighted member watching a wallet that
   * had failed saw something indistinguishable from a wallet that was still working.
   * </p>
   */
  it("tells a balance that has not arrived from one that could not be read", () => {
    const loading = chipFigure(null, true, 0);
    const failed = chipFigure(null, false, 0);
    expect(loading).not.toBe(failed);
    // Neither may be a number, which would be a figure the chip does not have.
    expect(loading).not.toMatch(/\d/);
    expect(failed).not.toMatch(/\d/);
  });

  it("writes a known balance with the club's symbol in front of it", () => {
    expect(chipFigure(472, false, 472)).toBe("R472.00");
    setClubCurrencySymbol("CHF");
    expect(chipFigure(472, false, 472)).toBe("CHF472.00");
  });

  /**
   * The count-up is what the chip PAINTS, and the balance is only what it knows.
   *
   * <p>
   * `useCountUp` eases the figure from the old balance to the new one over 900 ms, so for
   * most of that window the two arguments disagree. Painting `balance` instead would make
   * the animation invisible; painting `displayed` when `balance` is null would paint a stale
   * number over a wallet nobody could read.
   * </p>
   */
  it("paints the eased figure rather than the settled one", () => {
    expect(chipFigure(200, false, 137.5)).toBe("R137.50");
  });

  it.each([
    [0, "R0.00"],
    [-25, "-R25.00"],
    [1234567.5, "R1234567.50"],
  ])("writes %s without inventing a unit or misplacing the sign", (value, expected) => {
    expect(chipFigure(value, false, value)).toBe(expected);
  });

  it("treats an unusable symbol exactly as the default, never as the last club's", () => {
    setClubCurrencySymbol("CHF");
    setClubCurrencySymbol(null);
    expect(chipFigure(472, false, 472)).toBe("R472.00");
  });

  it("carries no trace of the unit this product used to invent", () => {
    for (const figure of [chipFigure(null, true, 0), chipFigure(null, false, 0), chipFigure(50, false, 50)]) {
      expect(figure).not.toMatch(/\bcr\b/);
      expect(figure).not.toMatch(/credits?/i);
    }
  });
});

/**
 * The sentence a member is TOLD when the club pays them — the accessibility requirement the
 * chip's own docblock is written about, not decoration.
 *
 * <p>
 * A `NavLink`'s `aria-label` changing is not an announcement, so without this toast a blind
 * member is never told the club moved their money. That makes this the one string in the
 * product where the symbol's unspeakability costs something real, and it is why it is
 * composed twice: once to be read, once to be heard.
 * </p>
 */
describe("what a member is told when the club moves their money", () => {
  it("writes the symbol for the eye", () => {
    expect(clubMovementSentence(160)).toBe("The club added R160.00 to your wallet.");
    expect(clubMovementSentence(-50)).toBe("The club took R50.00 off your wallet.");
  });

  it("says the currency as a word for the ear", () => {
    expect(clubMovementSentence(160, spokenMoney)).toBe("The club added 160.00 rand to your wallet.");
    expect(clubMovementSentence(-50, spokenMoney)).toBe("The club took 50.00 rand off your wallet.");
  });

  /**
   * The direction is carried by the VERB, and the figure never carries a sign.
   *
   * "The club took −50.00 off your wallet" is a double negative about somebody's money.
   */
  it("never lets a minus sign reach a sentence that already says the direction", () => {
    expect(clubMovementSentence(-50)).not.toContain("-");
    expect(clubMovementSentence(-50, spokenMoney)).not.toContain("−");
  });

  it("follows the club, in both forms", () => {
    setClubCurrencySymbol("CHF");
    expect(clubMovementSentence(160)).toContain("CHF160.00");
    expect(clubMovementSentence(160, spokenMoney)).toContain("160.00 Swiss francs");
  });

  it("degrades to a bare figure rather than naming a currency it cannot", () => {
    setClubCurrencySymbol("₸"); // tenge — deliberately unnamed
    const heard = clubMovementSentence(160, spokenMoney);
    // The sentence around the number still says what the number is.
    expect(heard).toBe("The club added 160.00 to your wallet.");
  });

  it("says neither 'cr' nor 'credits', in either form", () => {
    for (const sentence of [clubMovementSentence(160), clubMovementSentence(160, spokenMoney)]) {
      expect(sentence).not.toMatch(/\bcr\b/);
      expect(sentence).not.toMatch(/credits?/i);
    }
  });
});

function Raise({ text, spokenText }: { text: string; spokenText?: string }) {
  const toast = useToast();
  return <button type="button" onClick={() => toast.push({ text, spokenText })}>Raise</button>;
}

/**
 * A toast can be read and heard differently, and this is the only kind of element where that
 * is allowed.
 *
 * <p>
 * <b>A toast is not a control.</b> WCAG 2.5.3 Label in Name binds a button, because a speech
 * user says the words they can see and a mismatch makes the control unreachable. The toast
 * carries no action of its own beyond dismissal, so there is no name for a spoken figure to
 * break — which is why the split is taken HERE and refused on the booking buttons, where the
 * amount is the visible label.
 * </p>
 */
describe("a toast's spoken form", () => {
  it("shows the symbol and announces the word", () => {
    render(
      <ToastProvider>
        <Raise text="The club added R160.00 to your wallet." spokenText="The club added 160.00 rand to your wallet." />
      </ToastProvider>,
    );
    act(() => { screen.getByRole("button", { name: "Raise" }).click(); });

    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent("The club added R160.00 to your wallet.");
    expect(toast.getAttribute("aria-label")).toBe("The club added 160.00 rand to your wallet. — dismiss");
  });

  it("falls back to the visible text when a call site says nothing", () => {
    render(<ToastProvider><Raise text="Download started." /></ToastProvider>);
    act(() => { screen.getByRole("button", { name: "Raise" }).click(); });
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Download started. — dismiss");
  });
});
