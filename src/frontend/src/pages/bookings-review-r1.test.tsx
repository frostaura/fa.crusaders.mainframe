import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { BOOKINGS_COPY, BOOKING_FOR, UPCOMING, partnerCellLabel, selectionCapSentence } from "../lib/bookingsCopy";
import { quotaPill } from "../lib/gridCopy";
import { describePlaces } from "../lib/bookingSpan";
import { signOut } from "../test/harness";
import { COURT_A, COURT_B, dayFixture, openBookings, resetSheets, sast, slotRow } from "../test/bookingsKit";

vi.mock("../components/bookings/BookSheet", async () => (await import("../test/fakeSheets")).bookSheetModule);
vi.mock("../components/bookings/CancelSheet", async () => (await import("../test/fakeSheets")).cancelSheetModule);

/**
 * Review round 1 on the Bookings page itself (F1.6–F1.8): whose booking a `?as=` page is, which
 * day the quota counts, and a selection line that claims only the span it has.
 */
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => { forgetClubZone(); resetSheets(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

const NALEDI = "55555555-5555-5555-5555-555555555555";

describe("F1.6 — booking for a member says so before the sheet does", () => {
  const memberRoutes = [
    {
      path: `/api/v1/admin/members/${NALEDI}/booking-rules`,
      body: { groups: [{ name: "Juniors" }] },
    },
    {
      path: `/api/v1/admin/members/${NALEDI}`,
      body: { full_name: "Naledi Khumalo", balance_minutes: 215, held_minutes: 90, owed_back_minutes: 0 },
    },
  ];

  it("names the member and what they can spend — no price (P13) — and hides the admin's own wallet", async () => {
    const stub = openBookings({
      isAdmin: true, balance: -100, routes: memberRoutes, at: `/bookings?date=2030-09-09&as=${NALEDI}`,
    });
    const bar = await screen.findByRole("region", { name: BOOKING_FOR.region("Naledi Khumalo") });
    expect(bar).toHaveTextContent(`${BOOKING_FOR.label} Naledi Khumalo`);
    expect(bar).toHaveTextContent("Juniors");
    expect(bar).toHaveTextContent(BOOKING_FOR.canSpend(125));
    expect(bar).toHaveTextContent("can spend 2 h 5 min");
    expect(bar.textContent).not.toMatch(/pays|\bcr\b|credit|\.00/);
    expect(bar).toHaveTextContent(BOOKING_FOR.held(90));
    expect(within(bar).getByRole("link", { name: BOOKING_FOR.stop })).toHaveAttribute("href", "/bookings");
    // The admin's own −100 is not this booking's wallet.
    expect(document.body.textContent).not.toContain("Your balance is −1 h 40 min");
    const rules = stub.calls.find((c) => c.path.includes("/booking-rules"));
    expect(rules?.path).toContain("day=2030-09-09");
  });

  it("says so when the member cannot be read, and retries", async () => {
    openBookings({
      isAdmin: true,
      routes: [{ path: `/api/v1/admin/members/${NALEDI}`, status: 500, body: {} }],
      at: `/bookings?date=2030-09-09&as=${NALEDI}`,
    });
    expect(await screen.findByText(BOOKING_FOR.failed)).toBeTruthy();
    expect(screen.getByRole("button", { name: BOOKING_FOR.retry })).toBeTruthy();
  });

  it("is not there for an admin booking for themselves", async () => {
    openBookings({ isAdmin: true });
    await screen.findByRole("grid");
    expect(document.querySelector("[data-booking-for]")).toBeNull();
  });
});

describe("F1.7 — the daily quota names the day it counts", () => {
  const rules = { max_slots_per_day: 4, booked_slots_today: 2, remaining_today: 2 };

  it("says 'on Thu 12 Sep' under another day, never 'today'", async () => {
    openBookings({ day: dayFixture({ date: "2030-09-12", rules }), at: "/bookings?date=2030-09-12" });
    await screen.findByRole("grid");
    expect(await screen.findByText(quotaPill(2, 4, "Thu 12 Sep"))).toBeTruthy();
    expect(screen.queryByText(/2 of 4 today/)).toBeNull();
  });

  it("the cap sentence names the day too", () => {
    expect(selectionCapSentence(1, "Thu 12 Sep")).toBe("That's 1 slot — the most you can book on Thu 12 Sep, the club's daily limit. Untick one to choose a different time.");
    expect(selectionCapSentence(0, "Thu 12 Sep")).toContain("for Thu 12 Sep");
    expect(selectionCapSentence(1)).toContain("today");
  });
});

describe("F1.8 — the selection line never claims a span it does not have", () => {
  const parts = {
    day: "Mon 9 Sep",
    courtName: (id: string) => (id === COURT_A ? "Court 1" : "Court 2"),
    clock: (ms: number) => new Date(ms).toISOString().slice(11, 16),
  };
  const slot = (courtId: string, hh: number, mm = 0) => {
    const from = Date.parse(sast(hh, mm));
    return { courtId, from, to: from + 15 * 60_000 };
  };

  it("lists two separate slots instead of one span over both", () => {
    expect(describePlaces([slot(COURT_A, 11), slot(COURT_B, 12)], parts)).toBe("Mon 9 Sep · Court 1 09:00–09:15, Court 2 10:00–10:15");
  });

  it("keeps the span when it is one: the same times on every court, no gap", () => {
    expect(describePlaces([slot(COURT_A, 11), slot(COURT_A, 11, 15), slot(COURT_B, 11), slot(COURT_B, 11, 15)], parts))
      .toBe("Mon 9 Sep · Court 1, Court 2 · 09:00–09:30");
  });

  it("names each court's run when the runs differ", () => {
    expect(describePlaces([slot(COURT_A, 16), slot(COURT_A, 16, 15), slot(COURT_B, 16, 30)], parts))
      .toBe("Mon 9 Sep · Court 1 14:00–14:30, Court 2 14:30–14:45");
  });

  it("counts past three", () => {
    const four = [slot(COURT_A, 11), slot(COURT_A, 12), slot(COURT_B, 13), slot(COURT_B, 14)];
    expect(describePlaces(four, parts)).toBe("Mon 9 Sep · 4 slots on Court 1, Court 2");
  });

  it("the bar says it on the page", async () => {
    openBookings();
    await screen.findByRole("grid");
    fireEvent.click(screen.getByRole("button", { name: BOOKINGS_COPY.selectOn }));
    fireEvent.click(screen.getByRole("button", { name: /^Book Court 1 at 16:00/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Book Court 2 at 17:00/ }));
    const bar = await screen.findByRole("toolbar", { name: BOOKINGS_COPY.actionBarLabel });
    await waitFor(() => expect(bar).toHaveTextContent("Court 1 16:00–16:15, Court 2 17:00–17:15"));
    expect(bar.textContent).not.toContain("16:00–17:15");
  });
});

describe("F1.12 — upcoming games above the grid, and a partner's game on it", () => {
  const game = (overrides: Record<string, unknown>) => ({
    booking_id: "bk-org", court_name: "Court 1", starts_at: sast(18), ends_at: sast(18, 45), role: "organiser",
    status: "booked", players: [{ name: "Sam Petersen", photo_url: null, status: "accepted" }],
    my_share_minutes: 75, needs_action: false, ...overrides,
  });

  it("lists every upcoming game, soonest first, each opening its booking", async () => {
    openBookings({
      routes: [{
        path: "/api/v1/me/bookings/upcoming",
        body: { timezone: "Africa/Johannesburg", items: [game({}), game({ booking_id: "bk-partner", court_name: "Court 2", role: "partner", needs_action: true })] },
      }],
    });
    const list = await screen.findByRole("region", { name: UPCOMING.title });
    const links = within(list).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/bookings/bk-org", "/bookings/bk-partner"]);
    expect(links[0]).toHaveTextContent(UPCOMING.organiser);
    expect(links[0]).toHaveTextContent("Mon 9 Sep · 18:00–18:45");
    expect(links[0]).toHaveTextContent(UPCOMING.share(75));
    expect(links[1]).toHaveTextContent(UPCOMING.partner);
    expect(links[1]).toHaveTextContent(UPCOMING.needsAction);
  });

  it("a failed read says so with a retry, never 'no games'", async () => {
    openBookings({ routes: [{ path: "/api/v1/me/bookings/upcoming", status: 500, body: {} }] });
    expect(await screen.findByText(UPCOMING.failed)).toBeTruthy();
    expect(screen.getByRole("button", { name: UPCOMING.retry })).toBeTruthy();
  });

  it("draws a partner's seat as their game, opening the booking — never the cancel sheet, never choosable", async () => {
    const partner = slotRow({
      courtId: COURT_A, startsAtUtc: sast(17), endsAtUtc: sast(17, 30), ownerUserId: "org",
      ownerFirstName: "Thandi", isMine: true, role: "partner", bookingId: "bk-partner",
    });
    openBookings({ day: dayFixture({ slots: [partner] }) });
    const cell = await screen.findByRole("link", { name: partnerCellLabel("Court 1 at 17:00") });
    expect(cell).toHaveAttribute("href", "/bookings/bk-partner");
    fireEvent.click(screen.getByRole("button", { name: BOOKINGS_COPY.selectOn }));
    // In selection mode it is not a choice: a partner cannot cancel the organiser's booking.
    const gridcell = cell.closest('[role="gridcell"]')!;
    expect(gridcell.getAttribute("data-select-key")).toBeNull();
  });
});

describe("F1.17 — the grid's keyboard: a screenful, the ends, a named corner", () => {
  it("PageDown / PageUp move eight rows; Ctrl+End and Ctrl+Home reach the grid's last and first cell", async () => {
    openBookings();
    await screen.findByRole("grid");
    const first = screen.getByRole("button", { name: /^Book Court 1 at 16:00/ });
    first.focus();
    await act(async () => { fireEvent.keyDown(first, { key: "PageDown" }); });
    // The day is 16:00–18:00 in 15-minute rows: eight rows on is the last one, 17:45.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Book Court 1 at 17:45/ }));
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "PageUp" }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Book Court 1 at 16:00/ }));
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "End", ctrlKey: true }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Book Court 2 at 17:45/ }));
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "Home", ctrlKey: true }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Book Court 1 at 16:00/ }));
  });

  it("names the time column's header in text", async () => {
    openBookings();
    await screen.findByRole("grid");
    expect(screen.getByRole("columnheader", { name: BOOKINGS_COPY.timeHeader }).textContent).toBe(BOOKINGS_COPY.timeHeader);
  });

  it("a new day puts the tab stop back at its first live row, not where the last day left it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2030-09-09T10:00:00.000Z"));
    const asked = (path: string) => new URL(path, "http://x").searchParams.get("date");
    openBookings({ routes: [{ path: "/api/v1/schedule", respond: ({ path }) => dayFixture({ date: asked(path) }) }] });
    await screen.findByRole("grid");
    const first = screen.getByRole("button", { name: /^Book Court 1 at 16:00/ });
    first.focus();
    await act(async () => { fireEvent.keyDown(first, { key: "End", ctrlKey: true }); });
    expect(screen.getByRole("button", { name: /^Book Court 2 at 17:45/ })).toHaveAttribute("tabindex", "0");
    await act(async () => { fireEvent.click(document.querySelector('[data-date="2030-09-10"]')!); });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("2030-09-10"));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Book Court 1 at 16:00/ })).toHaveAttribute("tabindex", "0"));
  });
});
