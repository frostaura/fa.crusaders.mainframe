import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import SchedulePage from "./Schedule";
import { forgetClubZone } from "../lib/clubZone";
import { renderPage, signIn, signOut, stubFetch, type FetchStub } from "../test/harness";

/**
 * The four things the booking grid got wrong about time, position and its own cells.
 *
 * <p>
 * Every one of them was found by driving the screen, not by reading it, and every one of
 * them costs a member or a desk money or minutes:
 * </p>
 *
 * <ul>
 *   <li><b>D3-B03</b> — "today" was the UTC day on a screen whose every row was drawn in the
 *       club's zone. A club west of UTC opens the console in the evening and is shown
 *       tomorrow.</li>
 *   <li><b>D3-B02</b> — "now" was stamped once at load, so a console left open on the desk went
 *       on selling slots that had already started.</li>
 *   <li><b>D3-B01 / D4 §2.2</b> — the grid opened at the top of the day: 247 dead cells and
 *       3 670 px above the first slot anyone could book.</li>
 *   <li><b>D3-B04</b> — five of the six cell types were bare `div`s with an `aria-label`, which
 *       names nothing, on the one screen whose entire meaning is carried by position.</li>
 *   <li><b>D4 §2.4</b> — three clock conventions on one journey: `23:15` on the grid,
 *       `Mon, Sep 21, 11:15 PM` in the dialog and in the toast.</li>
 * </ul>
 */

const COURT = "11111111-1111-1111-1111-111111111111";

/** A day whose rows run 06:00–09:00 club time, so there is a real past wall to collapse. */
function dayFixture(date: string, timezone: string) {
  return {
    date, timezone, sliceMinutes: 15,
    dayStartMinute: 6 * 60, dayEndMinute: 9 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15,
    courts: [{ id: COURT, courtNumber: 1, name: "Court 1", slicePriceCredits: 50 }],
    slots: [],
  };
}

function stubDay(day: unknown, extra: { path: string; method?: string; body?: unknown }[] = []): FetchStub {
  return stubFetch([
    { path: "/api/v1/schedule", body: day },
    { path: "/api/v1/admin/members/", body: [] },
    { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total: 0 } },
    ...extra,
  ]);
}

/** Every path the page asked the schedule for, query string and all, in order. */
function scheduleCalls(stub: FetchStub): string[] {
  return stub.calls.filter((c) => c.path.startsWith("/api/v1/schedule")).map((c) => c.path);
}

describe("the grid's clock", () => {
  beforeEach(() => { forgetClubZone(); signIn({ isAdmin: false }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

  it("asks for the CLUB's day, not the browser's, for a club west of UTC", async () => {
    // 03:00 UTC on the 22nd. Denver is still on the 21st; the UTC day marker says the 22nd.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-22T03:00:00.000Z"));
    // The club has told us its zone on an earlier payload — a sign-in, a wallet read, the
    // previous visit to this very page. `lib/api` learns it from any response carrying one.
    const { rememberClubZone } = await import("../lib/clubZone");
    rememberClubZone("America/Denver");

    const stub = stubDay(dayFixture("2026-09-21", "America/Denver"));
    renderPage(<SchedulePage />);

    await waitFor(() => expect(scheduleCalls(stub).length).toBeGreaterThan(0));
    expect(scheduleCalls(stub)[0]).toContain("date=2026-09-21");
    expect(scheduleCalls(stub)[0]).not.toContain("date=2026-09-22");
  });

  it("adopts the day the SERVER resolved when it disagrees, rather than arguing with it", async () => {
    // The zone is unknown on a cold start — nobody has told us yet — so the client's guess is
    // the reader's own day and the server's answer is the only authority there is. D2-B33
    // makes the server default from the club day; this is the client half of trusting it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-22T03:00:00.000Z"));
    const stub = stubDay(dayFixture("2026-09-19", "America/Denver"));
    renderPage(<SchedulePage />);

    const picker = await screen.findByLabelText("Schedule date");
    await waitFor(() => expect((picker as HTMLInputElement).value).toBe("2026-09-19"));
    // And it does NOT then re-ask for the day it was just given — an adopt that refetches is
    // a loop, and a loop on a day-sized read is what makes a phone grid feel broken.
    expect(scheduleCalls(stub)).toHaveLength(1);
  });

  it("stops selling a slot the moment it starts, on a page nobody has touched", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 06:14 club time (SAST). The 06:15 row is still ahead, and crossing it leaves only two
    // past rows — below the threshold at which the past wall collapses, so what this test
    // measures is the CLOCK and not the disclosure.
    vi.setSystemTime(new Date("2026-09-21T04:14:00.000Z"));
    stubDay(dayFixture("2026-09-21", "Africa/Johannesburg"));
    renderPage(<SchedulePage />);

    const cell = await screen.findByRole("gridcell", { name: /Court 1 at 06:15/ });
    expect(within(cell).getByRole("button", { name: /Book Court 1 at 06:15/ })).toBeTruthy();

    // A minute passes with the tab open on the club desk. Nobody reloads anything.
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Book Court 1 at 06:15/ })).toBeNull();
    });
    expect(screen.getByRole("gridcell", { name: /Court 1 at 06:15 — past/ })).toBeTruthy();
  });
});

