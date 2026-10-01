import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderPage, signIn, signOut, stubFetch } from "../../test/harness";
import { WALLET_MINI_COPY as COPY } from "../../lib/walletCopy";
import { WalletMiniTotals } from "./WalletMiniTotals";

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
    expect(await within(box).findByText("+300.00 cr")).toBeInTheDocument();
    expect(within(box).getByText("−150.00 cr")).toBeInTheDocument();
    expect(within(box).getByText("+150.00 cr")).toBeInTheDocument();
    expect(within(box).getByRole("link", { name: COPY.more })).toHaveAttribute("href", "/wallet/activity");
    expect(fetch.calls.filter((c) => c.path.startsWith("/api/v1/reports/me/wallet"))).toHaveLength(1);
  });

  it("says a failed read failed — never three zeros — and reads again on Try again", async () => {
    signIn({ isAdmin: false });
    stubFetch([{ path: "/api/v1/reports/me/wallet", status: 500, body: { error: "boom" } }]);
    renderPage(<WalletMiniTotals />);
    expect(await screen.findByText(COPY.failed)).toBeInTheDocument();
    expect(screen.queryByText("0.00 cr", { exact: false })).toBeNull();
    stubFetch([{ path: "/api/v1/reports/me/wallet", body: REPORT }]);
    fireEvent.click(screen.getByRole("button", { name: COPY.retry }));
    expect(await screen.findByText("+300.00 cr")).toBeInTheDocument();
  });

  it("offline, says the figures need a connection", async () => {
    signIn({ isAdmin: false });
    stubFetch([{ path: "/api/v1/reports/me/wallet", status: 500, body: { error: "offline" } }]);
    renderPage(<WalletMiniTotals offline />);
    expect(await screen.findByText(COPY.offline)).toBeInTheDocument();
  });
});
