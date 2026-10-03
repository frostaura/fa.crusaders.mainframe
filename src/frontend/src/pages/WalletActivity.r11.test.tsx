import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import WalletActivityPage, { ACTIVITY_COPY } from "./WalletActivity";
import { BUCKET_LABELS } from "../components/wallet/walletBuckets";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * R11 J11-4 — a package the club gave at no charge (R 0.00 at the desk) read as "Bought". With
 * the report's `given_minutes`, Bought is what was paid for and "Given by the club" its own line.
 */

const REPORT = {
  from: "2026-09-03", to: "2026-10-03",
  top_ups_minutes: 360, given_minutes: 120, spent_minutes: 60, refunds_minutes: 0, penalties_minutes: 0, adjustments_minutes: 0,
  reversals_minutes: 0, share_transfers_minutes: 0, net_court_spend_minutes: 60, net_movement_minutes: 300,
  penalty_count: 0, attended_bookings: 1, minutes_on_court: 60, count: 3,
};
const DAY = {
  date: "2026-09-10", top_ups_minutes: 360, given_minutes: 120, spent_minutes: 60, refunds_minutes: 0,
  net_movement_minutes: 300, bookings: 1, attended: 1, minutes_on_court: 60, balance_minutes: 300,
};

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

describe("Wallet activity — R11 J11-4", () => {
  it("says Bought for what was paid and Given by the club for the rest, in totals and the daily table", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/reports/me/wallet", body: REPORT },
      { path: "/api/v1/reports/me/daily", body: [DAY] },
    ]);
    renderPage(<WalletActivityPage />, { initialEntries: ["/wallet/activity"] });
    const help = await screen.findByText(ACTIVITY_COPY.totalsHelp, {}, { timeout: 5_000 });
    const totals = help.closest("section") as HTMLElement;
    expect(within(totals).getByText(ACTIVITY_COPY.bought).closest("div")).toHaveTextContent("+4 h");
    expect(within(totals).getByText(BUCKET_LABELS.given).closest("div")).toHaveTextContent("+2 h");
    expect(screen.getByRole("columnheader", { name: new RegExp(BUCKET_LABELS.given) })).toBeInTheDocument();
  }, 15_000);
});