describe("the grid's cells", () => {
  beforeEach(() => { forgetClubZone(); signIn({ isAdmin: false }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

  /**
   * A day entirely in the future, so nothing is Past and the grid draws every row.
   *
   * <p>
   * The club shuts at 07:00 and a club hold sits at 08:00, which is what drags the grid's
   * window past closing — `gridWindow`'s union rule — and is therefore the only way a CLOSED
   * cell is drawn at all. That union is deliberate and load-bearing: it exists because a member
   * was once sold 03:00 on a Sunday and the booking appeared on no screen in the product.
   * </p>
   */
  function futureDay() {
    const day = dayFixture("2030-09-07", "Africa/Johannesburg");
    day.dayEndMinute = 7 * 60;
    day.slots = [{
      courtId: COURT, courtNumber: 1,
      // 08:00–08:15 club time, an hour after closing.
      startsAtUtc: "2030-09-07T06:00:00.000Z", endsAtUtc: "2030-09-07T06:15:00.000Z",
      status: "adminblock", ownerUserId: null, ownerFirstName: null, ownerPhotoUrl: null,
      isMine: false, bookingId: "b-block", blockLabel: "League night",
      checkedIn: null, amountChargedCredits: null,
    }] as never;
    return day;
  }

  it("is a grid whose rows and cells a screen reader can hear — D3-B04", async () => {
    stubDay(futureDay());
    renderPage(<SchedulePage />);

    const grid = await screen.findByRole("grid", { name: /Courts and times/i });
    expect(grid).toBeTruthy();
    expect(within(grid).getAllByRole("row").length).toBeGreaterThan(1);

    // Two of D3-B04's five silent types. A cell holding a control is named by its POSITION and
    // the control carries the sentence; a cell holding nothing carries the whole story itself.
    // One name per node either way — a cell answering to two labels is the sentence read twice.
    expect(within(grid).getByRole("gridcell", { name: "Court 1 at 07:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Court 1 at 07:00 — the club is closed/ })).toBeTruthy();
    expect(screen.getByRole("gridcell", { name: /Court 1 at 08:00 — held by the club for League night/ })).toBeTruthy();
  });

  it("names the closed cell as a button that answers, not as a dead surface — D4 §2.9", async () => {
    stubDay(futureDay());
    renderPage(<SchedulePage />);

    const closed = await screen.findByRole("button", { name: /Court 1 at 07:00 — the club is closed/ });
    await act(async () => { closed.click(); });
    expect(await screen.findByRole("status")).toHaveTextContent(/The club is open/i);
  });
});

describe("one clock across the booking journey — D4 §2.4", () => {
  beforeEach(() => { forgetClubZone(); signIn({ isAdmin: false }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

  it("writes the same 24-hour club face on the grid, in the dialog and in the toast", async () => {
    const day = dayFixture("2030-09-07", "Africa/Johannesburg");
    const stub = stubFetch([
      { method: "POST", path: "/api/v1/bookings/", body: { booking_id: "b-1", balance_after_credits: 450 } },
      { path: "/api/v1/schedule", body: day },
      { path: "/api/v1/admin/members/", body: [] },
      { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total: 0 } },
    ]);
    renderPage(<SchedulePage />);

    // 06:30 club time on Saturday 7 September 2030.
    const cell = await screen.findByRole("button", { name: /Book Court 1 at 06:30/ });
    await act(async () => { cell.click(); });

    const dialog = await screen.findByRole("dialog");
    // "Sat 7 Sept, 06:30" — never "Sat, Sep 07, 6:30 AM", and never a bare 12-hour clock. The
    // month abbreviation is whatever this engine's CLDR spells it, which is the point of going
    // through `clubClock` rather than hand-formatting: one formatter, one answer, everywhere.
    expect(within(dialog).getByText(/Sat 7 Sept?,? 06:30/)).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/AM|PM/);

    const confirm = within(dialog).getByRole("button", { name: /^Book for/ });
    await act(async () => { confirm.click(); });

    await waitFor(() => expect(document.body.textContent).toMatch(/Booked Court 1 at Sat 7 Sept?,? 06:30/));
    expect(document.body.textContent).not.toMatch(/\d:\d\d\s?(AM|PM)/);
    expect(stub.calls.some((c) => c.method === "POST" && c.path === "/api/v1/bookings/")).toBe(true);
  });
});
