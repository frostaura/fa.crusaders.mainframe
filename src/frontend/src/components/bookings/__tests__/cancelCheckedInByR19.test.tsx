import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { stubFetch } from "@/test/harness";
import { CANCEL_SHEET } from "@/lib/bookingsCopy";
import { cancellationOutcome } from "@/lib/bookingErrors";
import type { BookingDetail, DetailPlayer } from "@/lib/playersApi";
import { ALEX_SEAT, adminView, seat } from "@/components/players/__tests__/detailKit";
import { CancelSheet, type CancelSheetProps } from "../CancelSheet";
import { litByOf } from "../checkedInBy";
import type { GridBooking } from "../types";

/**
 * R19 J19-3 — the desk's cancel sheet said "Thandi has already checked in" (the organiser, by
 * default) when only a partner had scanned. The quote carries no scanner; the booking record does:
 * the player row stamped at the instant the court was lit is who lit it. Nobody is named when the
 * record does not say (a payer lit it) or will not read. A member's own refused booking says the
 * same: "You've" only for their own scan. Fixtures vary: one partner, two partners, seated and
 * seatless organiser, a payer.
 */

const ID = "bk-desk";
const LIT = "2030-09-09T15:58:00.000123Z";
const LATER = "2030-09-09T16:03:00Z";
const BOOKING: GridBooking = {
  bookingId: ID, courtId: "c2", courtName: "Court 2",
  startsAt: "2030-09-09T16:00:00.000Z", endsAt: "2030-09-09T16:45:00.000Z", whenLabel: "Mon 9 Sep, 18:00",
  mine: false, memberFirstName: "Thandi", memberPhotoUrl: null, checkedIn: true, amountChargedMinutes: 60,
  timezone: "Africa/Johannesburg",
};
const QUOTE = {
  bookingId: ID, amountChargedMinutes: 60, refundMinutes: 0, penaltyMinutes: 0, penaltyPct: 30,
  penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: true, alreadyStarted: true,
};
const THANDI = "u-thandi";
const organiserSeat = (at: string | null) => seat({ user_id: THANDI, name: "Thandi Mokoena", checked_in_at: at });
const partner = (name: string, n: number, at: string | null) =>
  seat({ ...ALEX_SEAT, participant_id: `p-${n}`, user_id: `u-${n}`, seat: n, team: n > 2 ? "B" : "A", name, status: "accepted", checked_in_at: at });
