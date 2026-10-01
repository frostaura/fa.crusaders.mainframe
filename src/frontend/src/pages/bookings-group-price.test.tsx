import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { signOut } from "../test/harness";
import { dayFixture, openBookings } from "../test/bookingsKit";
import { BOOK_SHEET, CELL_TEXT, bookCellLabel, sliceLengthLine } from "../lib/bookingsCopy";
import { BUY_MINUTES_PATH } from "../lib/gridCopy";
import { walletNotice } from "../lib/gridExplain";
import { emptyWalletSentence } from "../lib/gridCopy";
import type { ScheduleDay } from "../lib/api";

/**
 * P13 — "minutes, not credits": a booking costs its playing minutes, `slices × slice_minutes`
 * (contract §1.1), the same for every member on every court. There is no court price and no
 * group price any more, and the grid shows none (§3.12).
 *
 * <p>
 * This file used to pin R5 I5-1 — the grid pricing a slice at the member's GROUP price. That
 * whole class of defect is gone with the prices; what replaces it is the rule that nothing on
 * the grid, its headers or the Book sheet reads a price at all — not even one an older server
 * still sends in the rules block. These tests use the REAL sheets.
 * </p>
 */
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => { forgetClubZone(); });
afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

/** An older server's rules block, still carrying a group price: it must change nothing. */
const STALE_PRICE = { slicePriceCredits: 30, groups: [{ id: "g-jr", name: "Juniors" }] };

async function toConfirm(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole("button", { name: BOOK_SHEET.next }));
  // The sheet ignores a Book tapped within 300 ms of the step changing (a double tap's tail).
  await new Promise((r) => setTimeout(r, 350));
}

describe("a booking costs its minutes — the grid carries no price", () => {
  it("draws a free cell as Free, names it without a price, and heads each court with the slot length", async () => {
    openBookings({ balance: 40, day: dayFixture({ rules: STALE_PRICE }) });
    const cell = await screen.findByRole("button", { name: bookCellLabel("Court 1 at 16:00") });
    expect(cell).toHaveTextContent(CELL_TEXT.available);
    expect(cell.textContent).not.toMatch(/\d/);
    const header = screen.getAllByRole("columnheader").find((h) => h.textContent?.includes("Court 1"))!;
    expect(header).toHaveTextContent(sliceLengthLine(15));
    expect(header.textContent).not.toMatch(/30|credit|\bcr\b/);
  });

  it("books one slice for its 15 minutes, whatever price an older server's rules still send", async () => {
    const stub = openBookings({
      balance: 40,
      day: dayFixture({ rules: STALE_PRICE }),
      routes: [{ method: "POST", path: "/api/v1/bookings/", body: { booking_id: "bk-new", balance_after_minutes: 25 } }],
    });
    fireEvent.click(await screen.findByRole("button", { name: bookCellLabel("Court 1 at 16:00") }));
    const dialog = await screen.findByRole("dialog");
    await toConfirm(dialog);
    const money = dialog.querySelector("dl")!;
    expect(money).toHaveTextContent(`${BOOK_SHEET.total}15 min`);
    expect(money).toHaveTextContent(`${BOOK_SHEET.balanceAfter}25 min`);
    // The figures are read to a screen reader in words, never "min".
    expect(money).toHaveTextContent("15 minutes");

    const book = within(dialog).getByRole("button", { name: BOOK_SHEET.primary(1, 15, null) });
    expect(book).toHaveTextContent("Book · 15 min");
    expect(book).toBeEnabled();
    await act(async () => { fireEvent.click(book); });
    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path.startsWith("/api/v1/bookings/"))).toBe(true));
  });

  it("tells a member short of one slice what they need, and points them at the package shelf", async () => {
    openBookings({ balance: 10, day: dayFixture() });
    fireEvent.click(await screen.findByRole("button", { name: bookCellLabel("Court 1 at 16:00") }));
    const dialog = await screen.findByRole("dialog");
    await toConfirm(dialog);
    expect(within(dialog).getByText(BOOK_SHEET.needMore(5))).toHaveTextContent("You need 5 min more");
    expect(within(dialog).getByRole("link", { name: BOOK_SHEET.buyMinutes })).toHaveAttribute("href", BUY_MINUTES_PATH);
  });
});

describe("the empty- and short-wallet banners", () => {
  it("say what a slot takes — the day's slice, in minutes", () => {
    const day = dayFixture() as unknown as ScheduleDay;
    expect(walletNotice(0, day, false)?.title).toBe(emptyWalletSentence(0, 15));
    expect(walletNotice(0, day, false)?.title).toBe("You have no minutes left, so you can't book yet. A slot here takes 15 min.");
    expect(walletNotice(10, day, false)?.title).toBe("You have 10 min left and a slot here takes 15 min. Buy a package to book.");
    expect(walletNotice(10, day, false)?.action?.to).toBe(BUY_MINUTES_PATH);
  });
});
