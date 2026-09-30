import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { signOut } from "../test/harness";
import { openBookings, resetSheets, sheets } from "../test/bookingsKit";

vi.mock("../components/bookings/BookSheet", async () => (await import("../test/fakeSheets")).bookSheetModule);
vi.mock("../components/bookings/CancelSheet", async () => (await import("../test/fakeSheets")).cancelSheetModule);

/** `cellVerdict` runs once per render of an empty cell, so counting it counts cell renders. */
const verdicts = { count: 0 };
vi.mock("../lib/gridRules", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/gridRules")>();
  return { ...real, cellVerdict: (...args: Parameters<typeof real.cellVerdict>) => { verdicts.count += 1; return real.cellVerdict(...args); } };
});

/**
 * Perf lane (2026-09-30) — what the Bookings page does so a tap on a cell stays cheap on a phone.
 */
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => { forgetClubZone(); resetSheets(); });
afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

describe("a tap re-renders the cells it changed, not the grid", () => {
  /**
   * Every tap moves the roving tab stop, which re-renders the board's rows; each cell used to be
   * handed fresh objects and re-render with them — ~250 cells to move `tabIndex` on two.
   */
  it("re-draws a handful of cells when a tap moves the tab stop", async () => {
    openBookings();
    const cell = await screen.findByRole("button", { name: /^Book Court 2 at 16:15/ });
    await waitFor(() => expect(verdicts.count).toBeGreaterThan(20));
    const before = verdicts.count;
    await act(async () => { fireEvent.focus(cell); fireEvent.click(cell); });
    await screen.findByRole("dialog", { name: "Book sheet" });
    expect(verdicts.count - before).toBeLessThan(10);
  });
});

describe("the grid under an open sheet", () => {
  /**
   * A modal sheet sets `pointer-events: none` on <body>; inherited, it restyled every node of the
   * grid (56 ms at 4x CPU) on opening and again on closing. The grid states its own value from
   * the sheet's opening until its close has finished, so the change stops at the grid's edge.
   */
  it("holds its own pointer-events from the sheet's opening until its focus has returned", async () => {
    openBookings();
    const grid = await screen.findByRole("grid");
    expect(grid.style.pointerEvents).toBe("");
    fireEvent.click(await screen.findByRole("button", { name: /^Book Court 2 at 16:15/ }));
    await screen.findByRole("dialog", { name: "Book sheet" });
    expect(grid.style.pointerEvents).toBe("auto");

    // Closed but still animating out: the body is still `none`, so the grid keeps its own value.
    await act(async () => { sheets.book?.onOpenChange(false); });
    expect(grid.style.pointerEvents).toBe("auto");
    // The close has finished — its focus return — and the grid inherits again.
    await act(async () => { sheets.book?.onCloseAutoFocus?.(new Event("focusout", { cancelable: true })); });
    await waitFor(() => expect(grid.style.pointerEvents).toBe(""));
  });
});
