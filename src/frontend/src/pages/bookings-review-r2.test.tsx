import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { BOOKING_FOR } from "../lib/bookingsCopy";
import { signOut } from "../test/harness";
import { openBookings, resetSheets, sheets } from "../test/bookingsKit";

vi.mock("../components/bookings/BookSheet", async () => (await import("../test/fakeSheets")).bookSheetModule);
vi.mock("../components/bookings/CancelSheet", async () => (await import("../test/fakeSheets")).cancelSheetModule);

/** Review round 2 on the Bookings page itself (lane F1). */
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => { forgetClubZone(); resetSheets(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

const NALEDI = "55555555-5555-5555-5555-555555555555";

function memberRoutes(rules: Record<string, unknown>) {
  return [
    { path: `/api/v1/admin/members/${NALEDI}/booking-rules`, body: { slice_price_credits: 40, groups: [{ name: "Juniors" }], ...rules } },
    { path: `/api/v1/admin/members/${NALEDI}`, body: { full_name: "Naledi Khumalo", balance_credits: 215 } },
  ];
}

describe("R2 F1-3 — booking for a member draws the member's group hours on the grid", () => {
  it("locks the cells outside the member's windows and offers the ones inside", async () => {
    openBookings({
      isAdmin: true, at: `/bookings?date=2030-09-09&as=${NALEDI}`,
      routes: memberRoutes({ day: "2030-09-09", allowed_windows: [{ start: "16:00", end: "17:00" }] }),
    });
    await screen.findByRole("region", { name: BOOKING_FOR.region("Naledi Khumalo") });
    // Inside the window: bookable, as before.
    expect(await screen.findByRole("button", { name: /^Book Court 1 at 16:30/ })).toBeTruthy();
    // Outside it: not a Book button — it says why, about Naledi, not about the admin.
    const locked = await screen.findByRole("button", { name: /Court 1 at 17:00 — outside Naledi's booking times/ });
    expect(screen.queryByRole("button", { name: /^Book Court 1 at 17:00/ })).toBeNull();
    fireEvent.click(locked);
    expect(sheets.book?.open ?? false).toBe(false);
    const said = await screen.findAllByText(/Naledi can book 16:00–17:00/);
    expect(said.length).toBeGreaterThan(0);
  });

  it("locks the whole day when the member's groups leave no time at all", async () => {
    openBookings({
      isAdmin: true, at: `/bookings?date=2030-09-09&as=${NALEDI}`,
      routes: memberRoutes({ day: "2030-09-09", allowed_windows: [], empty_window_groups: ["Juniors", "Seniors"] }),
    });
    await screen.findByRole("region", { name: BOOKING_FOR.region("Naledi Khumalo") });
    const grid = await screen.findByRole("grid");
    await within(grid).findAllByRole("button", { name: /not open to Naledi on this day/ });
    expect(within(grid).queryAllByRole("button", { name: /^Book / })).toHaveLength(0);
  });

  it("offers every cell while the member's rules are unknown — a failed read is never a refusal", async () => {
    openBookings({
      isAdmin: true, at: `/bookings?date=2030-09-09&as=${NALEDI}`,
      routes: [{ path: `/api/v1/admin/members/${NALEDI}/booking-rules`, status: 500, body: {} }, ...memberRoutes({}).slice(1)],
    });
    expect(await screen.findByRole("button", { name: /^Book Court 1 at 17:00/ })).toBeTruthy();
  });

  it("leaves the admin's own grid exempt when booking for themselves", async () => {
    openBookings({ isAdmin: true });
    expect(await screen.findByRole("button", { name: /^Book Court 1 at 17:00/ })).toBeTruthy();
  });
});