const record = (players: DetailPlayer[], over: Partial<BookingDetail> = {}) => adminView({
  booking_id: ID, players, organiser: { user_id: THANDI, name: "Thandi Mokoena", photo_url: null },
  attendance: { checked_in_at: LIT, players_checked_in: players.filter((p) => p.checked_in_at).length },
  ...over,
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Providers({ children }: { children: ReactNode }) {
  return <MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter>;
}

function open(props: Partial<CancelSheetProps> = {}) {
  render(<CancelSheet open onOpenChange={() => {}} bookings={[BOOKING]} isAdmin onCancelled={() => {}} {...props} />, { wrapper: Providers });
}

function serve(detail: unknown, id = ID) {
  return stubFetch([
    { path: `/api/v1/bookings/${id}/cancellation-quote`, body: { ...QUOTE, bookingId: id } },
    ...(detail === null ? [] : [{ path: `/api/v1/bookings/${id}`, body: detail }]),
    { method: "POST", path: `/api/v1/admin/bookings/${id}/cancel`, body: { refunded_minutes: 0, penalty_minutes: 0 } },
  ]);
}

describe("R19 J19-3 — the desk's sheet names who actually checked in", () => {
  it("only a partner scanned (one partner): the partner, never the organiser", async () => {
    serve(record([organiserSeat(null), partner("Owen Partner", 2, LIT)]));
    open();
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText(CANCEL_SHEET.checkedIn("Owen"))).toBeInTheDocument();
    expect(dialog.textContent).not.toContain(CANCEL_SHEET.checkedIn("Thandi"));
  });

  it("two partners, the second lit it and the first came later: the one whose scan lit it", async () => {
    serve(record([organiserSeat(null), partner("Owen Partner", 2, LATER), partner("Pia Partner", 3, LIT)]));
    open();
    expect(await screen.findByText(CANCEL_SHEET.checkedIn("Pia"))).toBeInTheDocument();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/Owen has|Thandi has/);
  });

  it("the organiser's own scan lit it, a partner came later: the organiser", async () => {
    serve(record([organiserSeat(LIT), partner("Owen Partner", 2, LATER)]));
    open();
    expect(await screen.findByText(CANCEL_SHEET.checkedIn("Thandi"))).toBeInTheDocument();
  });

  it("a seatless game: the organiser row read at the booking's instant is the organiser", async () => {
    serve(record([seat({ participant_id: null, user_id: THANDI, name: "Thandi Mokoena", checked_in_at: LIT })]));
    open();
    expect(await screen.findByText(CANCEL_SHEET.checkedIn("Thandi"))).toBeInTheDocument();
  });

  it("a pay-for payer lit it (no player stamped at that instant): nobody is named", async () => {
    serve(record([organiserSeat(null), partner("Owen Partner", 2, null)], {
      money: { ...adminView().money, paid_by: { user_id: "u-pam", name: "Pam Payer", photo_url: null }, paid_by_minutes: 60 },
    }));
    open();
    expect(await screen.findByText(CANCEL_SHEET.checkedInSomeone)).toBeInTheDocument();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/Thandi has|Owen has|Pam has/);
  });

  it("the record will not read: nobody is named, and the cancel is still offered", async () => {
    serve(null);
    open();
    expect(await screen.findByText(CANCEL_SHEET.checkedInSomeone)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) })).toBeInTheDocument();
  });

  it("the toast after the cancel names the partner who scanned, not the organiser", async () => {
    serve(record([organiserSeat(null), partner("Owen Partner", 2, LIT)]));
    open();
    await screen.findByText(CANCEL_SHEET.checkedIn("Owen"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Court flooded" } });
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    await waitFor(() => expect(document.querySelector("[data-toast]")?.textContent).toContain(cancellationOutcome(0, 0, "Owen")));
    expect(document.querySelector("[data-toast]")?.textContent).not.toContain("Thandi");
  });

  it("the toast with the record unread names nobody", async () => {
    serve(null);
    open();
    await screen.findByText(CANCEL_SHEET.checkedInSomeone);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Court flooded" } });
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    await waitFor(() => expect(document.querySelector("[data-toast]")?.textContent).toContain(cancellationOutcome(0, 0, null)));
  });
});

describe("R19 J19-3 — a member's own refused booking says who checked in", () => {
  const MINE: GridBooking = { ...BOOKING, bookingId: "bk-mine", mine: true, memberFirstName: null };
  const mine = (players: DetailPlayer[]) => ({ ...record(players), booking_id: "bk-mine", viewer: { role: "organiser", participant_id: "p-1" } });

  it("only the partner scanned: 'Owen has checked in', never 'You've'", async () => {
    serve(mine([organiserSeat(null), partner("Owen Partner", 2, LIT)]), "bk-mine");
    open({ bookings: [MINE], isAdmin: false });
    expect(await screen.findByText(CANCEL_SHEET.refusedCheckedIn("Owen", false))).toBeInTheDocument();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/You've/);
    expect(screen.queryByRole("button", { name: CANCEL_SHEET.confirm(1) })).toBeNull();
  });

  it("their own scan: 'You've checked in'", async () => {
    serve(mine([organiserSeat(LIT), partner("Owen Partner", 2, LATER)]), "bk-mine");
    open({ bookings: [MINE], isAdmin: false });
    expect(await screen.findByText(CANCEL_SHEET.refusedCheckedIn(null, true))).toBeInTheDocument();
  });
});

describe("R19 J19-3 — litByOf", () => {
  it("compares instants, not spellings", () => {
    const d = record([organiserSeat(null), partner("Owen Partner", 2, "2030-09-09T17:58:00.000123+02:00")]);
    expect(litByOf(d)).toEqual({ kind: "player", name: "Owen" });
  });

  it("not checked in at all: unknown", () => {
    expect(litByOf(record([organiserSeat(LIT)], { attendance: { checked_in_at: null, players_checked_in: 1 } }))).toEqual({ kind: "unknown" });
  });

  it("a guest row (no member) is never the scanner", () => {
    expect(litByOf(record([organiserSeat(null), seat({ ...partner("Guest", 2, LIT), user_id: null, kind: "guest" })]))).toEqual({ kind: "unknown" });
  });
});
