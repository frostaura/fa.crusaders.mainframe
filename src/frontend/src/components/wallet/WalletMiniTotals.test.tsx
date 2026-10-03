import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderPage, signIn, signOut, stubFetch } from "../../test/harness";
import { WALLET_MINI_COPY as COPY } from "../../lib/walletCopy";
import { WalletMiniTotals } from "./WalletMiniTotals";
import { BUCKET_LABELS } from "./walletBuckets";

/**
 * R5 M5-9 (SPEC 3.4): the wallet's desktop rail carries the last 30 days under the balance —
 * top-ups, spent, net — and keeps the three states apart: read, failed (never zeros), offline.
 */
const REPORT = {
  top_ups_minutes: 300, spent_minutes: 150, refunds_minutes: 0, penalties_minutes: 0, adjustments_minutes: 0,
  net_movement_minutes: 150, penalty_count: 0, attended_bookings: 3, bookings: 3, minutes_on_court: 135, count: 6,
};

describe("WalletMiniTotals", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  it("reads the last 30 days once and shows what came in, what went out and the net", async () => {
    signIn({ isAdmin: false });
    const fetch = stubFetch([{ path: "/api/v1/reports/me/wallet", body: REPORT }]);
    renderPage(<WalletMiniTotals />);
    const box = screen.getByRole("region", { name: COPY.title });
    expect(within(box).getByRole("status")).toBeInTheDocument();
    expect(await within(box).findByText("+5 h")).toBeInTheDocument();
    expect(within(box).getByText("−2 h 30 min")).toBeInTheDocument();
    expect(within(box).getByText("+2 h 30 min")).toBeInTheDocument();
    expect(within(box).getByRole("link", { name: COPY.more })).toHaveAttribute("href", "/wallet/activity");
    expect(fetch.calls.filter((c) => c.path.startsWith("/api/v1/reports/me/wallet"))).toHaveLength(1);
  });

  it("adds up: every bucket that moved has a row, and the rows sum to the net (R6 L6-6 / J6-3)", async () => {
    // Review round 6: Bought +5 h, Spent −2 h 30 min, Net +4 h 37 min — the adjustment, the
    // refund, the penalty and the share had no row, so the card did not add up.
    signIn({ isAdmin: false });
    stubFetch([{ path: "/api/v1/reports/me/wallet", body: {
      ...REPORT, refunds_minutes: 45, penalties_minutes: 13, adjustments_minutes: 120, reversals_minutes: 0,
      share_transfers_minutes: -25, net_movement_minutes: 277,
    } }]);
    renderPage(<WalletMiniTotals />);
    const box = screen.getByRole("region", { name: COPY.title });
    expect(await within(box).findByText("+4 h 37 min")).toBeInTheDocument();
    for (const [label, figure] of [[BUCKET_LABELS.refunds, "+45 min"], [BUCKET_LABELS.penalties, "−13 min"], [BUCKET_LABELS.adjustments, "+2 h"], [BUCKET_LABELS.shares, "−25 min"]]) {
      const row = within(box).getByText(label).closest("div")!;
      expect(row, label).toHaveTextContent(figure);
    }
    // A bucket that did not move is not a row (no "0 min" noise), and no catch-all is needed.
    expect(within(box).queryByText(BUCKET_LABELS.reversals)).toBeNull();
    expect(within(box).queryByText(BUCKET_LABELS.other)).toBeNull();
  });

  it("names whatever the buckets do not explain, so the card still adds up", async () => {
    signIn({ isAdmin: false });
    stubFetch([{ path: "/api/v1/reports/me/wallet", body: { ...REPORT, net_movement_minutes: 160 } }]);
    renderPage(<WalletMiniTotals />);
    const box = screen.getByRole("region", { name: COPY.title });
    const row = (await within(box).findByText(BUCKET_LABELS.other)).closest("div")!;
    expect(row).toHaveTextContent("+10 min");
  });

  it("says a failed read failed — never three zeros — and reads again on Try again", async () => {
    signIn({ isAdmin: false });
    stubFetch([{ path: "/api/v1/reports/me/wallet", status: 500, body: { error: "boom" } }]);
    renderPage(<WalletMiniTotals />);
    expect(await screen.findByText(COPY.failed)).toBeInTheDocument();
    expect(screen.queryByText("0 min", { exact: false })).toBeNull();
    stubFetch([{ path: "/api/v1/reports/me/wallet", body: REPORT }]);
    fireEvent.click(screen.getByRole("button", { name: COPY.retry }));
    expect(await screen.findByText("+5 h")).toBeInTheDocument();
  });

  it("offline, says the figures need a connection", async () => {
    signIn({ isAdmin: false });
    stubFetch([{ path: "/api/v1/reports/me/wallet", status: 500, body: { error: "offline" } }]);
    renderPage(<WalletMiniTotals offline />);
    expect(await screen.findByText(COPY.offline)).toBeInTheDocument();
  });
});
