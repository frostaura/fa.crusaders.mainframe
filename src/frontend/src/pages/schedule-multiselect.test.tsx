import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { BOOKINGS_COPY, selectionCapSentence, selectionCapShort } from "../lib/bookingsCopy";
import { LONG_PRESS_MS } from "../lib/gridSelection";
import { signOut } from "../test/harness";
import { COURT_A, COURT_B, dayFixture, openBookings, resetSheets, sast, sheets, slotRow } from "../test/bookingsKit";

vi.mock("../components/bookings/BookSheet", async () => (await import("../test/fakeSheets")).bookSheetModule);
vi.mock("../components/bookings/CancelSheet", async () => (await import("../test/fakeSheets")).cancelSheetModule);

/**
 * Multiselect, rebuilt to best practice — R4, R2 and D8.
 *
 * <p>
 * <b>Retired, with the decision that retired it.</b> "is not offered to a member — absent, not
 * disabled" → D8: members get the full multiselect, within their limits. The "Select" / "Done"
 * TEXT button in the day bar → R4: the founder called it gross; it is an icon toggle in the page
 * header now. The ✓ glyph and the `ring-2` class on the cell → R2: selection is a checkbox and an
 * inset edge drawn inside the cell (a ring is a box-shadow, and the hover layer clears it). The
 * "Selected slots" sticky region → the floating ActionBar (a toolbar). The bulk sheets' own
 * copy, reason field, idempotency key and per-item outcomes → the sheets' tests, since P4 moved
 * them into `BookSheet` / `CancelSheet`.
 * </p>
 */
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => { forgetClubZone(); resetSheets(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

const BOOKED = slotRow({
  courtId: COURT_B, courtNumber: 2, startsAtUtc: sast(17), endsAtUtc: sast(17, 15),
  ownerUserId: "55555555-5555-5555-5555-555555555555", ownerFirstName: "Thandi", bookingId: "bk-1",
});
const DAY = dayFixture({ slots: [BOOKED] });

const toggle = () => screen.getByRole("button", { name: BOOKINGS_COPY.selectOn });
const bar = () => screen.getByRole("toolbar", { name: BOOKINGS_COPY.actionBarLabel });
const cellAt = (name: string) => screen.getByRole("gridcell", { name });
const chosen = () => screen.getAllByRole("gridcell").filter((c) => c.getAttribute("aria-selected") === "true");
const names = () => chosen().map((c) => c.getAttribute("aria-label"));

/** Turn selection mode on from the header, and tick the named cells. */
async function select(labels: RegExp[]) {
  await screen.findByRole("grid");
  await act(async () => { fireEvent.click(toggle()); });
  for (const name of labels) {
    const cell = await screen.findByRole("button", { name });
    await act(async () => { fireEvent.click(cell); });
  }
}

describe("entering and leaving — R4", () => {
  it("is an icon toggle in the page header, for a member too (D8)", async () => {
    openBookings({ day: DAY });
    await screen.findByRole("grid");
    const button = toggle();
    expect(button.closest("[data-page-actions]")).toBeTruthy();
    expect(button.textContent).toBe("");
    expect(button).toHaveAttribute("aria-pressed", "false");
    await act(async () => { fireEvent.click(button); });
    expect(screen.getByRole("button", { name: BOOKINGS_COPY.selectOff })).toHaveAttribute("aria-pressed", "true");
    // The floating bar arrives with the mode, and says what to do.
    expect(within(bar()).getByText(BOOKINGS_COPY.chooseSlots)).toBeInTheDocument();
  });

  it("marks what is chosen with a checkbox AND an inset edge, never colour alone", async () => {
    openBookings({ day: DAY });
    await select([/^Book Court 1 at 16:00/]);
    const cell = cellAt("Court 1 at 16:00");
    expect(cell).toHaveAttribute("aria-selected", "true");
    const button = within(cell).getByRole("button");
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(cell.querySelector("[data-selected-edge]")?.className).toMatch(/border-2 border-accent-strong/);
    expect(cell.querySelector("[data-cell-check] svg")).toBeTruthy();
  });

  it("toggles a cell off again rather than only ever adding", async () => {
    openBookings({ day: DAY });
    await select([/^Book Court 1 at 16:00/, /^Book Court 1 at 16:00/]);
    expect(chosen()).toHaveLength(0);
  });

  it("puts a checkbox only on cells that can be chosen — a member cannot take somebody's booking", async () => {
    openBookings({ day: DAY });
    await select([]);
    const theirs = cellAt("Court 2 at 17:00 — booked by Thandi");
    expect(theirs.querySelector("[data-cell-check]")).toBeNull();
    expect(theirs).not.toHaveAttribute("aria-selected");
    // …and it steps back, so the choosable ones stand out.
    expect(theirs.firstElementChild?.firstElementChild?.className).toContain("border-dashed");
    expect(cellAt("Court 1 at 16:00").querySelector("[data-cell-check]")).toBeTruthy();
  });

  it("clears the selection when the day changes, and says why", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2030-09-09T10:00:00.000Z"));
    openBookings({
      isAdmin: true, day: DAY,
      routes: [{ path: "/api/v1/schedule", respond: ({ path }) => ({ ...DAY, date: new URL(path, "http://x").searchParams.get("date") }) }],
    });
    await select([/^Book Court 1 at 16:00/]);
    await act(async () => { fireEvent.click(document.querySelector('[data-date="2030-09-10"]')!); });
    await waitFor(() => expect(chosen()).toHaveLength(0));
    expect(document.body.textContent).toContain(BOOKINGS_COPY.selectionClearedDayChange);
  });

  it("leaves the mode from the bar's ×", async () => {
    openBookings({ day: DAY });
    await select([/^Book Court 1 at 16:00/]);
    await act(async () => { fireEvent.click(within(bar()).getByRole("button", { name: BOOKINGS_COPY.clearSelection })); });
    expect(screen.queryByRole("toolbar", { name: BOOKINGS_COPY.actionBarLabel })).toBeNull();
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
  });
});

describe("the floating action bar", () => {
  it("counts slots and the minutes they take, names the span, and books them as runs per court", async () => {
    openBookings({ day: DAY });
    await select([/^Book Court 1 at 16:00/, /^Book Court 1 at 16:15/, /^Book Court 2 at 16:30/]);
    // Three 15-minute slices take 45 minutes — the headline is minutes, never a price (P13 §3.12).
    expect(within(bar()).getByText("3 slots · 45 min")).toBeInTheDocument();
    // Each court's run to the END of its last slot — never one span over both courts, which
    // read as 45 minutes on each (review round 1, F1.8).
    expect(within(bar()).getByText(/Mon 9 Sep · Court 1 16:00–16:30, Court 2 16:30–16:45/)).toBeInTheDocument();
    // The count is announced politely, beside the toolbar rather than inside it.
    expect(screen.getAllByRole("status").some((s) => s.textContent === "3 slots · 45 min")).toBe(true);

    await act(async () => { fireEvent.click(within(bar()).getByRole("button", { name: BOOKINGS_COPY.bookSelection })); });
    // Two adjacent slices on Court 1 are one booking of two; Court 2 is its own.
    expect(sheets.book?.slots).toEqual([
      { courtId: COURT_A, courtName: "Court 1", startsAt: sast(16), sliceCount: 2, priceMinutes: 30 },
      { courtId: COURT_B, courtName: "Court 2", startsAt: sast(16, 30), sliceCount: 1, priceMinutes: 15 },
    ]);
    expect(sheets.book?.open).toBe(true);
  });

  it("offers an admin Cancel for ticked bookings beside Book for ticked slots", async () => {
    openBookings({ isAdmin: true, day: DAY });
    await select([/^Book Court 1 at 16:00/, /Thandi — cancel on their behalf/]);
    expect(within(bar()).getByText("1 slot · 15 min · 1 booking")).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(bar()).getByRole("button", { name: "Cancel booking" })); });
    expect(sheets.cancel?.bookings.map((b) => b.bookingId)).toEqual(["bk-1"]);
    expect(sheets.cancel?.bookings[0].memberFirstName).toBe("Thandi");
  });

  it("leaves selection mode once the sheet reports the booking", async () => {
    openBookings({ day: DAY });
    await select([/^Book Court 1 at 16:00/]);
    await act(async () => { fireEvent.click(within(bar()).getByRole("button", { name: BOOKINGS_COPY.bookSelection })); });
    await act(async () => {
      sheets.book!.onBooked!({ booked: sheets.book!.slots, ownBalanceAfter: 850, forMemberId: null, hold: false });
    });
    expect(screen.queryByRole("toolbar", { name: BOOKINGS_COPY.actionBarLabel })).toBeNull();
  });
});

