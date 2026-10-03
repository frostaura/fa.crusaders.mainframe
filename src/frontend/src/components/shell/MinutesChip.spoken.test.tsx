import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceTransport } from "@/lib/liveBalance";
import { ToastProvider } from "../Toast";
import { MinutesChip } from "./MinutesChip";
import { signIn, signOut, stubFetch } from "../../test/harness";

/**
 * R6 X6-2 (FB's ask to FD1) — the chip's hover sentence is read whole (a screen reader speaks a
 * `title` as the control's description): its minutes are words, never "1 h 10 min".
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

const quiet: BalanceTransport = { open: () => Promise.resolve({ close: () => undefined }) };

describe("MinutesChip — the spoken sentence", () => {
  it("says the figures in words, held and owed parts included", async () => {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      {
        path: "/api/v1/wallet",
        body: { balance_minutes: 90, held_minutes: 20, spendable_minutes: 70, entries: [], total_entries: 0, offset: 0, limit: 100 },
      },
    ]);
    const view = render(
      <MemoryRouter>
        <AuthProvider>
          <BalanceProvider transport={quiet}>
            <ToastProvider><MinutesChip /></ToastProvider>
          </BalanceProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    const chip = await waitFor(() => {
      const el = view.container.querySelector<HTMLElement>("[title*='to spend']");
      expect(el).not.toBeNull();
      return el!;
    });
    const title = chip.getAttribute("title")!;
    expect(title).toContain("1 hour 10 minutes to spend");
    expect(title).toContain("20 minutes held for partners");
    expect(title).not.toMatch(/\d\s?(h|min)\b/);
    expect(chip.getAttribute("aria-label") ?? "").not.toMatch(/\d\s?(h|min)\b/);
  });
});
