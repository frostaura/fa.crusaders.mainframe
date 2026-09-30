import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import WalletPage from "@/pages/Wallet";
import { walletLabel } from "@/lib/balance";
import { HELD_EXPLAINER, OWED_BACK_EXPLAINER, heldLine, owedBackLine } from "@/lib/playersCopy";
import { chipHeldTitle, creditArrivedSentence, creditLeftSentence, spendableLine } from "@/lib/walletCopy";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { CreditsChip } from "../shell/CreditsChip";

/**
 * D11 §3a — shares an organiser received are held until 48 hours after each game. The wallet
 * card says how much, until when, and what can be spent; the chip's name says it too; and a
 * wallet with nothing held says nothing about it.
 */

const UNTIL = "2026-10-02T18:45:00Z";

function wallet(over: Record<string, unknown> = {}) {
  return { balance_credits: 120, entries: [], total_entries: 0, offset: 0, limit: 100, ...over };
}

function stub(body: Record<string, unknown>) {
  stubFetch([
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
  ]);
}

beforeEach(() => {
  vi.stubGlobal("EventSource", class { close() {} } as unknown as typeof EventSource);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); });

describe("the wallet card's held line", () => {
  it("says what is held, until when, what can be spent, and why", async () => {
    stub(wallet({ held_credits: 20, spendable_credits: 100, held_until: UNTIL }));
    renderPage(<WalletPage />);
    const line = await screen.findByText(heldLine(20, UNTIL));
    expect(line.closest("[data-held-line]")).toHaveTextContent(spendableLine(100));
    expect(screen.getByText(HELD_EXPLAINER)).toBeInTheDocument();
    expect(heldLine(20, UNTIL)).toBe("20.00 cr held until Fri 2 Oct, 20:45");
    expect(spendableLine(100)).toBe("You can spend 100.00 cr");
  });

  it("says nothing when nothing is held", async () => {
    stub(wallet({ held_credits: 0, spendable_credits: 120, held_until: null }));
    renderPage(<WalletPage />);
    await screen.findByText("No movements yet");
    expect(document.querySelector("[data-held-line]")).toBeNull();
    expect(screen.queryByText(HELD_EXPLAINER)).toBeNull();
  });

  it("P11: names what is owed back to partners, and never says a negative spendable", async () => {
    stub(wallet({ balance_credits: 10, held_credits: 0, owed_back_credits: 16, spendable_credits: -6, held_until: null }));
    renderPage(<WalletPage />);
    const line = await screen.findByText(owedBackLine(16));
    const block = line.closest("[data-held-line]");
    expect(block).toHaveTextContent(spendableLine(-6));
    expect(spendableLine(-6)).toBe("You can spend 0.00 cr until 6.00 cr more comes in");
    expect(screen.getByText(OWED_BACK_EXPLAINER)).toBeInTheDocument();
    // Nothing is held, so the held sentence and its explainer stay away.
    expect(screen.queryByText(HELD_EXPLAINER)).toBeNull();
    expect(block).not.toHaveTextContent(/held/);
  });

  it("P11: held and owed back together, each with its own reason", async () => {
    stub(wallet({ balance_credits: 120, held_credits: 20, owed_back_credits: 16, spendable_credits: 84, held_until: UNTIL }));
    renderPage(<WalletPage />);
    const line = await screen.findByText(heldLine(20, UNTIL));
    const block = line.closest("[data-held-line]");
    expect(block).toHaveTextContent(spendableLine(84));
    expect(block).toHaveTextContent(owedBackLine(16));
    expect(screen.getByText(HELD_EXPLAINER)).toBeInTheDocument();
    expect(screen.getByText(OWED_BACK_EXPLAINER)).toBeInTheDocument();
  });

  it("says nothing against an API that predates held credits", async () => {
    stub(wallet());
    renderPage(<WalletPage />);
    await screen.findByText("No movements yet");
    expect(document.querySelector("[data-held-line]")).toBeNull();
  });
});

