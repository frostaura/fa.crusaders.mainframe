import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { BOOKINGS_COPY } from "../lib/bookingsCopy";
import { signOut } from "../test/harness";
import { COURT_A, COURT_B, dayFixture, openBookings, resetSheets, sast, sheets, slotRow } from "../test/bookingsKit";

vi.mock("../components/bookings/BookSheet", async () => (await import("../test/fakeSheets")).bookSheetModule);
vi.mock("../components/bookings/CancelSheet", async () => (await import("../test/fakeSheets")).cancelSheetModule);

/**
 * R16 J16-12 — several slots read in ONE order everywhere: by time, then court.
 *
 * <p>
 * The selection bar listed a pick by time ("Court 2 16:00–16:15, Court 1 17:00–17:15") while the
 * sheet it opened — its slot list, its confirm and its results — listed them by court, Court 1's
 * 17:00 first. A member checking the bar against the sheet read two different lists. The page now
 * hands both sheets their slots in time order, which every step after keeps.
 * </p>
 */
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => { forgetClubZone(); resetSheets(); });
afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

const bar = () => screen.getByRole("toolbar", { name: BOOKINGS_COPY.actionBarLabel });

async function select(labels: RegExp[]) {
  await screen.findByRole("grid");
  for (const name of labels) {
    const cell = await screen.findByRole("button", { name });
    await act(async () => { fireEvent.click(cell); });
  }
}

describe("R16 J16-12 — a multi-slot pick is in time order from the bar to the sheet", () => {
  it.each([
    ["later court picked first", [/^Book Court 1 at 17:00/, /^Book Court 2 at 16:00/]],
    ["earlier court picked first", [/^Book Court 2 at 16:00/, /^Book Court 1 at 17:00/]],
  ])("booking (%s): the sheet gets Court 2 at 16:00 before Court 1 at 17:00", async (_name, picks) => {
    openBookings({ day: dayFixture() });
    await select(picks);
    expect(within(bar()).getByText(/Court 2 16:00–16:15, Court 1 17:00–17:15/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(bar()).getByRole("button", { name: BOOKINGS_COPY.bookSelection })); });
    expect(sheets.book?.slots.map((s) => [s.courtName, s.startsAt])).toEqual([["Court 2", sast(16)], ["Court 1", sast(17)]]);
  });

  it("equal times keep the courts' own order", async () => {
    openBookings({ day: dayFixture() });
    await select([/^Book Court 2 at 16:00/, /^Book Court 1 at 16:00/]);
    await act(async () => { fireEvent.click(within(bar()).getByRole("button", { name: BOOKINGS_COPY.bookSelection })); });
    expect(sheets.book?.slots.map((s) => s.courtId)).toEqual([COURT_A, COURT_B]);
  });

  it("the club cancelling several: the sheet gets the bookings in time order", async () => {
    const late = slotRow({
      courtId: COURT_A, courtNumber: 1, startsAtUtc: sast(18), endsAtUtc: sast(18, 15),
      ownerUserId: "55555555-5555-5555-5555-555555555555", ownerFirstName: "Thandi", bookingId: "bk-late",
    });
    const early = slotRow({
      courtId: COURT_B, courtNumber: 2, startsAtUtc: sast(17), endsAtUtc: sast(17, 15),
      ownerUserId: "66666666-6666-6666-6666-666666666666", ownerFirstName: "Owen", bookingId: "bk-early",
    });
    openBookings({ isAdmin: true, day: dayFixture({ slots: [late, early] }) });
    await select([/Thandi — cancel on their behalf/, /Owen — cancel on their behalf/]);
    await act(async () => { fireEvent.click(within(bar()).getByRole("button", { name: /Cancel 2 bookings|Cancel bookings/ })); });
    expect(sheets.cancel?.bookings.map((b) => b.bookingId)).toEqual(["bk-early", "bk-late"]);
  });
});
