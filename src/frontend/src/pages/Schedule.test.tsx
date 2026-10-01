import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { BOOKINGS_COPY, CELL_TEXT, PENDING_CELL } from "../lib/bookingsCopy";
import { liftWithReason } from "../test/liftHold";
import { HOLD_LIFTED, HOLD_LIFT_FAILED } from "../lib/scheduleEnd";
import { signOut, refuse } from "../test/harness";
import { COURT_A, COURT_B, ME, dayFixture, openBookings, resetSheets, sast, scheduleCalls, sheets, slotRow } from "../test/bookingsKit";

vi.mock("../components/bookings/BookSheet", async () => (await import("../test/fakeSheets")).bookSheetModule);
vi.mock("../components/bookings/CancelSheet", async () => (await import("../test/fakeSheets")).cancelSheetModule);

/**
 * `slotAt` is called once per cell per render, so counting it counts renders of the grid.
 */
const cellLookups = { count: 0 };
vi.mock("../lib/scheduleGrid", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/scheduleGrid")>();
  return {
    ...real,
    slotAt: (...args: Parameters<typeof real.slotAt>) => {
      cellLookups.count += 1;
      return real.slotAt(...args);
    },
  };
});

/**
 * The Bookings page (P4): its shell, what a tap hands each sheet, and what the page does with
 * the outcome a sheet reports.
 *
 * <p>
 * <b>Retired from this file, with the reason.</b> Every assertion about the confirmation dialog
 * itself — the figures before and after, the admin override and its second press, the refusal
 * sentences, the penalty waiver and its reason, "names the member" — tested
 * `BookingConfirmModal` / `CancelBookingModal`, which P4 deleted. They are the sheets' job now
 * (R7, R19: the 402 refuse-then-retry dance is replaced by god-mode quotes) and live in the
 * sheets' own tests. What stays here is the grid's half of each: which slot, which booking, as
 * whom, and one clock (D4 §2.4).
 * </p>
 */
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => { forgetClubZone(); resetSheets(); });

/** From here on the schedule read never answers — a slow network — while every other route still does. */
function hangScheduleReads() {
  const answered = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    (String(input).startsWith("/api/v1/schedule") ? new Promise(() => {}) : answered(input, init)));
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

const MY_SLOT = slotRow({
  courtId: COURT_A, startsAtUtc: sast(17), endsAtUtc: sast(17, 30),
  ownerUserId: ME, ownerFirstName: "Naledi", isMine: true, bookingId: "mine-1",
});
const THEIRS = slotRow({
  courtId: COURT_B, courtNumber: 2, startsAtUtc: sast(16, 30), endsAtUtc: sast(16, 45),
  ownerUserId: "55555555-5555-5555-5555-555555555555", ownerFirstName: "Thandi", bookingId: "theirs-1",
  checkedIn: null, amountChargedMinutes: null,
});

