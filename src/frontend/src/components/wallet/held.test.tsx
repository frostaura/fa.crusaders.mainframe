import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import WalletPage from "@/pages/Wallet";
import { walletLabel } from "@/lib/walletLabel";
import { HELD_EXPLAINER, OWED_BACK_EXPLAINER, heldLine, owedBackLine } from "@/lib/playersCopy";
import { chipHeldTitle, minutesArrivedSentence, minutesLeftSentence, heldPartsLine, spendableLine } from "@/lib/walletCopy";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { MinutesChip } from "../shell/MinutesChip";

/**
 * D11 §3a — shares an organiser received are held until 48 hours after each game. The wallet
 * card says how much, until when, and what can be spent; the chip's name says it too; and a
 * wallet with nothing held says nothing about it.
 */

const UNTIL = "2026-10-02T18:45:00Z";

function wallet(over: Record<string, unknown> = {}) {
  return { balance_minutes: 120, entries: [], total_entries: 0, offset: 0, limit: 100, ...over };
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
    stub(wallet({ held_minutes: 20, spendable_minutes: 100, held_until: UNTIL }));
    renderPage(<WalletPage />);
    const line = await screen.findByText(heldLine(20, UNTIL));
    expect(line.closest("[data-held-line]")).toHaveTextContent(spendableLine(100));
    expect(screen.getByText(HELD_EXPLAINER)).toBeInTheDocument();
    expect(heldLine(20, UNTIL)).toBe("20 minutes held until Fri 2 Oct, 20:45");
    expect(spendableLine(100)).toBe("You can spend 1 hour 40 minutes");
  });

  // F4-18 (C4) — one release date for the whole amount was wrong when two games' shares were held.
  it("explains each held part with its own release when there are two deadlines", async () => {
    const parts = [
      { minutes: 35, until: "2026-10-04T08:30:00Z" },
      { minutes: 25, until: "2026-10-02T04:45:00Z" },
    ];
    stub(wallet({ held_minutes: 60, spendable_minutes: 60, held_until: "2026-10-02T04:45:00Z", held_parts: parts }));
    renderPage(<WalletPage />);
    const line = await screen.findByText(heldLine(60, null));
    const block = line.closest("[data-held-line]")!;
    expect(block.querySelector("[data-held-parts]")).toHaveTextContent("25 minutes until Fri 2 Oct, 06:45 · 35 minutes until Sun 4 Oct, 10:30");
    expect(heldPartsLine(parts.slice(0, 1))).toBeNull();
  });

  it("says nothing when nothing is held", async () => {
    stub(wallet({ held_minutes: 0, spendable_minutes: 120, held_until: null }));
    renderPage(<WalletPage />);
    await screen.findByText("No movements yet");
    expect(document.querySelector("[data-held-line]")).toBeNull();
    expect(screen.queryByText(HELD_EXPLAINER)).toBeNull();
  });

  it("P11: names what is owed back to partners, and never says a negative spendable", async () => {
    stub(wallet({ balance_minutes: 10, held_minutes: 0, owed_back_minutes: 16, spendable_minutes: -6, held_until: null }));
    renderPage(<WalletPage />);
    const line = await screen.findByText(owedBackLine(16));
    const block = line.closest("[data-held-line]");
    expect(block).toHaveTextContent(spendableLine(-6));
    expect(spendableLine(-6)).toBe("You can spend 0 minutes until 6 minutes more comes in");
    expect(screen.getByText(OWED_BACK_EXPLAINER)).toBeInTheDocument();
    // Nothing is held, so the held sentence and its explainer stay away.
    expect(screen.queryByText(HELD_EXPLAINER)).toBeNull();
    expect(block).not.toHaveTextContent(/held/);
  });

  it("P11: held and owed back together, each with its own reason", async () => {
    stub(wallet({ balance_minutes: 120, held_minutes: 20, owed_back_minutes: 16, spendable_minutes: 84, held_until: UNTIL }));
    renderPage(<WalletPage />);
    const line = await screen.findByText(heldLine(20, UNTIL));
    const block = line.closest("[data-held-line]");
    expect(block).toHaveTextContent(spendableLine(84));
    expect(block).toHaveTextContent(owedBackLine(16));
    expect(screen.getByText(HELD_EXPLAINER)).toBeInTheDocument();
    expect(screen.getByText(OWED_BACK_EXPLAINER)).toBeInTheDocument();
  });

  it("says nothing against an API that predates held minutes", async () => {
    stub(wallet());
    renderPage(<WalletPage />);
    await screen.findByText("No movements yet");
    expect(document.querySelector("[data-held-line]")).toBeNull();
  });
});

