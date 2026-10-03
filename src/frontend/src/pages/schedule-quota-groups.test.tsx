import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import SchedulePage from "./Schedule";
import { forgetClubZone } from "../lib/clubZone";
import { CELL_TEXT } from "../lib/bookingsCopy";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";

vi.mock("../components/bookings/BookSheet", async () => (await import("../test/fakeSheets")).bookSheetModule);
vi.mock("../components/bookings/CancelSheet", async () => (await import("../test/fakeSheets")).cancelSheetModule);

/**
 * Items 3 and 19 on the member's grid — the daily maximum, and the group's window.
 *
 * <p>
 * <b>Both of these decide money, and the grid is told the answer rather than computing it.</b>
 * `available` is a promise the grid makes — this repo's own words about the peak rule — and it
 * was broken once already: 44 cells a day drawn green to a Regular member, each opening a modal
 * quoting court, time, cost and balance-after before refusing after Confirm. D3-B15 measured
 * the same failure for the cap: 240 identical "Available" buttons against a 60-minute limit,
 * i.e. four.
 * </p>
 *
 * <p>
 * <b>And the wall is never a silently grey grid.</b> Every test below checks the cell AND the
 * sentence it answers with, because a locked cell that explains nothing is D4 §2.9's dead
 * surface in a new colour.
 * </p>
 */

const COURT = "11111111-1111-1111-1111-111111111111";
/** Far enough ahead that nothing on it is Past, whatever time the suite runs at. */
const DATE = "2030-09-09";
/** Club time is SAST; the fixture's 17:00 is 15:00 UTC. */
const sast = (hh: number, mm = 0) => new Date(Date.UTC(2030, 8, 9, hh - 2, mm, 0)).toISOString();

function dayWith(rules: unknown, extra: Record<string, unknown> = {}) {
  return {
    date: DATE, timezone: "Africa/Johannesburg", sliceMinutes: 15,
    dayStartMinute: 16 * 60, dayEndMinute: 19 * 60,
    advanceBookingDays: 3650, // 2030 inside the rolling booking window (R5 "Not open yet")
    penaltyPct: 30, penaltyWindowMinutes: 15,
    courts: [{ id: COURT, courtNumber: 1, name: "Court 1" }],
    slots: [], rules, ...extra,
  };
}

function open(day: unknown, balanceMinutes = 500, isAdmin = false) {
  stubFetch([
    // `whoami` is what makes the session real — without it `useAuth` never reaches
    // "authenticated", the balance is never read, and an admin-only control never renders.
    { path: "/api/v1/whoami", body: signIn({ isAdmin }) },
    { path: "/api/v1/schedule", body: day },
    { path: "/api/v1/admin/members/", body: [] },
    { path: "/api/v1/wallet", body: { balance_minutes: balanceMinutes, entries: [], total_entries: 0, offset: 0, limit: 10 } },
  ]);
  renderPage(<SchedulePage />);
}