describe("the page shell — R3, R11", () => {
  it("has one h1 to navigate by, and an sr-only h2 naming the grid", async () => {
    openBookings();
    expect(await screen.findByRole("heading", { level: 1, name: BOOKINGS_COPY.title })).toBeInTheDocument();
    const h2 = screen.getByRole("heading", { level: 2, name: BOOKINGS_COPY.gridHeading });
    expect(h2.className).toContain("sr-only");
    expect(await screen.findByRole("grid", { name: BOOKINGS_COPY.gridHeading })).toBeInTheDocument();
  });

  it("puts refresh in the header as a named icon button, beside how fresh the day is (R3)", async () => {
    const stub = openBookings();
    await screen.findByRole("grid");
    const header = document.querySelector("[data-page-actions]")!;
    const refresh = within(header as HTMLElement).getByRole("button", { name: BOOKINGS_COPY.refresh });
    // An icon button: no visible word, a 44px square, never a text link in the body.
    expect(refresh.textContent).toBe("");
    expect(refresh.className).toContain("size-touch");
    expect(document.querySelector("[data-page-header] time")).toHaveTextContent(/Updated/);

    const before = scheduleCalls(stub).length;
    await act(async () => { fireEvent.click(refresh); });
    await waitFor(() => expect(scheduleCalls(stub).length).toBe(before + 1));
  });

  it("shows a grid-shaped skeleton while the day is read, never 'Loading…' (R12)", async () => {
    openBookings();
    hangScheduleReads();
    // The first paint, before the read lands.
    expect(document.querySelector('[data-state-block="loading"]')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Loading…/);
  });

  it("names a failed read and offers a retry, instead of an empty grid", async () => {
    openBookings({ routes: [{ path: "/api/v1/schedule", status: 503, body: { error: "unavailable" } }] });
    expect(await screen.findByText(/Couldn't load the schedule/)).toBeInTheDocument();
    expect(document.querySelector('[data-state-block="error"]')).toBeTruthy();
    expect(screen.queryByRole("grid")).toBeNull();
  });
});

describe("the day — R5", () => {
  it("opens on the club's today with the week strip, today selected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2030-09-09T10:00:00.000Z"));
    openBookings({ at: "/bookings" });
    await screen.findByRole("grid");
    const today = screen.getByRole("radio", { name: /Monday 9 September, today/ });
    expect(today).toHaveAttribute("aria-checked", "true");
    // Today is the default, so the address carries no date.
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/bookings$/);
  });

  it("greys out and disables the past for a member", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2030-09-11T10:00:00.000Z"));
    openBookings({ at: "/bookings", day: dayFixture({ date: "2030-09-11" }) });
    await screen.findByRole("grid");
    const monday = document.querySelector<HTMLElement>('[data-date="2030-09-09"]')!;
    expect(monday).toBeDisabled();
    expect(monday.className).toContain("text-text-muted");
  });

  it("lets an admin go back into the past — the desk reconciles it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2030-09-11T10:00:00.000Z"));
    openBookings({ isAdmin: true, at: "/bookings", day: dayFixture({ date: "2030-09-11" }) });
    await screen.findByRole("grid");
    expect(document.querySelector<HTMLElement>('[data-date="2030-09-09"]')).not.toBeDisabled();
  });

  it("reads another day when a chip is picked, and writes it into the address", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2030-09-09T10:00:00.000Z"));
    // The server answers for the day it is asked about.
    const stub = openBookings({
      at: "/bookings",
      routes: [{ path: "/api/v1/schedule", respond: ({ path }) => dayFixture({ date: new URL(path, "http://x").searchParams.get("date") }) }],
    });
    await screen.findByRole("grid");
    await act(async () => { fireEvent.click(document.querySelector('[data-date="2030-09-10"]')!); });
    await waitFor(() => expect(scheduleCalls(stub).at(-1)).toContain("date=2030-09-10"));
    expect(screen.getByTestId("location")).toHaveTextContent("/bookings?date=2030-09-10");
  });

  it("opens the day a link names — `?date=` survives a redirect from /schedule", async () => {
    const stub = openBookings({ at: "/bookings?date=2030-09-09" });
    await screen.findByRole("grid");
    expect(scheduleCalls(stub)[0]).toContain("date=2030-09-09");
  });

  it("offers a date picker beside the week to jump further ahead", async () => {
    openBookings();
    await screen.findByRole("grid");
    expect(screen.getByRole("button", { name: `${BOOKINGS_COPY.jumpToDate}: Mon 9 Sep` })).toBeInTheDocument();
  });

  it("draws the day to the club's own hours for that weekday", async () => {
    openBookings({ day: dayFixture({ dayStartMinute: 7 * 60, dayEndMinute: 9 * 60 }) });
    const grid = await screen.findByRole("grid");
    const times = within(grid).getAllByRole("rowheader").map((r) => r.textContent);
    expect(times[0]).toBe("07:00");
    expect(times.at(-1)).toBe("08:45");
  });
});

describe("a tap hands the right thing to the right sheet", () => {
  it("books one slot: the court, the instant, one slice, this viewer's price", async () => {
    openBookings();
    fireEvent.click(await screen.findByRole("button", { name: /^Book Court 2 at 16:15 for 50\.00 cr/ }));
    await screen.findByRole("dialog", { name: "Book sheet" });
    expect(sheets.book?.slots).toEqual([
      { courtId: COURT_B, courtName: "Court 2", startsAt: sast(16, 15), sliceCount: 1, priceMinutes: 50 },
    ]);
    expect(sheets.book?.isAdmin).toBe(false);
    expect(sheets.book?.balanceCredits).toBe(900);
    expect(sheets.book?.timezone).toBe("Africa/Johannesburg");
  });

  it("opens the cancel sheet on the member's own booking, in the grid's own clock (D4 §2.4)", async () => {
    openBookings({ day: dayFixture({ slots: [MY_SLOT] }) });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel your booking on Court 1 at 17:00" }));
    await screen.findByRole("dialog", { name: "Cancel sheet" });
    const [booking] = sheets.cancel!.bookings;
    expect(booking).toMatchObject({ bookingId: "mine-1", courtName: "Court 1", mine: true, memberFirstName: null });
    // One clock across the journey: "Mon 9 Sept, 17:00", never "5:00 PM".
    expect(booking.whenLabel).toMatch(/Mon 9 Sept?,? 17:00/);
    expect(booking.whenLabel).not.toMatch(/AM|PM/);
  });

  it("lets an admin open another member's booking — first name and photo only", async () => {
    openBookings({ isAdmin: true, day: dayFixture({ slots: [THEIRS] }) });
    fireEvent.click(await screen.findByRole("button", { name: "Thandi — cancel on their behalf, Court 2 at 16:30" }));
    const [booking] = sheets.cancel!.bookings;
    expect(booking).toMatchObject({ mine: false, memberFirstName: "Thandi", memberPhotoUrl: null });
    expect(Object.keys(booking)).not.toContain("email");
    expect(sheets.cancel?.isAdmin).toBe(true);
  });

  it("gives a member nothing to press on somebody else's booking", async () => {
    openBookings({ day: dayFixture({ slots: [THEIRS] }) });
    const cell = await screen.findByRole("gridcell", { name: "Court 2 at 16:30 — booked by Thandi" });
    expect(within(cell).queryByRole("button")).toBeNull();
    expect(cell.textContent).toContain("Thandi");
  });

  it("passes `?as=` through to the sheet for an admin, and never for a member", async () => {
    openBookings({ isAdmin: true, at: "/bookings?date=2030-09-09&as=55555555-5555-5555-5555-555555555555" });
    await screen.findByRole("grid");
    expect(sheets.book?.bookAsUserId).toBe("55555555-5555-5555-5555-555555555555");
  });

  it("ignores `?as=` for a member", async () => {
    openBookings({ at: "/bookings?date=2030-09-09&as=55555555-5555-5555-5555-555555555555" });
    await screen.findByRole("grid");
    expect(sheets.book?.bookAsUserId).toBeNull();
  });
});