describe("the chip's name mentions what is held", () => {
  it("adds the held part in words, only when there is one", () => {
    expect(walletLabel(120, false, undefined, 20)).toBe("Wallet balance 2 hours, 20 minutes held for partners. Tap to buy minutes.");
    expect(walletLabel(120, false, undefined, 0)).toBe(walletLabel(120, false));
    expect(walletLabel(30, false, undefined, 20)).toContain("30 minutes, 20 minutes held for partners, running low");
    expect(walletLabel(120, false, undefined, 20, 16)).toBe(
      "Wallet balance 2 hours, 20 minutes held for partners, 16 minutes owed back to partners. Tap to buy minutes.");
    expect(walletLabel(120, false, undefined, 0, 0)).toBe(walletLabel(120, false));
  });

  it("P11: wears what is owed back on the live chip, name and title", async () => {
    stub(wallet({ held_minutes: 0, owed_back_minutes: 16, spendable_minutes: 104, held_until: null }));
    renderPage(<MinutesChip />);
    const chip = await screen.findByRole("link", { name: /2 hours in your wallet, 16 minutes owed back to partners/ }, { timeout: 5_000 });
    await waitFor(() => expect(chip).toHaveAttribute("title", "1 hour 44 minutes to spend — 2 hours in your wallet, 16 minutes owed back to partners. Tap to buy minutes."));
    expect(chipHeldTitle(0, 16)).toBe("Wallet balance — 16 minutes owed back to partners. Tap to buy minutes.");
    expect(chipHeldTitle(20)).toBe("Wallet balance — 20 minutes of it held for partners. Tap to buy minutes.");
  });

  /**
   * F1.11 — REVERSES D11 §3a's "the figure stays the whole balance". A member saw 550 on the chip
   * and was refused a 520 booking because 50 was held for a partner: the chip now shows what can
   * be spent, and its name and title say what the rest is.
   */
  it("shows what can be spent, and names the whole balance and what is held", async () => {
    stub(wallet({ held_minutes: 20, spendable_minutes: 100, held_until: UNTIL }));
    renderPage(<MinutesChip />);
    const chip = await screen.findByRole("link", { name: /2 hours in your wallet, 20 minutes held for partners/ }, { timeout: 5_000 });
    await waitFor(() => expect(chip).toHaveTextContent("1 h 40 min"));
    expect(chip).not.toHaveTextContent("2 h");
    expect(chip).toHaveAccessibleName("Wallet balance 1 hour 40 minutes to spend — 2 hours in your wallet, 20 minutes held for partners. Tap to buy minutes.");
    expect(chip).toHaveAttribute("title", "1 hour 40 minutes to spend — 2 hours in your wallet, 20 minutes held for partners. Tap to buy minutes.");
  });

  it("says a member with nothing to spend cannot book, whatever the whole balance is", async () => {
    stub(wallet({ held_minutes: 0, owed_back_minutes: 130, spendable_minutes: -10, held_until: null }));
    renderPage(<MinutesChip />);
    const chip = await screen.findByRole("link", { name: /nothing to spend/ }, { timeout: 5_000 });
    expect(chip).toHaveAccessibleName(/You can't book until you buy minutes/);
    expect(chip).toHaveAttribute("href", "/wallet/buy");
  });

  it("keeps the plain balance when nothing is set aside (the fixture, varied)", async () => {
    stub(wallet({ held_minutes: 0, owed_back_minutes: 0, spendable_minutes: 120, held_until: null }));
    renderPage(<MinutesChip />);
    const chip = await screen.findByRole("link", { name: walletLabel(120, false, "live") }, { timeout: 5_000 });
    await waitFor(() => expect(chip).toHaveTextContent("2 h"));
  });
});

describe("the money toast names a share", () => {
  it("says a share moved, either way", () => {
    expect(minutesArrivedSentence(25, "ShareTransfer", null)).toMatch(/share of a split booking/);
    expect(minutesLeftSentence(25, "ShareTransfer")).toMatch(/share of a split booking/);
  });
});
