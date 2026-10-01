import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { signOut } from "../test/harness";
import { COURT_A, COURT_B, dayFixture, openBookings, resetSheets, sast, slotRow } from "../test/bookingsKit";
import { liftWithReason } from "../test/liftHold";
import { BOOKINGS_COPY, BOOK_SHEET, CANCEL_SHEET, LIFT_HOLD_SHEET, bookCellLabel } from "../lib/bookingsCopy";
import { HOLD_LIFTED } from "../lib/scheduleEnd";

vi.mock("../components/bookings/BookSheet", async () => (await import("../test/fakeSheets")).bookSheetModule);
vi.mock("../components/bookings/CancelSheet", async () => (await import("../test/fakeSheets")).cancelSheetModule);

/** Review round 5, lane C — the bookings grid. */
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => { forgetClubZone(); resetSheets(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); signOut(); forgetClubZone(); });

const HELD = dayFixture({
  slots: [slotRow({ courtId: COURT_A, startsAtUtc: sast(17), endsAtUtc: sast(17, 30), status: "adminblock",
    bookingId: "hold-1", blockLabel: "League night", checkedIn: null, amountChargedCredits: null })],
});
const LIFT = "Lift the League night hold on Court 1 at 17:00";
const HOLD_CELL = "Court 1 at 17:00 — held by the club for League night";

describe("A5-1 — lifting a club hold confirms and asks why", () => {
  const deletes = (stub: ReturnType<typeof openBookings>) => stub.calls.filter((c) => c.method === "DELETE");

  it("one tap opens the confirm sheet and deletes nothing", async () => {
    const stub = openBookings({ isAdmin: true, day: HELD });
    fireEvent.click(await screen.findByRole("button", { name: LIFT }));
    const sheet = await screen.findByRole("dialog", { name: LIFT_HOLD_SHEET.title });
    expect(sheet).toHaveTextContent(LIFT_HOLD_SHEET.description("Court 1 at 17:00", "League night"));
    expect(within(sheet).getByRole("button", { name: /^Close / })).toBeInTheDocument();
    expect(deletes(stub)).toHaveLength(0);
    // Under the modal sheet the grid is hidden from the tree, but the hold is still drawn.
    expect(screen.getByRole("gridcell", { name: HOLD_CELL, hidden: true })).toBeInTheDocument();
  });

  it("refuses a blank reason, says why, and sends nothing", async () => {
    const stub = openBookings({ isAdmin: true, day: HELD });
    fireEvent.click(await screen.findByRole("button", { name: LIFT }));
    const sheet = await screen.findByRole("dialog", { name: LIFT_HOLD_SHEET.title });
    fireEvent.change(within(sheet).getByRole("textbox", { name: LIFT_HOLD_SHEET.reasonLabel }), { target: { value: "   " } });
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: LIFT_HOLD_SHEET.confirm })); });
    expect(within(sheet).getByText(LIFT_HOLD_SHEET.reasonMissing)).toBeInTheDocument();
    expect(deletes(stub)).toHaveLength(0);
  });

  it("Keep hold closes and keeps it", async () => {
    const stub = openBookings({ isAdmin: true, day: HELD });
    fireEvent.click(await screen.findByRole("button", { name: LIFT }));
    const sheet = await screen.findByRole("dialog", { name: LIFT_HOLD_SHEET.title });
    fireEvent.click(within(sheet).getByRole("button", { name: LIFT_HOLD_SHEET.keep }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: LIFT_HOLD_SHEET.title })).toBeNull());
    expect(deletes(stub)).toHaveLength(0);
    expect(screen.getByRole("gridcell", { name: HOLD_CELL })).toBeInTheDocument();
  });

  it("sends the reason with the lift, for the change record", async () => {
    let lifted = false;
    const stub = openBookings({
      isAdmin: true,
      routes: [
        { path: "/api/v1/schedule", respond: () => (lifted ? dayFixture() : HELD) },
        { method: "DELETE", path: "/api/v1/admin/blocks/hold-1", respond: () => { lifted = true; return {}; } },
      ],
    });
    await liftWithReason(await screen.findByRole("button", { name: LIFT }), "Court resurfaced early");
    expect(await screen.findByText(HOLD_LIFTED)).toBeInTheDocument();
    const [del] = deletes(stub);
    expect(del.path).toBe(`/api/v1/admin/blocks/hold-1?reason=${encodeURIComponent("Court resurfaced early")}`);
  });
});

