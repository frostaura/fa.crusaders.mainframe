import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { BOOKING_FOR, RECENT, UPCOMING, minePastOpenLabel } from "../lib/bookingsCopy";
import { signOut } from "../test/harness";
import { dayFixture, openBookings, resetSheets, sast, sheets, slotRow } from "../test/bookingsKit";

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

describe("R2 F1-1 — a finished game is reachable, and its result recordable, from Bookings", () => {
  function recent(overrides: Record<string, unknown>) {
    return {
      booking_id: "bk-past", court_name: "Court 1", starts_at: "2030-09-08T08:00:00Z", ends_at: "2030-09-08T08:30:00Z",
      role: "organiser", status: "Completed", players: [{ name: "Sam Petersen", photo_url: null, status: "accepted" }],
      my_share_credits: 50, needs_action: false, result_status: "none", can_record: true, ...overrides,
    };
  }
  const recentRoute = (items: unknown[]) => [{ path: "/api/v1/me/bookings/recent", body: { timezone: "Africa/Johannesburg", items } }];

  it("lists recent games under the upcoming ones, with Record the result linking to the result sheet", async () => {
    openBookings({ routes: recentRoute([recent({})]) });
    const region = await screen.findByRole("region", { name: RECENT.title });
    expect(within(region).getByRole("link", { name: /^Court 1/ })).toHaveAttribute("href", "/bookings/bk-past");
    const record = within(region).getByRole("link", { name: /^Record the result of Court 1/ });
    expect(record).toHaveAttribute("href", "/bookings/bk-past?result=record");
    expect(record).toHaveTextContent(RECENT.record);
  });

  it("asks the other side to confirm a pending result, and only says where the rest stand", async () => {
    openBookings({
      routes: recentRoute([
        recent({ booking_id: "bk-a", result_status: "pending", needs_action: true, can_record: false }),
        recent({ booking_id: "bk-b", result_status: "pending", needs_action: false, can_record: false }),
        recent({ booking_id: "bk-c", result_status: "confirmed", can_record: false }),
      ]),
    });
    const region = await screen.findByRole("region", { name: RECENT.title });
    expect(within(region).getByRole("link", { name: /^Confirm the result/ })).toHaveAttribute("href", "/bookings/bk-a?result=confirm");
    expect(within(region).getAllByRole("link", { name: /^(Record|Confirm) the result/ })).toHaveLength(1);
    expect(within(region).getAllByText(RECENT.pending)).toHaveLength(1);
    expect(within(region).getByText(UPCOMING.needsAction)).toBeTruthy();
    expect(within(region).getByText(RECENT.confirmed)).toBeTruthy();
  });

  it("draws nothing when there are none, and says so in one line when the read fails", async () => {
    openBookings({ routes: [{ path: "/api/v1/me/bookings/recent", status: 503, body: {} }] });
    expect(await screen.findByText(RECENT.failed)).toBeTruthy();
    expect(screen.getByRole("button", { name: RECENT.retry })).toBeTruthy();
  });

  it("opens the viewer's own past booking from the grid", async () => {
    const day = dayFixture({
      date: "2020-09-07",
      slots: [slotRow({ isMine: true, bookingId: "bk-old", startsAtUtc: sast(16, 0, "2020-09-07"), endsAtUtc: sast(16, 30, "2020-09-07"), checkedIn: true })],
    });
    openBookings({ isAdmin: true, day, at: "/bookings?date=2020-09-07" });
    const cell = await screen.findByRole("link", { name: minePastOpenLabel("Court 1 at 16:00", true) });
    expect(cell).toHaveAttribute("href", "/bookings/bk-old");
  });
});
