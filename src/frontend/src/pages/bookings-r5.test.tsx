import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { signOut } from "../test/harness";
import { COURT_A, COURT_B, dayFixture, openBookings, resetSheets, sast, slotRow } from "../test/bookingsKit";
import { liftWithReason } from "../test/liftHold";
import { BOOKINGS_COPY, BOOKING_FOR, BOOK_SHEET, CANCEL_SHEET, CELL_TEXT, LIFT_HOLD_SHEET, OFFLINE_CELL, SPLIT_CANCEL, bookCellLabel } from "../lib/bookingsCopy";
import { OFFLINE_COPY } from "../lib/offline/offlineCopy";
import type { ScheduleDay } from "../lib/api";
import { HOLD_LIFTED } from "../lib/scheduleEnd";
import { cancellationOutcome } from "../lib/bookingErrors";
import { notYetOpenSentence } from "../lib/gridCopy";
import { buildTimeSlices } from "../lib/scheduleGrid";

vi.mock("../components/bookings/BookSheet", async () => (await import("../test/fakeSheets")).bookSheetModule);
vi.mock("../components/bookings/CancelSheet", async () => (await import("../test/fakeSheets")).cancelSheetModule);

/** Review round 5, lane C — the bookings grid. */
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => { forgetClubZone(); resetSheets(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); signOut(); forgetClubZone(); });

const HELD = dayFixture({
  slots: [slotRow({ courtId: COURT_A, startsAtUtc: sast(17), endsAtUtc: sast(17, 30), status: "adminblock",
    bookingId: "hold-1", blockLabel: "League night", checkedIn: null, amountChargedMinutes: null })],
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
    { path: `/api/v1/admin/members/${NALEDI}/booking-rules`, body: { groups: [{ name: "Juniors" }], day: "2030-09-09", allowed_windows: [{ start: "16:00", end: "18:00" }], ...rules } },
    { path: `/api/v1/admin/members/${NALEDI}`, body: { full_name: "Naledi Khumalo", balance_minutes: 215, held_minutes: 15 } },
  ];
}

describe("A5-9 — booking for a member, the rail shows THEIR wallet", () => {
  it("names the member and their spendable, never the desk's own with a Top up", async () => {
    openBookings({ isAdmin: true, balance: 0, at: `/bookings?date=2030-09-09&as=${NALEDI}`, routes: memberRoutes() });
    const wallet = await screen.findByRole("group", { name: BOOKINGS_COPY.summaryTheirTitle("Naledi") });
    expect(wallet).toHaveTextContent(BOOKINGS_COPY.summaryTheirSpendable("Naledi"));
    expect(wallet).toHaveTextContent("3 hours 20 minutes");
    expect(within(wallet).queryByRole("link")).toBeNull();
    expect(screen.queryByRole("group", { name: BOOKINGS_COPY.summaryTitle })).toBeNull();
  });

  it("keeps the desk's own wallet when it books for itself", async () => {
    openBookings({ isAdmin: true, balance: 120 });
    const wallet = await screen.findByRole("group", { name: BOOKINGS_COPY.summaryTitle });
    expect(wallet).toHaveTextContent("2 hours");
  });
});

describe("I5-1, after P13 — booking for a member, the grid prices nothing at all", () => {
  it("ignores the per-court prices an older desk read still sends: every cell is the same Free", async () => {
    openBookings({
      isAdmin: true, at: `/bookings?date=2030-09-09&as=${NALEDI}`,
      routes: memberRoutes({ slice_price_credits: 30, slice_prices_by_court: [{ court_id: COURT_A, credits: 30 }, { court_id: COURT_B, credits: 35 }] }),
    });
    expect(await screen.findByRole("button", { name: bookCellLabel("Court 1 at 16:00") })).toHaveTextContent(CELL_TEXT.available);
    expect(screen.getByRole("button", { name: bookCellLabel("Court 2 at 16:00") })).toHaveTextContent(CELL_TEXT.available);
    // The member's bar names who and what they can spend — never a price (P13).
    expect(screen.getByRole("region", { name: BOOKING_FOR.region("Naledi Khumalo") }).textContent).not.toMatch(/pays|\bcr\b|credit/);
  });
});

describe("P5 — a slot past the club's rolling booking window is drawn not yet open", () => {
  it("is never a Book cell, for a member or the desk, and says why when pressed", async () => {
    // 2030 is far beyond a 14-day window: the club would refuse every one of these (too_far_ahead).
    openBookings({ day: dayFixture({ advanceBookingDays: 14 }) });
    const cell = await screen.findByRole("button", { name: "Court 1 at 16:00 — not open for booking yet" });
    expect(cell).toHaveTextContent("Not open yet");
    expect(screen.queryAllByRole("button", { name: /^Book Court/ })).toHaveLength(0);
    fireEvent.click(cell);
    expect((await screen.findAllByText(notYetOpenSentence("Court 1 at 16:00", 14))).length).toBeGreaterThan(0);
  });

  it("applies to the desk too — the API refuses an admin the same way", async () => {
    openBookings({ isAdmin: true, day: dayFixture({ advanceBookingDays: 14 }) });
    expect(await screen.findByRole("button", { name: "Court 2 at 17:45 — not open for booking yet" })).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /^Book Court/ })).toHaveLength(0);
  });

  it("offers the slots inside the window", async () => {
    openBookings({ day: dayFixture({ advanceBookingDays: 3650 }) });
    expect(await screen.findByRole("button", { name: /^Book Court 1 at 16:00/ })).toBeInTheDocument();
  });
});

