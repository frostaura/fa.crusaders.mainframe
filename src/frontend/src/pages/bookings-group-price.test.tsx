import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { signOut } from "../test/harness";
import { COURT_A, COURT_B, dayFixture, openBookings } from "../test/bookingsKit";
import { BOOK_SHEET, bookCellLabel, slicePriceLine } from "../lib/bookingsCopy";
import { viewerSlicePrice } from "../lib/viewerPrice";
import { walletNotice } from "../lib/gridExplain";
import { emptyWalletSentence } from "../lib/gridCopy";
import type { ScheduleDay } from "../lib/api";

/**
 * R5 I5-1 (HIGH, money display) — the grid, its headers and the Book sheet price a slice at the
 * MEMBER's group price (`rules.slicePriceCredits`), not the court's own.
 *
 * <p>
 * Reproduced on the running app: a group at 30 on a 50 court, 40 to spend — every cell said
 * "Book … 50.00 cr", the sheet said "You need 10.00 cr more" and disabled Book, while the club
 * charges 30 and would have taken the booking. These tests use the REAL sheets.
 * </p>
 */
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => { forgetClubZone(); });
afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

const JUNIORS = { slicePriceCredits: 30, groups: [{ id: "g-jr", name: "Juniors" }] };

async function toConfirm(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole("button", { name: BOOK_SHEET.next }));
  // The sheet ignores a Book tapped within 300 ms of the step changing (a double tap's tail).
  await new Promise((r) => setTimeout(r, 350));
}

describe("a member whose group pays less than the court", () => {
  it("books when the group price fits the balance though the court price would not", async () => {
    const stub = openBookings({
      balance: 40,
      day: dayFixture({ rules: JUNIORS }),
      routes: [{ method: "POST", path: "/api/v1/bookings/", body: { booking_id: "bk-new", balance_after_credits: 10 } }],
    });
    // The cell and the header say the member's price.
    const cell = await screen.findByRole("button", { name: bookCellLabel("Court 1 at 16:00", 30) });
    expect(screen.queryByRole("button", { name: bookCellLabel("Court 1 at 16:00", 50) })).toBeNull();
    const header = screen.getAllByRole("columnheader").find((h) => h.textContent?.includes("Court 1"))!;
    expect(header).toHaveTextContent(slicePriceLine(30, 15));

    fireEvent.click(cell);
    const dialog = await screen.findByRole("dialog");
    await toConfirm(dialog);
    const money = dialog.querySelector("dl")!;
    expect(money).toHaveTextContent(`${BOOK_SHEET.total}30.00 cr`);
    expect(money).toHaveTextContent(`${BOOK_SHEET.balanceAfter}10.00 cr`);
    expect(within(dialog).queryByText(BOOK_SHEET.needMore(10))).toBeNull();

    const book = within(dialog).getByRole("button", { name: BOOK_SHEET.primary(1, 30, null) });
    expect(book).toBeEnabled();
    await act(async () => { fireEvent.click(book); });
    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path.startsWith("/api/v1/bookings/"))).toBe(true));
  });

  it("prices a multi-slot selection at the group price too", async () => {
    openBookings({ balance: 40, day: dayFixture({ rules: JUNIORS }) });
    await screen.findByRole("button", { name: bookCellLabel("Court 2 at 16:00", 30) });
    // A court the member's rules do not change still shows the group's figure, cell by cell.
    expect(screen.getByRole("button", { name: bookCellLabel("Court 2 at 16:15", 30) })).toBeInTheDocument();
  });

  it("keeps the court's own price when the server says nothing about the viewer", async () => {
    openBookings({ balance: 40 });
    expect(await screen.findByRole("button", { name: bookCellLabel("Court 1 at 16:00", 50) })).toBeInTheDocument();
  });
});

describe("viewerSlicePrice — per-court derivation", () => {
  const court = (id: string, price: number) => ({ id, slicePriceCredits: price });
  it("takes the server's per-court figure first", () => {
    const byCourt = new Map([[COURT_B, 44]]);
    expect(viewerSlicePrice(court(COURT_B, 80), { groupPrice: 30, referencePrice: 50, byCourt })).toBe(44);
  });
  it("is the group price on the reference court, the court's own when the group changes nothing", () => {
    expect(viewerSlicePrice(court(COURT_A, 50), { groupPrice: 30, referencePrice: 50, byCourt: null })).toBe(30);
    expect(viewerSlicePrice(court(COURT_B, 80), { groupPrice: 50, referencePrice: 50, byCourt: null })).toBe(80);
  });
  it("scales a dearer court by the group's ratio, and is the court's own when unknown", () => {
    expect(viewerSlicePrice(court(COURT_B, 80), { groupPrice: 30, referencePrice: 50, byCourt: null })).toBe(48);
    expect(viewerSlicePrice(court(COURT_B, 80), { groupPrice: null, referencePrice: 50, byCourt: null })).toBe(80);
  });
});

describe("the empty-wallet banner", () => {
  it("quotes what a slot costs the member, not the court", () => {
    const day = dayFixture() as unknown as ScheduleDay;
    expect(walletNotice(0, day, false, 30)?.title).toBe(emptyWalletSentence(0, 30));
    expect(walletNotice(0, day, false, null)?.title).toBe(emptyWalletSentence(0, 50));
  });
});