describe("a member's limits — D8", () => {
  const CAPPED = dayFixture({ rules: { maxSlotsPerDay: 4, bookedSlotsToday: 2, remainingToday: 2, adminExempt: false } });

  it("will not let a member tick more than they may still book today, and says why", async () => {
    openBookings({ day: CAPPED });
    await select([/^Book Court 1 at 16:00/, /^Book Court 1 at 16:15/, /^Book Court 1 at 16:30/]);
    expect(names()).toEqual(["Court 1 at 16:00", "Court 1 at 16:15"]);
    // The shown day is not the club's today: the sentence names it (review round 1, F1.7).
    expect(document.body.textContent).toContain(selectionCapSentence(2, "Mon 9 Sep"));
  });

  it("says a refused pick where the member is looking, and forgets it on the next change (R4 M4-7)", async () => {
    openBookings({ day: CAPPED });
    await select([/^Book Court 1 at 16:00/, /^Book Court 1 at 16:15/, /^Book Court 1 at 16:30/]);
    // Visible in the selection bar, not only to a screen reader — the fifth tap used to do nothing.
    const refusal = bar().querySelector("[data-cap-refusal]");
    expect(refusal?.textContent).toBe(selectionCapShort(2, "Mon 9 Sep"));
    expect(refusal?.textContent).toBe("Limit reached: 2 slots on Mon 9 Sep.");
    // …and a screen reader hears the whole rule, which no longer invites a fifth pick.
    expect(selectionCapSentence(2, "Mon 9 Sep")).toMatch(/^That's 2 slots — the most you can book/);
    // Unticking one is a change: the bar goes back to naming the selection.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Court 1 at 16:15/ })); });
    expect(names()).toEqual(["Court 1 at 16:00"]);
    expect(bar().querySelector("[data-cap-refusal]")).toBeNull();
  });

  it("caps a drag the same way", async () => {
    openBookings({ day: CAPPED });
    await screen.findByRole("grid");
    await act(async () => {
      fireEvent.pointerDown(cellAt("Court 1 at 16:00"), { pointerType: "mouse", button: 0, bubbles: true });
      fireEvent.pointerOver(cellAt("Court 2 at 16:30"), { pointerType: "mouse", bubbles: true });
      fireEvent.pointerUp(window);
    });
    expect(chosen()).toHaveLength(2);
  });

  it("puts no limit on an admin", async () => {
    openBookings({ isAdmin: true, day: dayFixture({ rules: { adminExempt: true } }) });
    await select([/^Book Court 1 at 16:00/, /^Book Court 1 at 16:15/, /^Book Court 1 at 16:30/]);
    expect(chosen()).toHaveLength(3);
  });
});

describe("the keyboard — one tab stop, always (APG grid)", () => {
  it("makes the grid ONE tab stop, not one per cell, in or out of selection mode", async () => {
    openBookings({ day: DAY });
    await screen.findByRole("grid");
    const stops = () => [...document.querySelectorAll<HTMLElement>('[role="grid"] [tabindex="0"]')];
    expect(stops()).toHaveLength(1);
    await select([/^Book Court 1 at 16:00/]);
    expect(stops()).toHaveLength(1);
  });

  it("moves focus with the arrow keys, across courts and down the day, and stops at the edges", async () => {
    openBookings({ day: DAY });
    await screen.findByRole("grid");
    const first = screen.getByRole("button", { name: /^Book Court 1 at 16:00/ });
    first.focus();
    await act(async () => { fireEvent.keyDown(first, { key: "ArrowRight" }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Book Court 2 at 16:00/ }));
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Book Court 2 at 16:15/ }));
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "Home" }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Book Court 1 at 16:15/ }));
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" }); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Book Court 1 at 16:15/ }));
    expect(document.activeElement).toHaveAttribute("tabindex", "0");
  });

  it("drops the choices on the first Escape and the mode on the second", async () => {
    openBookings({ day: DAY });
    await select([/^Book Court 1 at 16:00/, /^Book Court 1 at 16:15/]);
    const grid = screen.getByRole("grid");
    await act(async () => { fireEvent.keyDown(grid, { key: "Escape" }); });
    expect(chosen()).toHaveLength(0);
    expect(screen.getByRole("button", { name: BOOKINGS_COPY.selectOff })).toBeInTheDocument();
    await act(async () => { fireEvent.keyDown(grid, { key: "Escape" }); });
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
  });
});

