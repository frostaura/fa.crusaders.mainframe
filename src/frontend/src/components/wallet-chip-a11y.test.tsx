import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { walletLabel } from "../lib/balance";
import { LOW_BALANCE_MINUTES } from "../lib/walletTone";
import { MinutesChip } from "./shell/MinutesChip";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "../lib/currency";

afterEach(resetClubCurrencySymbol);

/**
 * The wallet chip's accessible name (P13: whole minutes).
 *
 * <p>
 * It was <code>aria-label="Wallet balance"</code>, which REPLACES an element's contents as its
 * name, so a screen reader announced "Wallet balance, link" and the number — the only thing in
 * the chrome that says whether a member can afford to book — was never read out. The name now
 * carries the figure in the long form ("7 hours 52 minutes"), never the compact "7 h 52 min"
 * the eye reads: "h" and "min" are spelled as letters.
 * </p>
 */
describe("the wallet chip says the balance out loud", () => {
  it("names the amount in words, not just the concept", () => {
    expect(walletLabel(472, false)).toContain("7 hours 52 minutes");
  });

  it("never says the compact units, a decimal or the old unit", () => {
    const spoken = walletLabel(472, false);
    expect(spoken).not.toMatch(/\bh\b|\bmin\b|\bcr\b|credit|\.\d/);
  });

  it("announces the low-balance state that is otherwise only a colour", () => {
    expect(walletLabel(45, false)).toContain("45 minutes");
    expect(walletLabel(45, false)).toMatch(/running low/i);
  });

  it("does not cry wolf at the threshold", () => {
    expect(walletLabel(LOW_BALANCE_MINUTES, false)).not.toMatch(/running low/i);
    expect(walletLabel(LOW_BALANCE_MINUTES - 1, false)).toMatch(/running low/i);
  });

  it("distinguishes 'still loading' from 'could not be read'", () => {
    expect(walletLabel(null, true)).toMatch(/loading/i);
    expect(walletLabel(null, false)).toMatch(/unavailable/i);
    expect(walletLabel(null, false)).not.toMatch(/loading/i);
  });

  it("says what pressing it does, since the chip carries no other text", () => {
    expect(walletLabel(472, false)).toMatch(/tap to buy minutes/i);
  });

  it("reads a zero balance as a number rather than falling through to unavailable", () => {
    expect(walletLabel(0, false)).toContain("0 minutes");
    expect(walletLabel(0, false)).not.toMatch(/unavailable/i);
  });

  /** Empty is not low: three states, three sentences, three looks. */
  it("tells an empty wallet the truth instead of calling it low", () => {
    expect(walletLabel(0, false)).not.toMatch(/running low/i);
    expect(walletLabel(0, false)).toMatch(/can't book until you buy minutes/i);
    expect(walletLabel(1, false)).toMatch(/running low/i);
    // A fraction a caller let through is nothing to book with: truncated, like `<Minutes>` paints it.
    expect(walletLabel(0.9, false)).toMatch(/can't book until you buy minutes/i);
    expect(walletLabel(-25, false)).toMatch(/can't book until you buy minutes/i);
  });

  it("never claims a polled figure is live", () => {
    expect(walletLabel(472, false, "degraded")).toMatch(/checked every 30 seconds/i);
    expect(walletLabel(472, false, "live")).not.toMatch(/checked every/i);
    expect(walletLabel(0, false, "degraded")).toMatch(/checked every 30 seconds/i);
    expect(walletLabel(45, false, "degraded")).toMatch(/checked every 30 seconds/i);
  });

  /** Minutes are not money: whatever symbol the club chose for rand never reaches the balance. */
  it("speaks minutes, whatever symbol the club has chosen", () => {
    for (const symbol of ["R", "CHF", "R$", "€"]) {
      setClubCurrencySymbol(symbol);
      const spoken = walletLabel(472, false);
      expect(spoken, symbol).toContain("7 hours 52 minutes");
      expect(spoken, symbol).not.toContain(symbol);
    }
  });

  it("keeps the two-argument form every existing caller uses", () => {
    expect(walletLabel(472, false)).toBe("Wallet balance 7 hours 52 minutes. Tap to buy minutes.");
  });
});

/**
 * The chip itself (P13 renamed it `MinutesChip`). The label above is only worth anything if the
 * chip actually wears it, goes where it says, and shows the figure whole.
 */
describe("the minutes chip in the top bar", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  function renderChip(balance: number) {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_minutes: balance, entries: [], total_entries: 0, offset: 0, limit: 100 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
    ]);
    return renderPage(<MinutesChip />);
  }

  it("wears the spoken balance as its name and shows the figure whole, in minutes", async () => {
    renderChip(472);
    const chip = await screen.findByRole("link", { name: /7 hours 52 minutes/ }, { timeout: 5_000 });
    expect(chip).toHaveAttribute("href", "/wallet");
    await waitFor(() => expect(chip).toHaveTextContent("7 h 52 min"));
    expect(chip.textContent).not.toMatch(/\.\d|cr\b/);
    expect(chip.querySelector("span[aria-hidden]")!.className).not.toContain("truncate");
  });

  it("goes straight to the buy page when there is nothing in the wallet", async () => {
    renderChip(0);
    const chip = await screen.findByRole("link", { name: /can't book until you buy minutes/i }, { timeout: 5_000 });
    expect(chip).toHaveAttribute("href", "/wallet/buy");
    expect(chip.className).toContain("bg-danger-soft");
    expect(chip.className).not.toContain("bg-warning-soft");
  });

  it("is amber, and says so, when running low", async () => {
    renderChip(45);
    const chip = await screen.findByRole("link", { name: /running low/i }, { timeout: 5_000 });
    expect(chip.className).toContain("bg-warning-soft");
  });
});
