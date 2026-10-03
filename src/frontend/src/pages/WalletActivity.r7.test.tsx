import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import WalletActivityPage, { ACTIVITY_COPY, DAY_COPY } from "./WalletActivity";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * Review round 7 (lane FD2) — the member's Wallet activity.
 *
 * <ul>
 *   <li>J7-8 / E7-7 — the net line read "…+4 h 48 min.That is…": the sentence after the figure
 *   began on a new JSX line, which collapses to no space at all.</li>
 *   <li>E7-7 — the Spent tile read "1 h" while the Totals card read "−1 h" for the same figure.</li>
 *   <li>X7-6 — "Time on court" and "Bookings played" were compact figures with no spoken twin.</li>
 *   <li>J7-2 — a daily row did not add up to what the balance moved: shares, penalties,
 *   adjustments and reversals had no column.</li>
 * </ul>
 */

const REPORT = {
  from: "2026-09-01", to: "2026-09-30",
  top_ups_minutes: 300, spent_minutes: 60, refunds_minutes: 0, penalties_minutes: 0, adjustments_minutes: 48,
  reversals_minutes: 0, share_transfers_minutes: 0, net_court_spend_minutes: 60, net_movement_minutes: 288,
  penalty_count: 0, attended_bookings: 2, minutes_on_court: 135, count: 5,
};

/** A day that moved by every bucket the API now sends, and adds up: 300 − 60 + 15 − 15 + 30 − 10 − 30 = 230. */
const FULL_DAY = {
  date: "2026-09-10", top_ups_minutes: 300, spent_minutes: 60, refunds_minutes: 15, penalties_minutes: 15,
  adjustments_minutes: 30, reversals_minutes: -10, share_transfers_minutes: -30, net_movement_minutes: 230,
  bookings: 1, attended: 1, minutes_on_court: 60, balance_minutes: 230,
};

/** The row an API from before J7-2 sends. */
const OLD_DAY = {
  date: "2026-09-10", top_ups_minutes: 300, spent_minutes: 60, refunds_minutes: 0,
  bookings: 1, attended: 1, minutes_on_court: 60, balance_minutes: 240,
};

function open(days: unknown[]) {
  stubFetch([
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/reports/me/wallet", body: REPORT },
    { path: "/api/v1/reports/me/daily", body: days },
  ]);
  renderPage(<WalletActivityPage />, { initialEntries: ["/wallet/activity"] });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); });

describe("Wallet activity — round 7", () => {
  it("J7-8 / E7-7: the net line keeps a space between the figure and the next sentence", async () => {
    open([]);
    const help = await screen.findByText(ACTIVITY_COPY.totalsHelp, {}, { timeout: 5_000 });
    const totals = help.closest("section") as HTMLElement;
    const footnote = within(totals).getByText(/Net movement over this period/);
    expect(footnote.textContent).toMatch(/\. That is /);
    expect(footnote.textContent).not.toMatch(/\.That/);
  }, 15_000);

  it("E7-7: the Spent tile is signed the way the Totals card signs it", async () => {
    open([]);
    await screen.findByText(ACTIVITY_COPY.totalsHelp, {}, { timeout: 5_000 });
    const tiles = within(screen.getByLabelText("This period at a glance"));
    expect(tiles.getByText("−1 h")).toBeInTheDocument();
    expect(tiles.getByText("minus 1 hour")).toBeInTheDocument();
    expect(tiles.getByText("+5 h")).toBeInTheDocument();
  }, 15_000);

  it("X7-6: Time on court and Bookings played carry their spoken twin", async () => {
    open([]);
    await screen.findByText(ACTIVITY_COPY.totalsHelp, {}, { timeout: 5_000 });
    const tiles = within(screen.getByLabelText("This period at a glance"));
    const court = tiles.getByText("Time on court").closest("div") as HTMLElement;
    expect(within(court).getByText("2 hours 15 minutes")).toHaveClass("sr-only");
    expect(within(court).getByText("2 h 15 min")).toHaveAttribute("aria-hidden", "true");
    const played = screen.getByText("Bookings played").closest("div") as HTMLElement;
    expect(within(played).getByText("2 hours 15 minutes")).toHaveClass("sr-only");
    expect(within(played).getByText("2 h 15 min")).toHaveAttribute("aria-hidden", "true");
  }, 15_000);

  it("J7-2: a daily row has a column for every bucket it moved by, and a Net that they add up to", async () => {
    open([FULL_DAY]);
    const table = within(await screen.findByRole("region", { name: "Daily breakdown" }, { timeout: 5_000 }));
    for (const name of [DAY_COPY.penalties, DAY_COPY.adjustments, DAY_COPY.reversals, DAY_COPY.shares, DAY_COPY.net]) {
      expect(table.getByRole("columnheader", { name: new RegExp(name.replace(/[()]/g, "\\$&")) })).toBeInTheDocument();
    }
    const row = table.getAllByRole("row").find((r) => within(r).queryByText("+3 h 50 min")) as HTMLElement;
    expect(row, "the Net cell").toBeTruthy();
    // Every movement is signed, so the row reads as a sum: in +, out −.
    for (const figure of ["+5 h", "−1 h", "+15 min", "−15 min", "+30 min", "−10 min", "−30 min"]) {
      expect(within(row).getByText(figure)).toBeInTheDocument();
    }
  }, 15_000);

  it("J7-2: an API that sends no extra buckets draws no empty columns", async () => {
    open([OLD_DAY]);
    const table = within(await screen.findByRole("region", { name: "Daily breakdown" }, { timeout: 5_000 }));
    await table.findByText("+5 h");
    for (const name of [DAY_COPY.penalties, DAY_COPY.adjustments, DAY_COPY.reversals, DAY_COPY.shares, DAY_COPY.net]) {
      expect(table.queryByRole("columnheader", { name: new RegExp(name.replace(/[()]/g, "\\$&")) })).toBeNull();
    }
  }, 15_000);
});
