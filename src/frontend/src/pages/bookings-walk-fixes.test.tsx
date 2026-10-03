import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { forgetClubZone } from "../lib/clubZone";
import { BOOKINGS_COPY, PENDING_CELL, adminWalletNote } from "../lib/bookingsCopy";
import { emptyWalletSentence } from "../lib/gridCopy";
import { refuse, signOut } from "../test/harness";
import { COURT_A, COURT_B, dayFixture, openBookings, resetSheets, sast, sheets, slotRow } from "../test/bookingsKit";

vi.mock("../components/bookings/BookSheet", async () => (await import("../test/fakeSheets")).bookSheetModule);
vi.mock("../components/bookings/CancelSheet", async () => (await import("../test/fakeSheets")).cancelSheetModule);

/**
 * The P4 headed walk's findings on the Bookings grid, each pinned where a person met it: an admin
 * at 0 minutes with four courts, and a member booking through the sheet.
 *
 * <ul>
 *   <li><b>God mode on the grid (R19).</b> An admin at or below zero was told "you can't book yet"
 *   — false: the desk books at ≤0 and the API lets it.</li>
 *   <li><b>Two courts at one time.</b> Reported as silently dropping the first pick; the grid has
 *   no such rule and the booking API has none either (a payer may hold two courts at once —
 *   `PayerLock` serialises the money, it does not forbid it). Pinned so a pick is never dropped.</li>
 *   <li><b>A booking just made</b> wears a provisional id until the confirming read lands; it
 *   must not be openable (a cancel for an id the server does not know).</li>
 *   <li><b>An admin's own groups' windows</b> must not be painted as restrictions: the API
 *   exempts an admin actor from every window and cap.</li>
 * </ul>
 */
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => { forgetClubZone(); resetSheets(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

const toggle = () => screen.getByRole("button", { name: BOOKINGS_COPY.selectOn });
const chosen = () => screen.getAllByRole("gridcell").filter((c) => c.getAttribute("aria-selected") === "true");

describe("the wallet notice follows the actor's role (R19)", () => {
  it("gives an admin below zero a calm note, never the member's refusal", async () => {
    openBookings({ isAdmin: true, balance: -100 });
    const note = await screen.findByText(adminWalletNote(-100));
    expect(note.textContent).toBe("Your balance is minus 1 hour 40 minutes. As an admin you can still book — going below zero is recorded.");
    expect(document.body.textContent).not.toMatch(/can't book yet|You owe/);
    // Nothing is blocked, so there is no call to action; the note wears info, not warning.
    const notice = note.closest('[role="status"]')!;
    expect(within(notice as HTMLElement).queryByRole("link")).toBeNull();
    expect(notice.className).toContain("bg-info-soft");
    // …and the grid still offers the slots — the API will book them.
    expect(screen.getByRole("button", { name: /^Book Court 1 at 16:00/ })).toBeTruthy();
  });

  it("gives an admin at exactly zero the same note", async () => {
    openBookings({ isAdmin: true, balance: 0 });
    expect(await screen.findByText(adminWalletNote(0))).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/You have no minutes/);
  });

  it("keeps the member's banner, with its Buy minutes, for a member", async () => {
    openBookings({ isAdmin: false, balance: -100 });
    // What a slot takes is the day's slice (15 min), never a price (P13 §3.12).
    expect(await screen.findByText(emptyWalletSentence(-100, 15))).toBeTruthy();
    expect(screen.getByText("You owe 1 hour 40 minutes, so you can't book yet. A slot here takes 15 minutes.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Buy minutes" })).toHaveAttribute("href", "/wallet/buy");
    expect(document.body.textContent).not.toContain("As an admin");
  });
});

describe("two courts at the same time", () => {
  it("keeps both picks — nothing is ever dropped silently — and hands both to the sheet", async () => {
    openBookings({ isAdmin: true, balance: 0 });
    await screen.findByRole("grid");
    await act(async () => { fireEvent.click(toggle()); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Book Court 1 at 16:45/ })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Book Court 2 at 16:45/ })); });
    expect(chosen().map((c) => c.getAttribute("aria-label"))).toEqual(["Court 1 at 16:45", "Court 2 at 16:45"]);
    const bar = screen.getByRole("toolbar", { name: BOOKINGS_COPY.actionBarLabel });
    // Two 15-minute slices: the bar counts the minutes they take (P13 §3.12).
    expect(within(bar).getByText("2 slots · 30 minutes")).toBeTruthy();
    await act(async () => { fireEvent.click(within(bar).getByRole("button", { name: BOOKINGS_COPY.bookSelection })); });
    expect(sheets.book?.slots.map((s) => [s.courtId, s.startsAt])).toEqual([[COURT_A, sast(16, 45)], [COURT_B, sast(16, 45)]]);
  });
});

