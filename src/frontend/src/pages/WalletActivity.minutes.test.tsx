import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import WalletActivityPage, { ACTIVITY_COPY } from "./WalletActivity";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * P13 — the member's own activity in whole minutes: "bought", never "top-ups"; every figure in
 * the one compact form for the eye and the long form for a screen reader; never a decimal.
 */
const REPORT = {
  from: "2026-09-01", to: "2026-09-30",
  top_ups_minutes: 600, spent_minutes: 135, refunds_minutes: 45, penalties_minutes: 15, adjustments_minutes: 0,
  reversals_minutes: 0, share_transfers_minutes: -30, net_court_spend_minutes: 135, net_movement_minutes: 465,
  penalty_count: 1, attended_bookings: 3, minutes_on_court: 135, count: 7,
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); });

describe("Wallet activity, in minutes", () => {
  it("says what was bought, spent and moved in whole minutes, signed where it is a movement", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/reports/me/wallet", body: REPORT },
      { path: "/api/v1/reports/me/daily", body: [] },
    ]);
    renderPage(<WalletActivityPage />);
    const help = await screen.findByText(ACTIVITY_COPY.totalsHelp, {}, { timeout: 5_000 });
    const totals = help.closest("section") as HTMLElement;
    expect(within(totals).getByText("+10 h")).toBeInTheDocument();
    expect(within(totals).getByText("plus 10 hours")).toBeInTheDocument();
    expect(within(totals).getByText("−2 h 15 min")).toBeInTheDocument();
    expect(within(totals).getByText("+7 h 45 min")).toBeInTheDocument();
    expect(within(totals).getByText("−30 min")).toBeInTheDocument();
    expect(screen.getAllByText(ACTIVITY_COPY.bought).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/credit|\bcr\b|top-up|\d\.\d\d/i);
  }, 15_000);
});
