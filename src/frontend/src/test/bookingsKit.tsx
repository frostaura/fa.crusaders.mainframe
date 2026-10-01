import { useLocation } from "react-router-dom";
import BookingsPage from "../pages/Schedule";
import { renderPage, signIn, stubFetch, type FetchStub, type StubRoute } from "./harness";

export { sheets, resetSheets } from "./fakeSheets";

/**
 * The Bookings page's test kit — the grid lane's tests share it.
 *
 * <p>
 * <b>The sheets are stood in for.</b> `BookSheet` and `CancelSheet` own the money (quotes,
 * god mode, refusals, idempotency keys) and are tested in their own files; the grid's tests
 * assert what the grid HANDS them — which slots, which booking, as whom — and what the grid does
 * with the outcome they report. A test file opts in with:
 * </p>
 *
 * <pre>
 * vi.mock("../components/bookings/BookSheet", async () => (await import("../test/fakeSheets")).bookSheetModule);
 * vi.mock("../components/bookings/CancelSheet", async () => (await import("../test/fakeSheets")).cancelSheetModule);
 *
 * (From `fakeSheets`, never from this kit: the kit imports the page, the page imports the
 * sheets, and a mock factory that imports its own importer waits for itself for ever.)
 * </pre>
 */

/** Where the router is — `?date=` follows the week strip. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

export const COURT_A = "11111111-1111-1111-1111-111111111111";
export const COURT_B = "22222222-2222-2222-2222-222222222222";
export const ME = "44444444-4444-4444-4444-444444444444";

/** A slot row as `/schedule` sends it; override what matters. */
export function slotRow(overrides: Record<string, unknown>) {
  return {
    courtId: COURT_A, courtNumber: 1, startsAtUtc: "", endsAtUtc: "", status: "booked",
    ownerUserId: null, ownerFirstName: null, ownerPhotoUrl: null, isMine: false,
    bookingId: "bk-1", blockLabel: null, checkedIn: false, amountChargedMinutes: 50,
    ...overrides,
  };
}

/** A club day in SAST, 16:00–18:00, two courts (P13: a booking costs its minutes, no slice price) — far enough ahead that nothing is past. */
export function dayFixture(overrides: Record<string, unknown> = {}) {
  return {
    date: "2030-09-09", timezone: "Africa/Johannesburg", sliceMinutes: 15,
    dayStartMinute: 16 * 60, dayEndMinute: 18 * 60,
    // Wide enough that 2030 is inside the club's rolling booking window (R5: cells beyond it are "Not open yet").
    advanceBookingDays: 3650, penaltyPct: 30, penaltyWindowMinutes: 15,
    courts: [
      { id: COURT_A, courtNumber: 1, name: "Court 1" },
      { id: COURT_B, courtNumber: 2, name: "Court 2" },
    ],
    slots: [] as unknown[],
    ...overrides,
  };
}

/** An ISO instant on 2030-09-09 at `hh:mm` club time (SAST, UTC+2). */
export const sast = (hh: number, mm = 0, date = "2030-09-09") => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 2, mm, 0)).toISOString();
};

export type OpenOptions = {
  isAdmin?: boolean;
  day?: unknown;
  balance?: number;
  routes?: StubRoute[];
  /** The address the page opens at, e.g. `/bookings?date=2030-09-09&as=…`. */
  at?: string;
};

/** Signs in, stubs the day and the wallet, and renders the page (StrictMode) with a location probe. */
export function openBookings(options: OpenOptions = {}): FetchStub {
  const { isAdmin = false, day = dayFixture(), balance = 900, routes = [], at } = options;
  // The caller's routes FIRST: on an equal-length prefix the harness keeps the first declared,
  // so an override of `/api/v1/schedule` must come before the default one to win.
  const stub = stubFetch([
    ...routes,
    { path: "/api/v1/whoami", body: signIn({ isAdmin }) },
    { path: "/api/v1/schedule", body: day },
    { path: "/api/v1/wallet", body: { balance_minutes: balance, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    // Review round 1, F1.12 — the upcoming games above the grid; none, unless a test says so.
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "Africa/Johannesburg", items: [] } },
    // Review round 2, F1-1 — the recent games (C3); none, unless a test says so.
    { path: "/api/v1/me/bookings/recent", body: { timezone: "Africa/Johannesburg", items: [] } },
  ]);
  const date = (day as { date?: string }).date ?? "2030-09-09";
  renderPage(<><BookingsPage /><LocationProbe /></>, {
    initialEntries: [at ?? `/bookings?date=${date}`],
    reactStrictMode: true,
  });
  return stub;
}

/** Every path the page asked the schedule for, query and all, in order. */
export function scheduleCalls(stub: FetchStub): string[] {
  return stub.calls.filter((c) => c.path.startsWith("/api/v1/schedule")).map((c) => c.path);
}