describe("a booking just made, before the confirming read", () => {
  it("is drawn pending and cannot be opened, cancelled or chosen until the real id lands", async () => {
    let phase: "before" | "failing" | "confirmed" = "before";
    const booked = dayFixture({
      slots: [slotRow({ startsAtUtc: sast(16), endsAtUtc: sast(16, 15), isMine: true, bookingId: "bk-9", ownerUserId: null })],
    });
    openBookings({
      routes: [{
        path: "/api/v1/schedule",
        // The confirming read fails at first, so the painted booking stands — as it does for the
        // round trip in which a person can tap it.
        respond: () => (phase === "failing" ? refuse(503, { error: "unavailable" }) : phase === "confirmed" ? booked : dayFixture()),
      }],
    });
    const free = await screen.findByRole("button", { name: /^Book Court 1 at 16:00/ });
    await act(async () => { fireEvent.click(free); });
    expect(sheets.book?.open).toBe(true);
    phase = "failing";
    await act(async () => {
      sheets.book!.onBooked!({ booked: sheets.book!.slots, ownBalanceAfter: 850, forMemberId: null, hold: false });
    });

    const cell = screen.getByRole("gridcell", { name: "Court 1 at 16:00" });
    const pending = within(cell).getByRole("button");
    expect(pending).toHaveAccessibleName(PENDING_CELL.label("Court 1 at 16:00"));
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending).not.toHaveAttribute("data-watermark");
    await act(async () => { fireEvent.click(pending); });
    expect(sheets.cancel?.open ?? false).toBe(false);

    // Not choosable either: a bulk cancel would carry the provisional id.
    await act(async () => { fireEvent.click(toggle()); });
    expect(cell).not.toHaveAttribute("data-select-key");
    expect(cell.querySelector("[data-cell-check]")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: BOOKINGS_COPY.selectOff })); });

    // The read lands with the real id: the cell is the viewer's own booking, and it opens.
    phase = "confirmed";
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: BOOKINGS_COPY.refresh })); });
    const mine = await screen.findByRole("button", { name: /^Cancel your booking on Court 1 at 16:00/ });
    expect(mine).not.toHaveAttribute("aria-disabled");
    await act(async () => { fireEvent.click(mine); });
    await waitFor(() => expect(sheets.cancel?.open).toBe(true));
    expect(sheets.cancel?.bookings.map((b) => b.bookingId)).toEqual(["bk-9"]);
  });
});

describe("the grid is the ACTOR's rules", () => {
  // The admin's own group allows 16:00–17:00 only, and this payload does not say the admin is exempt.
  const WINDOWED = dayFixture({
    rules: {
      groups: [{ id: "g1", name: "Non-league members" }],
      allowedWindows: [{ start: "16:00", end: "17:00" }],
      clubHours: { start: "16:00", end: "18:00" },
      remainingToday: null, adminExempt: false,
    },
  });

  it("does not paint an admin's own group windows as restrictions — the API exempts the admin", async () => {
    openBookings({ isAdmin: true, day: WINDOWED });
    await screen.findByRole("grid");
    expect(screen.getByRole("button", { name: /^Book Court 1 at 17:15/ })).toBeTruthy();
    expect(document.querySelectorAll('[role="grid"] button[aria-label*="outside the times you can book"]')).toHaveLength(0);
    // No rate line at all — P13 removed group prices (§3.12).
    expect(document.body.textContent).not.toMatch(/your rate|rate\./i);
  });

  it("still paints them for a member, who is held to them", async () => {
    openBookings({ isAdmin: false, day: WINDOWED });
    await screen.findByRole("grid");
    expect(screen.queryByRole("button", { name: /^Book Court 1 at 17:15/ })).toBeNull();
    expect(document.querySelectorAll('[role="grid"] button[aria-label*="outside the times you can book"]').length).toBeGreaterThan(0);
  });
});