/** Ranges are rectangles drawn from the anchor, and filled from the CELLS' own answers. */
describe("ranges — Shift, drag, long press, hover checkbox", () => {
  it("takes the rectangle between the anchor and a Shift+click, not the reading-order run", async () => {
    openBookings({ day: DAY });
    await select([/^Book Court 1 at 16:00/]);
    await act(async () => { fireEvent.click(cellAt("Court 1 at 16:30"), { shiftKey: true, bubbles: true }); });
    expect(names()).toEqual(["Court 1 at 16:00", "Court 1 at 16:15", "Court 1 at 16:30"]);
  });

  it("widens across courts, and shrinks when the range is pulled back", async () => {
    openBookings({ day: DAY });
    await select([/^Book Court 1 at 16:00/]);
    await act(async () => { fireEvent.click(cellAt("Court 2 at 16:15"), { shiftKey: true, bubbles: true }); });
    expect(names().sort()).toEqual(["Court 1 at 16:00", "Court 1 at 16:15", "Court 2 at 16:00", "Court 2 at 16:15"]);
    await act(async () => { fireEvent.click(cellAt("Court 1 at 16:15"), { shiftKey: true, bubbles: true }); });
    expect(names()).toEqual(["Court 1 at 16:00", "Court 1 at 16:15"]);
  });

  it("extends on Shift+Arrow, so the keyboard draws the same shape as the mouse", async () => {
    openBookings({ day: DAY });
    await select([/^Book Court 1 at 16:00/]);
    const start = screen.getByRole("button", { name: /^Book Court 1 at 16:00/ });
    start.focus();
    await act(async () => { fireEvent.keyDown(start, { key: "ArrowDown", shiftKey: true }); });
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "ArrowRight", shiftKey: true }); });
    expect(names().sort()).toEqual(["Court 1 at 16:00", "Court 1 at 16:15", "Court 2 at 16:00", "Court 2 at 16:15"]);
  });

  it("paints a rectangle under a mouse drag and enters the mode by itself, skipping a booked cell", async () => {
    openBookings({ day: DAY });
    await screen.findByRole("grid");
    await act(async () => {
      fireEvent.pointerDown(cellAt("Court 1 at 16:45"), { pointerType: "mouse", button: 0, bubbles: true });
      fireEvent.pointerOver(cellAt("Court 2 at 17:15"), { pointerType: "mouse", bubbles: true });
      fireEvent.pointerUp(window);
    });
    expect(screen.getByRole("button", { name: BOOKINGS_COPY.selectOff })).toBeInTheDocument();
    // Thandi's 17:00 on Court 2 is in the sweep and is not the member's to take.
    expect(names().sort()).toEqual([
      "Court 1 at 16:45", "Court 1 at 17:00", "Court 1 at 17:15", "Court 2 at 16:45", "Court 2 at 17:15",
    ]);
  });

  it("leaves an ordinary click alone — it books that one slot", async () => {
    openBookings({ day: DAY });
    const cell = await screen.findByRole("button", { name: /^Book Court 1 at 16:00/ });
    await act(async () => {
      fireEvent.pointerDown(cell, { pointerType: "mouse", button: 0, bubbles: true });
      fireEvent.pointerUp(window);
      fireEvent.click(cell);
    });
    expect(await screen.findByRole("dialog", { name: "Book sheet" })).toBeInTheDocument();
    expect(chosen()).toHaveLength(0);
  });

  it("ignores a touch drag, which is a scroll", async () => {
    openBookings({ day: DAY });
    await screen.findByRole("grid");
    await act(async () => {
      fireEvent.pointerDown(cellAt("Court 1 at 16:00"), { pointerType: "touch", button: 0, bubbles: true });
      fireEvent.pointerOver(cellAt("Court 1 at 16:30"), { pointerType: "touch", bubbles: true });
      fireEvent.pointerUp(window);
    });
    expect(chosen()).toHaveLength(0);
  });

  it("enters the mode on a long press, holding that cell, and does not also book it", async () => {
    openBookings({ day: DAY });
    const cell = await screen.findByRole("button", { name: /^Book Court 1 at 16:00/ });
    vi.useFakeTimers();
    await act(async () => { fireEvent.pointerDown(cell, { pointerType: "touch", clientX: 5, clientY: 5 }); });
    await act(async () => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    vi.useRealTimers();
    await act(async () => { fireEvent.click(cell); });
    expect(names()).toEqual(["Court 1 at 16:00"]);
    expect(screen.queryByRole("dialog", { name: "Book sheet" })).toBeNull();
  });

  it("enters the mode from a desktop's hover checkbox", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query.includes("hover: hover"), media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList);
    openBookings({ day: DAY });
    const cell = await screen.findByRole("button", { name: /^Book Court 1 at 16:00/ });
    const check = cell.querySelector<HTMLElement>("[data-cell-check]")!;
    await act(async () => { fireEvent.click(check); });
    expect(names()).toEqual(["Court 1 at 16:00"]);
    expect(screen.queryByRole("dialog", { name: "Book sheet" })).toBeNull();
    vi.restoreAllMocks();
  });
});
