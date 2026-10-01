import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { walletLabel } from "../lib/balance";
import { CreditsChip } from "./shell/CreditsChip";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";
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

  it("says 'credits', because 'cr' is read as two letters", () => {
    expect(walletLabel(472, false)).toContain("472.00 credits");
    expect(walletLabel(472, false)).not.toMatch(/\bcr\b/);
  });

  it("announces the low-balance state that is otherwise only a colour", () => {
    expect(walletLabel(12.5, false)).toContain("12.50 credits");
    expect(walletLabel(12.5, false)).toMatch(/running low/i);
  });

  it("does not cry wolf at the threshold", () => {
    expect(walletLabel(50, false)).not.toMatch(/running low/i);
    expect(walletLabel(49.99, false)).toMatch(/running low/i);
  });

  it("distinguishes 'still loading' from 'could not be read'", () => {
    // The visible chip shows "— cr" for both, which is the same ambiguity one layer down.
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
    expect(walletLabel(0, false)).toContain("0 credits");
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
      to be about the number the member can SEE: a chip reading "0.00 cr" while the voice says
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
   * which is why this label says "credits" where the visible chip says "cr". And the figure
   * is a CREDIT balance, so a money symbol on it would not merely sound wrong, it would be
   * the wrong quantity: at the shipped 1.6 rate a member with 472 credits does not have 472
   * rand.
   * </p>
   */
  it("speaks a word, whatever symbol the club has chosen", () => {
    for (const symbol of ["R", "CHF", "R$", "€"]) {
      setClubCurrencySymbol(symbol);
      const spoken = walletLabel(472, false);
      expect(spoken, symbol).toContain("472.00 credits");
      expect(spoken, symbol).not.toContain(symbol);
      // And still not the abbreviation, which is read as two letters.
      expect(spoken, symbol).not.toMatch(/\bcr\b/);
    }
  });

  it("keeps the two-argument form every existing caller uses", () => {
    // Additive: a dozen call sites and this file's own tests pass two arguments, and the
    // honesty suffix defaults to saying nothing.
    expect(walletLabel(472, false)).toBe("Wallet balance 472.00 credits. Tap to top up.");
  });
});

/**
 * The chip itself (P2 rebuilt it as `shell/CreditsChip` on the design tokens). The label above
 * is only worth anything if the chip actually wears it, goes where it says, and shows the figure
 * whole.
 */
describe("the credits chip in the top bar", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  function renderChip(balance: number) {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_minutes: balance, entries: [], total_entries: 0, offset: 0, limit: 100 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
    ]);
    return renderPage(<CreditsChip />);
  }

  it("wears the spoken balance as its name and shows the figure whole", async () => {
    renderChip(472);
    const chip = await screen.findByRole("link", { name: /472\.00 credits/ }, { timeout: 5_000 });
    expect(chip).toHaveAttribute("href", "/wallet");
    // The figure is decoration for the name, and it is never cut short.
    await waitFor(() => expect(chip).toHaveTextContent("472.00 cr"));
    expect(chip.querySelector("span[aria-hidden]")!.className).not.toContain("truncate");
  });

  it("goes straight to top-up when there is nothing in the wallet", async () => {
    renderChip(0);
    const chip = await screen.findByRole("link", { name: /can't book until you top up/i }, { timeout: 5_000 });
    expect(chip).toHaveAttribute("href", "/wallet/topup");
    // Empty is a colour of its own — not the amber of "running low".
    expect(chip.className).toContain("bg-danger-soft");
    expect(chip.className).not.toContain("bg-warning-soft");
  });

  it("is amber, and says so, when running low", async () => {
    renderChip(12.5);
    const chip = await screen.findByRole("link", { name: /running low/i }, { timeout: 5_000 });
    expect(chip.className).toContain("bg-warning-soft");
  });
});
