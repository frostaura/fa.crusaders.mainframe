import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceFrame, BalanceTransport } from "@/lib/liveBalance";
import { plainMovementSentence } from "@/lib/walletCopy";
import { ToastProvider } from "../Toast";
import { MinutesChip } from "./MinutesChip";
import { signIn, signOut, stubFetch } from "../../test/harness";

/**
 * R16 — the chip's precise money words left the entry chunk (`lib/movementCopy`, fetched with the
 * first frame to say). A phone that cannot fetch that chunk still hears the movement: the
 * reason's plain sentence, never nothing.
 */
vi.mock("@/lib/movementCopy", () => { throw new TypeError("Failed to fetch dynamically imported module"); });

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

describe("the chip's toast when its words cannot be fetched", () => {
  it("says the plain sentence for the reason", async () => {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_minutes: 200, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    ]);
    let live: { onFrame: (f: BalanceFrame) => void } | null = null;
    const transport: BalanceTransport = { open: (args) => { live = args; return Promise.resolve({ close: () => { live = null; } }); } };
    render(<MemoryRouter><AuthProvider><BalanceProvider transport={transport}><ToastProvider><MinutesChip /></ToastProvider></BalanceProvider></AuthProvider></MemoryRouter>);
    await waitFor(() => { if (!live) throw new Error("no stream yet"); });
    await act(async () => { live!.onFrame({ balance_minutes: 200 }); });
    await act(async () => { live!.onFrame({ balance_minutes: 210, delta_minutes: 10, reason: "no_show_settled", court_name: "Court 2", booking_starts_at: "2026-10-05T16:30:00Z" } as BalanceFrame); });
    expect(await screen.findByText(plainMovementSentence(10, "no_show_settled"))).toBeInTheDocument();
  });
});