describe("item 19 — the daily maximum, on the grid", () => {
  beforeEach(() => { forgetClubZone(); signIn({ isAdmin: false }); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

  it("locks every free cell once the quota is gone, with a lock, a word and a dashed edge", async () => {
    open(dayWith({ maxSlotsPerDay: 4, bookedSlotsToday: 4, remainingToday: 0, adminExempt: false }));

    // R2 F1-5 — the fixture's day is not today, so the name says the day it is about.
    const cell = await screen.findByRole("button", { name: /Court 1 at 17:00 — you've used your 4 slots on Mon 9 Sep/ });
    // An ordinary enabled button, NOT `disabled` and not `aria-disabled` — it is operable, and
    // operating it is how the member finds out why. See the note on `UnavailableCell`.
    expect(cell).not.toBeDisabled();
    expect(cell).not.toHaveAttribute("aria-disabled");
    // R2 F1-6 — the court is free; what is used up is the member's own allowance, so the cell
    // says "Your limit", never "Full" (which told them the court was taken).
    expect(cell).toHaveTextContent(CELL_TEXT.limit);
    expect(cell).not.toHaveTextContent("Full");
    // Colour is never the only carrier (SC 1.4.1): a dashed edge, a lock and a word. The fill is
    // the spec's `restricted` slot state (design-system.md: peak/group/quota) — it used to be
    // the Taken grey with a dashed `control` edge; P4 moved every rule-locked cell onto one state.
    expect(cell.className).toMatch(/border-dashed/);
    expect(cell.className).toMatch(/bg-slot-restricted-fill/);
    expect(cell.querySelector("svg")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Book Court 1 at 17:00/ })).toBeNull();
  });

  it("puts the standing banner above the grid, and it is a status rather than an alert", async () => {
    open(dayWith({ maxSlotsPerDay: 4, bookedSlotsToday: 4, remainingToday: 0 }));

    // The rule, not the person — never "you've used up your allowance".
    const banner = await screen.findByText(/You've booked your 4 slots for Monday\./);
    expect(banner).toBeInTheDocument();
    // The why, in one clause. It is what turns a wall into a queue.
    expect(screen.getByText(/so everyone gets court time/)).toBeInTheDocument();
    // And a real way out.
    // R9 J9-4 — it moves the SHOWN day on, so it names that day unless the shown day is today.
    expect(screen.getByRole("button", { name: /^Try (tomorrow|[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2,3})$/ })).toBeInTheDocument();
  });

  it("answers when a locked cell is pressed, and says the same thing the banner says", async () => {
    open(dayWith({ maxSlotsPerDay: 4, bookedSlotsToday: 4, remainingToday: 0 }));
    const cell = await screen.findByRole("button", { name: /Court 1 at 17:00 — you've used your 4/ });
    await act(async () => { cell.click(); });
    expect(document.body.textContent).toMatch(/You've booked your 4 slots for Monday/);
  });

  it("counts up quietly and changes tone only on arrival", async () => {
    open(dayWith({ maxSlotsPerDay: 4, bookedSlotsToday: 2, remainingToday: 2 }));
    // The grid shows a day that is not the club's today, so the pill names it (R1 F1.7).
    const pill = await screen.findByText(/^2 of 4 on /);
    // Approaching a limit is not a warning.
    expect(pill.className).not.toMatch(/warning/);
    expect(screen.getByRole("button", { name: /^Book Court 1 at 17:00/ })).toBeInTheDocument();
  });

  it("shows no counter at all before the member has booked anything today", async () => {
    open(dayWith({ maxSlotsPerDay: 4, bookedSlotsToday: 0, remainingToday: 4 }));
    await screen.findByRole("button", { name: /^Book Court 1 at 17:00/ });
    expect(screen.queryByText(/^\d+ of 4 /)).toBeNull();
  });

  it("tells an admin they have no limit rather than showing them a number that does not apply", async () => {
    open(dayWith({ adminExempt: true, remainingToday: null, maxSlotsPerDay: 4, bookedSlotsToday: 9 }), 500, true);
    expect(await screen.findByRole("button", { name: /^Book Court 1 at 17:00/ })).toBeInTheDocument();
    expect(screen.queryByText(/^\d+ of 4 /)).toBeNull();
    expect(screen.queryByText(/You've booked your/)).toBeNull();
  });

  /**
   * Vary the FIXTURE, not the code. Every test above would pass just as well against a grid
   * that locked on a missing field — and that grid would refuse bookings the club would take,
   * for every club whose API has not shipped the cap yet.
   */
  it("offers the whole day when the payload says nothing about a cap", async () => {
    open(dayWith(undefined));
    expect(await screen.findByRole("button", { name: /^Book Court 1 at 17:00/ })).toBeInTheDocument();
    expect(screen.queryByText(CELL_TEXT.limit)).toBeNull();
  });

  it("offers the whole day when the rules block is present but carries no cap", async () => {
    open(dayWith({ groups: [], clubHours: { start: "16:00", end: "19:00" } }));
    expect(await screen.findByRole("button", { name: /^Book Court 1 at 17:00/ })).toBeInTheDocument();
  });
});

describe("item 3 — the group's window, on the member's grid", () => {
  beforeEach(() => { forgetClubZone(); signIn({ isAdmin: false }); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

  const GROUPED = {
    groups: [{ id: "g1", name: "Non-league members" }],
    allowedWindows: [{ start: "16:00", end: "17:00" }],
    clubHours: { start: "16:00", end: "19:00" },
    remainingToday: null, adminExempt: false,
  };

  it("marks a slot outside the window with its own colour, glyph and word", async () => {
    open(dayWith(GROUPED));

    const restricted = await screen.findByRole("button", { name: /Court 1 at 17:00 — outside the times you can book/ });
    expect(restricted).toHaveTextContent("From 16:00");
    expect(restricted.className).toMatch(/bg-slot-restricted-fill/);
    expect(restricted.className).toMatch(/border-dashed/);
    // And the cell INSIDE the window is an ordinary offer — a rule, not a blanked grid.
    expect(screen.getByRole("button", { name: /^Book Court 1 at 16:45$/ })).toBeInTheDocument();
  });

  it("refuses a slot that would straddle the window's edge, exactly as the server does", async () => {
    // 16:45–17:00 fits; 17:00–17:15 does not. The whole booking must lie inside one window,
    // which is the same whole-range rule `CheckOperatingHoursRule` already applies.
    open(dayWith(GROUPED));
    expect(await screen.findByRole("button", { name: /^Book Court 1 at 16:45/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Book Court 1 at 17:00$/ })).toBeNull();
  });

  it("explains without shaming, and names the group the member chose", async () => {
    open(dayWith(GROUPED));
    const restricted = await screen.findByRole("button", { name: /Court 1 at 17:00 — outside the times/ });
    await act(async () => { restricted.click(); });
    expect(document.body.textContent).toMatch(/You can book 16:00–17:00 on this day/);
    expect(document.body.textContent).toMatch(/You're in Non-league members/);
  });

  it("shows that explanation to somebody who can SEE, not only to a screen reader", async () => {
    // D4 §2.9's finding was that a member tapped a restricted cell and nothing happened. An
    // explanation only a screen reader hears leaves that defect in place for everyone else.
    open(dayWith(GROUPED));
    const restricted = await screen.findByRole("button", { name: /Court 1 at 17:00 — outside the times/ });
    await act(async () => { restricted.click(); });

    const visible = screen.getAllByText(/You can book 16:00–17:00 on this day/)
      .filter((el) => !el.closest(".sr-only"));
    expect(visible.length).toBeGreaterThan(0);
    // And exactly one announcement for one press — the visible half is `aria-hidden`.
    expect(visible[0].closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("names no rate at all, whatever price an older server's rules still carry (P13: no group prices)", async () => {
    // R4 I4-7's "You book at the … rate." line went with the prices: a booking costs its
    // minutes, the same for every group (contract §1.1, §3.12).
    open(dayWith({ ...GROUPED, groups: [{ id: "g1", name: "ix review group" }], slicePriceCredits: 60 }));
    await screen.findByRole("button", { name: /Court 1 at 16:00/ });
    expect(document.body.textContent).not.toMatch(/rate\.|\bcr\b|credit/);
  });

  it("says the empty intersection out loud instead of drawing a grid that reads as 'shut'", async () => {
    open(dayWith({
      ...GROUPED,
      groups: [{ id: "g1", name: "League members" }, { id: "g2", name: "Non-league members" }],
      allowedWindows: [],
      emptyWindowReason: { groups: ["League members", "Non-league members"], day: "mon" },
    }));

    expect(await screen.findByText(/booking times do not overlap, so there is nothing you can book on Monday/))
      .toBeInTheDocument();
    expect(screen.getByText(/Please ask the club/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Book Court 1/ })).toBeNull();
  });

  it("exempts an admin from the window on their own grid", async () => {
    open(dayWith({ ...GROUPED, adminExempt: true }), 500, true);
    expect(await screen.findByRole("button", { name: /^Book Court 1 at 18:00/ })).toBeInTheDocument();
  });

  it("offers the whole day when no window is sent — unknown is never a refusal", async () => {
    open(dayWith({ groups: [{ id: "g1", name: "Non-league members" }], clubHours: { start: "16:00", end: "19:00" } }));
    expect(await screen.findByRole("button", { name: /^Book Court 1 at 18:00/ })).toBeInTheDocument();
  });
});

describe("the wallet, before the member picks a court — D4 §2.6", () => {
  beforeEach(() => { forgetClubZone(); signIn({ isAdmin: false }); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

  it("says a zero balance cannot book anything, names what a slot takes, and offers a package", async () => {
    open(dayWith(undefined), 0);
    expect(await screen.findByText(/You have no minutes left, so you can't book yet\./)).toBeInTheDocument();
    expect(screen.getByText(/A slot here takes 15 minutes\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Buy minutes" })).toHaveAttribute("href", "/wallet/buy");
  });

  it("still offers the cells, because a balance is a wallet and not a booking rule", async () => {
    // An admin may sell the member a package while they are looking at this screen, and the confirm
    // dialog already handles the shortfall well. Hiding slots on a wallet read would be a
    // promise broken in the other direction.
    open(dayWith(undefined), 0);
    expect(await screen.findByRole("button", { name: /^Book Court 1 at 17:00/ })).toBeInTheDocument();
  });

  it("says nothing at all while the balance is unknown", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/schedule", body: dayWith(undefined) },
      { path: "/api/v1/admin/members/", body: [] },
      { path: "/api/v1/wallet", status: 500, body: { error: "boom" } },
    ]);
    renderPage(<SchedulePage />);
    await screen.findByRole("button", { name: /^Book Court 1 at 17:00/ });
    // A grid that shouted "no minutes" at a slow network would be wrong more often than right.
    expect(screen.queryByText(/You have no minutes/)).toBeNull();
  });

  it("says nothing when the member has minutes for a slot", async () => {
    open(dayWith(undefined), 120);
    await screen.findByRole("button", { name: /^Book Court 1 at 17:00/ });
    expect(screen.queryByText(/You have no minutes|Buy a package/)).toBeNull();
  });

  it("says a short wallet — some minutes, fewer than a slot takes — before the member picks (P13)", async () => {
    open(dayWith(undefined), 10);
    const sentence = await screen.findByText("You have 10 minutes left and a slot here takes 15 minutes. Buy a package to book.");
    const notice = sentence.closest('[role="status"]') as HTMLElement;
    expect(within(notice).getByRole("link", { name: "Buy minutes" })).toHaveAttribute("href", "/wallet/buy");
  });
});

describe("item 14 — a club hold on the members' grid", () => {
  beforeEach(() => { forgetClubZone(); signIn({ isAdmin: false }); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

  const HELD = dayWith(undefined, {
    slots: [{
      courtId: COURT, courtNumber: 1, startsAtUtc: sast(17), endsAtUtc: sast(18),
      status: "adminblock", ownerUserId: null, ownerFirstName: null, ownerPhotoUrl: null,
      isMine: false, bookingId: "b-plan", blockLabel: "League night",
      checkedIn: null, amountChargedMinutes: null,
    }],
  });

  it("names the hold by the plan, and says it is the club rather than another member", async () => {
    open(HELD);
    const cell = await screen.findByRole("gridcell", { name: "Court 1 at 17:00 — held by the club for League night" });
    expect(within(cell).getByText("League night")).toBeInTheDocument();
    // A hold nobody can name is a hold nobody can ask about — and "Blocked" names nothing.
    expect(within(cell).getByText("Club hold")).toBeInTheDocument();
    expect(cell.textContent).not.toMatch(/Blocked/);
  });

  it("gives a member no way to lift a club hold", async () => {
    open(HELD);
    await screen.findByRole("gridcell", { name: /held by the club for League night/ });
    expect(screen.queryByRole("button", { name: /Lift the/ })).toBeNull();
  });

  it("gives an admin a lift target they can actually hit", async () => {
    open(HELD, 500, true);
    const lift = await screen.findByRole("button", { name: "Lift the League night hold on Court 1 at 17:00" });
    // D3-B11: it was a 10 px underlined word inside a 48 px cell — the smallest destructive
    // target in the product. Now the house icon button (P4): 36 px drawn with a 5 px extended
    // hit area all round — 46 px under a fingertip — and named, with the name as its tooltip.
    expect(lift.className).toMatch(/size-9/);
    expect(lift.className).toMatch(/after:-inset-\[5px\]/);
    expect(lift.textContent).toBe("");
  });

  it("draws the hold's later cells as one block, not as four things to ask about", async () => {
    open(HELD);
    await screen.findByRole("gridcell", { name: /held by the club for League night/ });
    expect(screen.getByRole("gridcell", { name: "Court 1 at 17:15 — continues, reserved" })).toBeInTheDocument();
  });
});
