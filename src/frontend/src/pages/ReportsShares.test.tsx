import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import AdminReportsPage from "./admin/AdminReports";
import WalletActivityPage from "./WalletActivity";
import { REPORT_SHARES_COPY as COPY } from "../lib/playersCopy";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * D11 — shares on the reports. Both figures are optional on the wire: an API that predates
 * shares sends neither, and then there is no row at all rather than a 0.00 the server never said.
 */

const WALLET = {
  from: "", to: "",
  top_ups_credits: 200, spent_credits: 100, refunds_credits: 0, penalties_credits: 0, adjustments_credits: 0, reversals_credits: 0,
  net_movement_credits: 150, penalty_count: 0, attended_bookings: 1, minutes_on_court: 45, count: 4,
};
const ME_DAYS = [{ date: "2026-09-01", top_ups_credits: 200, spent_credits: 100, refunds_credits: 0, bookings: 1, attended: 1, minutes_on_court: 45, balance_credits: 150 }];

const DAY = { date: "2026-09-01", top_ups_credits: 200, booking_charges_credits: 100, refunds_credits: 0, penalties_credits: 0, adjustments_credits: 0, reversals_credits: 0, net_movement_credits: 100, bookings: 1, no_shows: 0 };

function memberRoutes(wallet: Record<string, unknown>) {
  return [
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/reports/me/wallet", body: wallet },
    { path: "/api/v1/reports/me/daily", body: ME_DAYS },
  ];
}

function adminRoutes(days: unknown[]) {
  return [
    { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
    { path: "/api/v1/admin/reports/revenue", body: { from: "", to: "", gross_topups_zar: 100, reversals_zar: 0, net_zar: 100, gross_topups_credits: 200, reversals_credits: 0, net_credits: 200 } },
    { path: "/api/v1/admin/reports/utilisation", body: { from: "", to: "", by_court: [] } },
    { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 1, no_show: 0, no_show_pct: 0 } },
    { path: "/api/v1/admin/reports/daily", body: days },
  ];
}

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

describe("the member's activity: shares and what court time really cost", () => {
  it("shows both rows when the server sends them", async () => {
    stubFetch(memberRoutes({ ...WALLET, share_transfers_credits: 50, net_court_spend_credits: 50 }));
    renderPage(<WalletActivityPage />, { initialEntries: ["/wallet/activity"], reactStrictMode: true });
    const totals = within(await screen.findByRole("region", { name: "Totals" }));
    expect(totals.getByText(COPY.memberShares)).toBeInTheDocument();
    expect(totals.getByText("+50.00 cr")).toBeInTheDocument();
    expect(totals.getByText(COPY.memberNetCourt)).toBeInTheDocument();
    expect(totals.getByText("50.00 cr")).toBeInTheDocument();
    expect(totals.getByText(new RegExp(COPY.memberFootnote.replace(/[.]/g, "\\.")))).toBeInTheDocument();
  });

  it("hides both rows against an older API", async () => {
    stubFetch(memberRoutes(WALLET));
    renderPage(<WalletActivityPage />, { initialEntries: ["/wallet/activity"] });
    const totals = within(await screen.findByRole("region", { name: "Totals" }));
    expect(totals.getByText("Adjustments")).toBeInTheDocument();
    expect(totals.queryByText(COPY.memberShares)).toBeNull();
    expect(totals.queryByText(COPY.memberNetCourt)).toBeNull();
  });
});

describe("the club's report: shares net to zero, and it says so", () => {
  it("adds the share bucket to the totals and the daily table, with the caption", async () => {
    stubFetch(adminRoutes([{ ...DAY, share_transfers_credits: 0 }]));
    renderPage(<AdminReportsPage />, { initialEntries: ["/admin/reports"] });
    const totals = await screen.findByRole("region", { name: "Club money — totals" });
    expect(within(totals.querySelector("dl")!).getByText(COPY.clubShares)).toBeInTheDocument();
    // Ten figures, five across: whole rows, never two orphans (review round 2, VIS F3-15).
    expect(totals.querySelector("dl")!.children).toHaveLength(10);
    expect(totals.querySelector("dl")!.className).toContain("lg:grid-cols-5");
    expect(within(totals).getByText(new RegExp(COPY.clubCaption.slice(0, 40)))).toBeInTheDocument();

    const daily = within(await screen.findByRole("region", { name: "Daily breakdown" }));
    expect(daily.getByRole("columnheader", { name: new RegExp(COPY.clubShares) })).toBeInTheDocument();
    expect(daily.getByText(COPY.clubCaption)).toBeInTheDocument();
  });

  it("carries no share column or row against an older API", async () => {
    stubFetch(adminRoutes([DAY]));
    renderPage(<AdminReportsPage />, { initialEntries: ["/admin/reports"] });
    const nine = await screen.findByRole("region", { name: "Club money — totals" });
    expect(screen.queryByText(COPY.clubShares)).toBeNull();
    // Nine figures, three across (F3-15).
    expect(nine.querySelector("dl")!.children).toHaveLength(9);
    expect(nine.querySelector("dl")!.className).toContain("sm:grid-cols-3");
    const daily = within(await screen.findByRole("region", { name: "Daily breakdown" }));
    expect(daily.queryByRole("columnheader", { name: new RegExp(COPY.clubShares) })).toBeNull();
  });
});