describe("the chip's name mentions what is held", () => {
  it("adds the held part in words, only when there is one", () => {
    expect(walletLabel(120, false, undefined, 20)).toBe("Wallet balance 120.00 credits, 20.00 held for partners. Tap to top up.");
    expect(walletLabel(120, false, undefined, 0)).toBe(walletLabel(120, false));
    expect(walletLabel(30, false, undefined, 20)).toContain("30.00 credits, 20.00 held for partners, running low");
    expect(walletLabel(120, false, undefined, 20, 16)).toBe(
      "Wallet balance 120.00 credits, 20.00 held for partners, 16.00 owed back to partners. Tap to top up.");
    expect(walletLabel(120, false, undefined, 0, 0)).toBe(walletLabel(120, false));
  });

  it("P11: wears what is owed back on the live chip, name and title", async () => {
    stub(wallet({ held_credits: 0, owed_back_credits: 16, spendable_credits: 104, held_until: null }));
    renderPage(<CreditsChip />);
    const chip = await screen.findByRole("link", { name: /120\.00 credits, 16\.00 owed back to partners/ }, { timeout: 5_000 });
    await waitFor(() => expect(chip).toHaveAttribute("title", "104.00 cr to spend — 120.00 cr in your wallet, 16.00 cr owed back to partners. Tap to top up."));
    expect(chipHeldTitle(0, 16)).toBe("Wallet balance — 16.00 cr owed back to partners. Tap to top up.");
    expect(chipHeldTitle(20)).toBe("Wallet balance — 20.00 cr of it held for partners. Tap to top up.");
  });

  /**
   * F1.11 — REVERSES D11 §3a's "the figure stays the whole balance". A member saw 550 on the chip
   * and was refused a 520 booking because 50 was held for a partner: the chip now shows what can
   * be spent, and its name and title say what the rest is.
   */
  it("shows what can be spent, and names the whole balance and what is held", async () => {
    stub(wallet({ held_credits: 20, spendable_credits: 100, held_until: UNTIL }));
    renderPage(<CreditsChip />);
    const chip = await screen.findByRole("link", { name: /120\.00 credits, 20\.00 held for partners/ }, { timeout: 5_000 });
    await waitFor(() => expect(chip).toHaveTextContent("100.00 cr"));
    expect(chip).not.toHaveTextContent("120.00 cr");
    expect(chip).toHaveAccessibleName("Wallet balance 100.00 credits to spend — 120.00 credits, 20.00 held for partners. Tap to top up.");
    expect(chip).toHaveAttribute("title", "100.00 cr to spend — 120.00 cr in your wallet, 20.00 cr held for partners. Tap to top up.");
  });

  it("says a member with nothing to spend cannot book, whatever the whole balance is", async () => {
    stub(wallet({ held_credits: 0, owed_back_credits: 130, spendable_credits: -10, held_until: null }));
    renderPage(<CreditsChip />);
    const chip = await screen.findByRole("link", { name: /nothing to spend/ }, { timeout: 5_000 });
    expect(chip).toHaveAccessibleName(/You can't book until you top up/);
    expect(chip).toHaveAttribute("href", "/wallet/topup");
  });

  it("keeps the plain balance when nothing is set aside (the fixture, varied)", async () => {
    stub(wallet({ held_credits: 0, owed_back_credits: 0, spendable_credits: 120, held_until: null }));
    renderPage(<CreditsChip />);
    const chip = await screen.findByRole("link", { name: walletLabel(120, false, "live") }, { timeout: 5_000 });
    await waitFor(() => expect(chip).toHaveTextContent("120.00 cr"));
  });
});

describe("the money toast names a share", () => {
  it("says a share moved, either way", () => {
    expect(creditArrivedSentence(25, "ShareTransfer", null)).toMatch(/share of a split booking/);
    expect(creditLeftSentence(25, "ShareTransfer")).toMatch(/share of a split booking/);
  });
});