describe("what the page does with a sheet's outcome — R12", () => {
  it("paints a booking the moment the sheet reports it, before the day is read again", async () => {
    openBookings();
    fireEvent.click(await screen.findByRole("button", { name: /^Book Court 1 at 16:00/ }));
    hangScheduleReads();
    await act(async () => {
      sheets.book!.onBooked!({
        booked: [{ courtId: COURT_A, courtName: "Court 1", startsAt: sast(16), sliceCount: 2, priceMinutes: 100 }],
        ownBalanceAfter: 800, forMemberId: null, hold: false,
      });
    });
    // Mine, at once — and one block over both rows. Pending until the read gives it its real id
    // (P4 walk): a tap on it would send a cancel for an id the server has never heard of.
    const painted = screen.getByRole("button", { name: PENDING_CELL.label("Court 1 at 16:00") });
    expect(painted).toHaveAttribute("aria-disabled", "true");
    expect(painted.className).toContain("bg-slot-mine-fill");
    expect(screen.queryByRole("button", { name: "Cancel your booking on Court 1 at 16:00" })).toBeNull();
    expect(screen.getByRole("gridcell", { name: "Court 1 at 16:15 — continues, your booking" })).toBeInTheDocument();
    expect(document.querySelector('[data-block-rows="2"]')).toBeTruthy();
  });

  it("paints an on-behalf booking as somebody else's, never as the admin's own", async () => {
    openBookings({ isAdmin: true });
    fireEvent.click(await screen.findByRole("button", { name: /^Book Court 1 at 16:00/ }));
    hangScheduleReads();
    await act(async () => {
      sheets.book!.onBooked!({
        booked: [{ courtId: COURT_A, courtName: "Court 1", startsAt: sast(16), sliceCount: 1, priceMinutes: 50 }],
        ownBalanceAfter: null, forMemberId: "55555555-5555-5555-5555-555555555555", hold: false,
      });
    });
    expect(screen.queryByRole("button", { name: "Cancel your booking on Court 1 at 16:00" })).toBeNull();
    // Somebody else's fill, never the admin's own — and pending, so not yet cancellable on their behalf.
    const painted = screen.getByRole("button", { name: PENDING_CELL.label("Court 1 at 16:00") });
    expect(painted.className).toContain("bg-slot-booked-fill");
    expect(painted.className).not.toContain("bg-slot-mine-fill");
    expect(screen.queryByRole("button", { name: /cancel on their behalf, Court 1 at 16:00/ })).toBeNull();
  });

  it("takes a cancelled booking off the grid at once", async () => {
    openBookings({ day: dayFixture({ slots: [MY_SLOT] }) });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel your booking on Court 1 at 17:00" }));
    hangScheduleReads();
    await act(async () => { sheets.cancel!.onCancelled!({ cancelledIds: ["mine-1"], ownMoneyMoved: true }); });
    expect(screen.queryByRole("button", { name: "Cancel your booking on Court 1 at 17:00" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Book Court 1 at 17:00/ })).toBeInTheDocument();
  });

  it("reads the day again when a sheet proves the grid stale", async () => {
    const stub = openBookings();
    fireEvent.click(await screen.findByRole("button", { name: /^Book Court 1 at 16:00/ }));
    const before = scheduleCalls(stub).length;
    await act(async () => { sheets.book!.onStale!(); });
    await waitFor(() => expect(scheduleCalls(stub).length).toBe(before + 1));
  });

  it("does not rebuild the grid when a sheet opens", async () => {
    openBookings();
    const cell = await screen.findByRole("button", { name: /^Book Court 1 at 16:00/ });
    cellLookups.count = 0;
    await act(async () => { fireEvent.click(cell); });
    await screen.findByRole("dialog", { name: "Book sheet" });
    // Opening a sheet touches no cell; the grid's rows are memoised against it.
    expect(cellLookups.count).toBe(0);
  });
});

