import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { screen, within } from "@testing-library/react";
import { Bar } from "recharts";
import WalletActivityPage, { ACTIVITY_COPY } from "./WalletActivity";
import { BUCKET_LABELS } from "../components/wallet/walletBuckets";
import { drawMyFlow } from "../components/Charts";
import { paletteNow } from "../components/ChartFrame";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * R12 J12-1 — R11 split "Given by the club" out of Bought in the totals and the table, but the
 * tiles at the top said "Bought 0 min" with no Given tile, and the Daily money flow chart drew the
 * given package as a green Bought bar. Bought is what was paid for, everywhere on the page.
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

function flatten(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isValidElement(node)) return [];
  const { children } = node.props as { children?: ReactNode };
  return [node, ...flatten(children)];
}

describe("Wallet activity — R12 J12-1", () => {
  it("the tiles: Bought is what was paid for, and a Given by the club tile beside it", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/reports/me/wallet", body: REPORT },
      { path: "/api/v1/reports/me/daily", body: [DAY] },
    ]);
    renderPage(<WalletActivityPage />, { initialEntries: ["/wallet/activity"] });
    await screen.findByText(ACTIVITY_COPY.totalsHelp, {}, { timeout: 5_000 });
    const tiles = document.querySelector("[data-stat-tiles]") as HTMLElement;
    expect(within(tiles).getByText(ACTIVITY_COPY.bought).closest("div")).toHaveTextContent("+4 h");
    expect(within(tiles).getByText(BUCKET_LABELS.given).closest("div")).toHaveTextContent("+2 h");
  }, 15_000);

  it("the chart: the Bought bar is what was paid for; the given minutes are their own series", () => {
    const rows = [DAY];
    const bars = flatten(drawMyFlow(rows, paletteNow())).filter((e) => e.type === Bar).map((e) => e.props as { dataKey: string; name: string });
    const chart = flatten(drawMyFlow(rows, paletteNow()))[0].props as { data: Record<string, number>[] };
    const bought = bars.find((b) => b.name === "Bought")!;
    const given = bars.find((b) => b.name === BUCKET_LABELS.given);
    expect(given).toBeDefined();
    expect(chart.data[0][bought.dataKey]).toBe(240);
    expect(chart.data[0][given!.dataKey]).toBe(120);
  });

  it("the chart: no given minutes in the period, no Given series", () => {
    const bars = flatten(drawMyFlow([{ ...DAY, given_minutes: 0 }], paletteNow())).filter((e) => e.type === Bar).map((e) => (e.props as { name: string }).name);
    expect(bars).not.toContain(BUCKET_LABELS.given);
  });
});