describe("A5-10 — a batch of two cancelled reads \"Both cancelled\"", () => {
  it("never \"All 2 cancelled\"", () => {
    expect(CANCEL_SHEET.cancelledTitle(2, 2)).toBe("Both cancelled");
    expect(CANCEL_SHEET.cancelledTitle(3, 3)).toBe("All 3 cancelled");
    expect(CANCEL_SHEET.cancelledTitle(1, 2)).toBe("1 of 2 cancelled");
    expect(BOOK_SHEET.bookedTitle(2, 2)).toBe("Both booked");
    expect(BOOK_SHEET.heldTitle(2, 2)).toBe("Both held");
  });
});

const NALEDI = "55555555-5555-5555-5555-555555555555";
function memberRoutes(rules: Record<string, unknown> = {}) {
  return [
    { path: `/api/v1/admin/members/${NALEDI}/booking-rules`, body: { slice_price_credits: 30, groups: [{ name: "Juniors" }], day: "2030-09-09", allowed_windows: [{ start: "16:00", end: "18:00" }], ...rules } },
    { path: `/api/v1/admin/members/${NALEDI}`, body: { full_name: "Naledi Khumalo", balance_credits: 215, held_credits: 15 } },
  ];
}

describe("A5-9 — booking for a member, the rail shows THEIR wallet", () => {
  it("names the member and their spendable, never the desk's own with a Top up", async () => {
    openBookings({ isAdmin: true, balance: 0, at: `/bookings?date=2030-09-09&as=${NALEDI}`, routes: memberRoutes() });
    const wallet = await screen.findByRole("group", { name: BOOKINGS_COPY.summaryTheirTitle("Naledi") });
    expect(wallet).toHaveTextContent(BOOKINGS_COPY.summaryTheirSpendable("Naledi"));
    expect(wallet).toHaveTextContent("200.00 cr");
    expect(within(wallet).queryByRole("link")).toBeNull();
    expect(screen.queryByRole("group", { name: BOOKINGS_COPY.summaryTitle })).toBeNull();
  });

  it("keeps the desk's own wallet when it books for itself", async () => {
    openBookings({ isAdmin: true, balance: 120 });
    const wallet = await screen.findByRole("group", { name: BOOKINGS_COPY.summaryTitle });
    expect(wallet).toHaveTextContent("120.00 cr");
  });
});

describe("I5-1 — booking for a member, the grid prices at the MEMBER's group price", () => {
  it("uses the member's per-court figures when the desk read sends them", async () => {
    openBookings({
      isAdmin: true, at: `/bookings?date=2030-09-09&as=${NALEDI}`,
      routes: memberRoutes({ slice_prices_by_court: [{ court_id: COURT_A, credits: 30 }, { court_id: COURT_B, credits: 35 }] }),
    });
    expect(await screen.findByRole("button", { name: bookCellLabel("Court 1 at 16:00", 30) })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: bookCellLabel("Court 2 at 16:00", 35) })).toBeInTheDocument();
  });

  it("derives it from the single figure on an older server", async () => {
    openBookings({ isAdmin: true, at: `/bookings?date=2030-09-09&as=${NALEDI}`, routes: memberRoutes() });
    expect(await screen.findByRole("button", { name: bookCellLabel("Court 1 at 16:00", 30) })).toBeInTheDocument();
  });
});
