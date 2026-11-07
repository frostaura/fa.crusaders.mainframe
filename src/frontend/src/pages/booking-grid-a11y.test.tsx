import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import SchedulePage from "./Schedule";
import { BalanceProvider } from "../lib/balance";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";
import { sheets } from "../test/fakeSheets";
import { singleTap } from "../test/bookingsKit";

vi.mock("../components/bookings/BookSheet", async () => (await import("../test/fakeSheets")).bookSheetModule);
vi.mock("../components/bookings/CancelSheet", async () => (await import("../test/fakeSheets")).cancelSheetModule);

/**
 * The booking grid, as somebody who cannot see it experiences it.
 *
 * <p>
 * The grid is a flat CSS grid of about a hundred buttons, every one of them reading
 * "Available". The court is a column header, the time is a row label, and the slot button
 * itself contains neither — so which court and which time a member is about to spend fifty
 * minutes on is conveyed entirely by <em>visual position</em>. A member tabbing through it, or
 * hearing it read, gets "Available, button" a hundred times.
 * </p>
 *
 * <p>
 * These assertions are about the accessible NAME, not about the visible text, which is why
 * they use `getByRole(..., { name })` throughout — that is the thing assistive tech announces,
 * and it was the thing that carried no information.
 * </p>
 */

/**
 * A fixed "now", early enough in the day that the 06:00 and 06:30 slices are still ahead of it.
 * Without it the grid renders both as "Past" — non-interactive divs — and the test measures the
 * wrong thing on any run after 06:00, which is most of them.
 *
 * Only `Date` is faked. Faking timers as well deadlocks `waitFor`, and the arm/disarm timer in
 * ConfirmButton is a real one on purpose.
 */
const NOW = new Date("2026-09-05T04:00:00.000Z");
const TODAY = NOW.toISOString().slice(0, 10);

/** 06:00 and 06:30 UTC on the loaded day — the first two slices the grid draws. */
function at(hhmm: string) {
  return `${TODAY}T${hhmm}:00.000Z`;
}

const DAY = {
  date: TODAY,
  timezone: "UTC",
  sliceMinutes: 30,
  dayStartMinute: 6 * 60,
  dayEndMinute: 7 * 60,
  advanceBookingDays: 14,
  courts: [
    { id: "court-1", name: "Court 1", courtNumber: 1 },
    { id: "court-2", name: "Court 2", courtNumber: 2 },
  ],
  slots: [
    {
      courtId: "court-2", courtNumber: 2, startsAtUtc: at("06:00"), endsAtUtc: at("06:30"),
      status: "booked", ownerUserId: "44444444-4444-4444-4444-444444444444",
      ownerFirstName: "Erin", ownerPhotoUrl: null, isMine: true,
      bookingId: "b1", blockLabel: null,
    },
  ],
};

function routes() {
  return [
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/schedule", body: DAY },
    { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 100 } },
  ];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); signOut(); });

describe("every slot in the booking grid says what it is", () => {
  it("names the court and the time on a bookable slot — and no price (P13 §3.12)", async () => {
    signIn({ isAdmin: false });
    stubFetch(routes());
    renderPage(<BalanceProvider><SchedulePage /></BalanceProvider>);

    // Not "Available" — which court and which time. A booking costs its minutes, the same on
    // every court, so the cell neither shows nor speaks a price; the sheet says what it takes.
    const slot = await screen.findByRole("button", { name: /^Book Court 1 at 06:00$/ });
    expect(slot).toBeInTheDocument();
    expect(slot).toHaveTextContent(/^Free$/);

    // And the second court's 06:00 is a different button with a different name, which is the
    // whole point: position was the only thing separating them.
    expect(screen.getByRole("button", { name: /^Book Court 2 at 06:30$/ })).toBeInTheDocument();
  });

  it("names the member's own booking as theirs, on that court, at that time", async () => {
    signIn({ isAdmin: false });
    stubFetch(routes());
    renderPage(<BalanceProvider><SchedulePage /></BalanceProvider>);

    expect(await screen.findByRole("button", { name: "Cancel your booking on Court 2 at 06:00" })).toBeInTheDocument();
  });

  it("hands the confirmation step the court, the time and the slot's minutes", async () => {
    signIn({ isAdmin: false });
    stubFetch(routes());
    renderPage(<BalanceProvider><SchedulePage /></BalanceProvider>);
    await singleTap();

    const slot = await screen.findByRole("button", { name: /^Book Court 1 at 06:00$/ });
    fireEvent.click(slot);

    // The dialog itself — `aria-modal`, its title, its figures and the Book button's name — is
    // BookSheet's, tested with it (P4 replaced BookingConfirmModal). What the grid owes it is the
    // same court and instant the cell's own name announced, costing the slice's 30 minutes.
    expect(await screen.findByRole("dialog", { name: "Book sheet" })).toBeInTheDocument();
    expect(sheets.book?.slots).toEqual([
      { courtId: "court-1", courtName: "Court 1", startsAt: at("06:00"), sliceCount: 1, priceMinutes: 30 },
    ]);
  });
});