describe("V5-8 — offline, the grid's free cells are muted, not green Book cells", () => {
  it("draws them Free with no price, and a press says booking needs a connection", async () => {
    openBookings();
    await screen.findByRole("button", { name: bookCellLabel("Court 1 at 16:00") });
    // The signal goes: the refresh fails to reach the club, and the phone says it is offline.
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const answered = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      (String(input).startsWith("/api/v1/schedule") ? Promise.reject(new TypeError("Failed to fetch")) : answered(input, init)));
    fireEvent.click(screen.getByRole("button", { name: BOOKINGS_COPY.refresh }));

    const cell = await screen.findByRole("button", { name: OFFLINE_CELL.label("Court 1 at 16:00") });
    expect(cell).toHaveTextContent(OFFLINE_CELL.word);
    expect(cell).not.toHaveTextContent("50.00");
    expect(cell.className).not.toMatch(/slot-available/);
    expect(screen.queryAllByRole("button", { name: /^Book Court/ })).toHaveLength(0);
    fireEvent.click(cell);
    expect(await screen.findByText(OFFLINE_COPY.bookNeedsConnection)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Book sheet" })).toBeNull();
  });
});

describe("V5-5 — a closed run nothing is booked in is one folded row", () => {
  // Club hours 06:00–08:00; a hold at 00:00–00:30 reaches the grid back to midnight.
  const NIGHT = () => dayFixture({
    dayStartMinute: 6 * 60, dayEndMinute: 8 * 60,
    slots: [slotRow({ courtId: COURT_A, startsAtUtc: sast(0), endsAtUtc: sast(0, 30), status: "adminblock",
      bookingId: "hold-0", blockLabel: "Resurfacing", checkedIn: null, amountChargedMinutes: null })],
  });

  it("folds 00:30–06:00 into one row, keeps the booked rows and the open ones", () => {
    const slices = buildTimeSlices(NIGHT() as unknown as ScheduleDay);
    expect(slices.map((t) => t.label)).toEqual([
      "00:00", "00:15", "00:30–06:00",
      "06:00", "06:15", "06:30", "06:45", "07:00", "07:15", "07:30", "07:45",
    ]);
    const fold = slices[2];
    expect(fold.outOfHours).toBe(true);
    expect(fold.folded).toBe(22);
  });

  it("leaves a short closed run as rows", () => {
    const day = dayFixture({
      dayStartMinute: 6 * 60, dayEndMinute: 8 * 60,
      slots: [slotRow({ courtId: COURT_A, startsAtUtc: sast(5, 15), endsAtUtc: sast(5, 30), status: "adminblock", bookingId: "h", amountChargedMinutes: null })],
    }) as unknown as ScheduleDay;
    expect(buildTimeSlices(day).slice(0, 4).map((t) => t.label)).toEqual(["05:15", "05:30", "05:45", "06:00"]);
  });

  it("draws the fold as one Closed row on the desk's grid", async () => {
    openBookings({ isAdmin: true, day: NIGHT() });
    const grid = await screen.findByRole("grid");
    expect(within(grid).getByRole("rowheader", { name: "00:30–06:00" })).toBeInTheDocument();
    expect(within(grid).getByRole("button", { name: /^Court 1 at 00:30–06:00 — the club is closed/ })).toHaveTextContent("Closed");
    expect(within(grid).queryByRole("rowheader", { name: "03:00" })).toBeNull();
  });
});

describe("§3.1 — the rail's day summary says how many more slots today", () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(new Date());
  const capped = { maxSlotsPerDay: 4, bookedSlotsToday: 1, remainingToday: 3, adminExempt: false };

  it("on today's grid, under a cap", async () => {
    openBookings({ day: dayFixture({ date: today, rules: capped }), balance: 120 });
    const wallet = await screen.findByRole("group", { name: BOOKINGS_COPY.summaryTitle });
    expect(wallet).toHaveTextContent(BOOKINGS_COPY.summaryMoreToday(3));
  });

  it("says nothing with no minutes to spend — the slots left today are not bookable (go-live BM-18b)", async () => {
    openBookings({ day: dayFixture({ date: today, rules: capped }), balance: 0 });
    const wallet = await screen.findByRole("group", { name: BOOKINGS_COPY.summaryTitle });
    expect(wallet.querySelector("[data-more-today]")).toBeNull();
  });

  it("says nothing on another day, or with no cap", async () => {
    openBookings({ day: dayFixture({ rules: capped }), balance: 120 });
    const wallet = await screen.findByRole("group", { name: BOOKINGS_COPY.summaryTitle });
    expect(wallet.querySelector("[data-more-today]")).toBeNull();
  });
});

describe("M5-7 (D1's ask) — a late split cancel says what came back, net of the penalty", () => {
  const thandi = [{ name: "Thandi Third", minutes: 25 }];

  it("corrects a net that left the penalty out (gross 50, penalty 15, Thandi's 25 → 10 back)", () => {
    const said = cancellationOutcome(50, 15, null, { net: 25, partners: thandi });
    expect(said).toContain("10 minutes back to your balance");
    expect(said).toContain("25 minutes to Thandi Third");
    expect(said).toContain("15 minutes kept as the late-cancellation penalty");
  });

  it("takes a net that already counts the penalty as it is", () => {
    expect(cancellationOutcome(50, 15, null, { net: 10, partners: thandi })).toContain("10 minutes back to your balance");
  });

  it("leaves a cancel with no penalty alone", () => {
    expect(cancellationOutcome(50, 0, null, { net: 25, partners: thandi })).toContain("25 minutes back to your balance");
  });

  it("names the organiser's row \"Back to you\", never \"You keep\"", () => {
    expect(SPLIT_CANCEL.youKeep).toBe("Back to you");
  });
});