describe("a club hold, lifted from the grid", () => {
  const HELD = dayFixture({
    slots: [slotRow({ courtId: COURT_A, startsAtUtc: sast(17), endsAtUtc: sast(17, 30), status: "adminblock",
      bookingId: "hold-1", blockLabel: "League night", checkedIn: null, amountChargedMinutes: null })],
  });

  it("goes at once and says so", async () => {
    let lifted = false;
    openBookings({
      isAdmin: true,
      routes: [
        { path: "/api/v1/schedule", respond: () => (lifted ? dayFixture() : HELD) },
        { method: "DELETE", path: "/api/v1/admin/blocks/hold-1", respond: () => { lifted = true; return {}; } },
      ],
    });
    await liftWithReason(await screen.findByRole("button", { name: "Lift the League night hold on Court 1 at 17:00" }));
    expect(await screen.findByText(HOLD_LIFTED)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Book Court 1 at 17:00/ })).toBeInTheDocument();
  });

  it("comes back when the server refuses, with the reason", async () => {
    openBookings({
      isAdmin: true, day: HELD,
      routes: [{ method: "DELETE", path: "/api/v1/admin/blocks/hold-1", respond: () => refuse(409, { error: "conflict" }) }],
    });
    await liftWithReason(await screen.findByRole("button", { name: "Lift the League night hold on Court 1 at 17:00" }));
    await waitFor(() => expect(document.body.textContent).toMatch(new RegExp(HOLD_LIFT_FAILED.slice(0, 20))));
    expect(screen.getByRole("gridcell", { name: "Court 1 at 17:00 — held by the club for League night" })).toBeInTheDocument();
  });
});

/**
 * N-F6 — peak slots a Regular member cannot book are not offered as if they could be.
 */
describe("peak hours on a member's grid", () => {
  const PEAK = dayFixture({
    peakStartMinute: 17 * 60, peakEndMinute: 18 * 60, peakAdvanceHoursForRegular: 1, viewerMayBookPeak: false,
  });

  it("draws a peak cell as reserved, with a word and a glyph, not as an offer", async () => {
    openBookings({ day: PEAK });
    const cell = await screen.findByRole("button", { name: /Court 1 at 17:00 — reserved for league and senior members/ });
    expect(cell.textContent).toContain("League only");
    expect(cell.querySelector("svg")).toBeTruthy();
    expect(cell.className).toContain("border-dashed");
  });

  it("answers when that cell is pressed — D4 §2.9", async () => {
    openBookings({ day: PEAK });
    fireEvent.click(await screen.findByRole("button", { name: /Court 1 at 17:00 — reserved/ }));
    await waitFor(() => expect(screen.getAllByText(/becomes yours to book if it is still free then/).length).toBeGreaterThan(0));
  });

  it("leaves every cell outside the window bookable", async () => {
    openBookings({ day: PEAK });
    expect(await screen.findByRole("button", { name: /^Book Court 1 at 16:45/ })).toBeInTheDocument();
  });

  it("offers the same cells to a viewer the rule never refuses", async () => {
    openBookings({ day: { ...PEAK, viewerMayBookPeak: true } });
    expect(await screen.findByRole("button", { name: /^Book Court 1 at 17:00/ })).toBeInTheDocument();
  });
});

describe("the cells wear the slot tokens — R6", () => {
  it("draws a free slot in the available state, with the fingerprint, and says 'Book'", async () => {
    openBookings();
    const book = await screen.findByRole("button", { name: /^Book Court 1 at 16:00/ });
    expect(book.className).toContain("bg-slot-available-fill");
    expect(book.getAttribute("data-watermark")).toBe("cell");
    expect(book.textContent).toContain(CELL_TEXT.available);
  });

  it("gives no fingerprint to a cell that does not respond", async () => {
    openBookings({ day: dayFixture({ slots: [THEIRS] }) });
    const cell = await screen.findByRole("gridcell", { name: "Court 2 at 16:30 — booked by Thandi" });
    expect(cell.querySelector("[data-watermark]")).toBeNull();
  });
});
