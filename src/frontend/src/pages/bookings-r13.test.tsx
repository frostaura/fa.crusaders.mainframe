import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { signOut } from "../test/harness";
import { openBookings, resetSheets } from "../test/bookingsKit";
import { BOOKINGS_COPY, BOOKING_FOR } from "../lib/bookingsCopy";

vi.mock("../components/bookings/BookSheet", async () => (await import("../test/fakeSheets")).bookSheetModule);
vi.mock("../components/bookings/CancelSheet", async () => (await import("../test/fakeSheets")).cancelSheetModule);

/**
 * R13 J13-1 (lane FC13) — the rest of J12-4. Booking FOR a member below zero, the bar said "can
 * spend 0 minutes — 12 minutes below zero" while the rail's wallet beside it said "−12 min / minus
 * 12 minutes". One figure, one sentence: the rail says what the bar says.
 */
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => { forgetClubZone(); resetSheets(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); signOut(); forgetClubZone(); });

const NALEDI = "55555555-5555-5555-5555-555555555555";
function memberRoutes(balance: number, held: number) {
  return [
    { path: `/api/v1/admin/members/${NALEDI}/booking-rules`, body: { groups: [{ name: "Juniors" }], day: "2030-09-09", allowed_windows: [{ start: "16:00", end: "18:00" }] } },
    { path: `/api/v1/admin/members/${NALEDI}`, body: { full_name: "Naledi Khumalo", balance_minutes: balance, held_minutes: held } },
  ];
}

describe("R13 J13-1 — the rail's member wallet below zero says what the bar says", () => {
  it("12 below zero: 0 minutes, and how far under — never minus", async () => {
    openBookings({ isAdmin: true, balance: 0, at: `/bookings?date=2030-09-09&as=${NALEDI}`, routes: memberRoutes(3, 15) });
    const wallet = await screen.findByRole("group", { name: BOOKINGS_COPY.summaryTheirTitle("Naledi") });
    expect(wallet).toHaveTextContent("0 minutes");
    expect(wallet).toHaveTextContent(BOOKINGS_COPY.summaryBelowZero(12));
    expect(wallet.textContent).not.toMatch(/minus|−/);
    // The bar above the grid says the same figure in the same words.
    expect(screen.getByRole("region", { name: BOOKING_FOR.region("Naledi Khumalo") })).toHaveTextContent(BOOKING_FOR.canSpend(-12));
  });

  it("a different debt (1 h 5 min under) is said the same way", async () => {
    openBookings({ isAdmin: true, balance: 0, at: `/bookings?date=2030-09-09&as=${NALEDI}`, routes: memberRoutes(10, 75) });
    const wallet = await screen.findByRole("group", { name: BOOKINGS_COPY.summaryTheirTitle("Naledi") });
    expect(wallet).toHaveTextContent(BOOKINGS_COPY.summaryBelowZero(65));
    expect(BOOKINGS_COPY.summaryBelowZero(65)).toBe("1 hour 5 minutes below zero");
    expect(wallet.textContent).not.toMatch(/minus|−/);
  });

  it("above zero: the figure alone, no below-zero line", async () => {
    openBookings({ isAdmin: true, balance: 0, at: `/bookings?date=2030-09-09&as=${NALEDI}`, routes: memberRoutes(215, 15) });
    const wallet = await screen.findByRole("group", { name: BOOKINGS_COPY.summaryTheirTitle("Naledi") });
    expect(wallet).toHaveTextContent("3 hours 20 minutes");
    expect(wallet.textContent).not.toMatch(/below zero/);
  });
});
