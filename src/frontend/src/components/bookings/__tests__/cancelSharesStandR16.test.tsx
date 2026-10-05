import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { stubFetch } from "@/test/harness";
import { ADMIN_CANCEL } from "@/lib/adminCancelCopy";
import { CANCEL_SHEET } from "@/lib/bookingsCopy";
import { ALEX_SEAT, adminView, seat } from "@/components/players/__tests__/detailKit";
import { CancelSheet, type CancelSheetProps } from "../CancelSheet";
import type { GridBooking } from "../types";

/**
 * R16 J16-7 — the club cancelling a started, checked-in split session: the sheet's rows read
 * "Paid 15 · Back to Sam 0" and said nothing of the partners, whose shares STAND (they stay with the
 * organiser). The sheet says so by name and figure, in the panel's own words — off the booking's
 * record read when the quote says somebody checked in, so the grid's sheet says it too.
 */

const ID = "bk-split";
const BOOKING: GridBooking = {
  bookingId: ID, courtId: "c2", courtName: "Court 2",
  startsAt: "2030-09-09T16:00:00.000Z", endsAt: "2030-09-09T16:45:00.000Z", whenLabel: "Mon 9 Sep, 18:00",
  mine: false, memberFirstName: "Sam", memberPhotoUrl: null, checkedIn: true, amountChargedMinutes: 60,
  timezone: "Africa/Johannesburg",
};
const quote = (checkedIn: boolean) => ({
  bookingId: ID, amountChargedMinutes: 60, refundMinutes: checkedIn ? 0 : 60, penaltyMinutes: 0, penaltyPct: 30,
  penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn, alreadyStarted: true,
});
const ORGANISER = seat({ user_id: "u-sam", name: "Sam Petersen" });
const partner = (name: string, paid: number, over: Record<string, unknown> = {}) =>
  seat({ ...ALEX_SEAT, participant_id: `p-${name}`, user_id: `u-${name}`, seat: 2, team: "A", name, status: "accepted", consented_minutes: 15, share_minutes: 15, paid_minutes: paid, ...over });
const record = (players: ReturnType<typeof seat>[]) => adminView({
  booking_id: ID, players, organiser: { user_id: "u-sam", name: "Sam Petersen", photo_url: null },
  attendance: { ...adminView().attendance, checked_in_at: "2030-09-09T15:58:00Z", players_checked_in: 1 },
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Providers({ children }: { children: ReactNode }) {
  return <MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter>;
}

function open(props: Partial<CancelSheetProps> = {}) {
  render(<CancelSheet open onOpenChange={() => {}} bookings={[BOOKING]} isAdmin onCancelled={() => {}} {...props} />, { wrapper: Providers });
}

function serve(checkedIn: boolean, detail: unknown) {
  return stubFetch([
    { path: `/api/v1/bookings/${ID}/cancellation-quote`, body: quote(checkedIn) },
    { path: `/api/v1/bookings/${ID}`, body: detail },
  ]);
}

describe("R16 J16-7 — the admin cancel sheet says the partners' shares stand", () => {
  it("one partner who paid: named, with the figure, staying with the organiser", async () => {
    serve(true, record([ORGANISER, partner("Owen Partner", 15)]));
    open();
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText(ADMIN_CANCEL.sharesStand(["Owen's 15 minutes"], "Sam"))).toBeInTheDocument();
    expect(within(dialog).getByText(CANCEL_SHEET.checkedIn("Sam"))).toBeInTheDocument();
  });

  it("two partners: both; one who paid nothing, or settled by hand, is not listed", async () => {
    serve(true, record([
      ORGANISER, partner("Owen Partner", 15), partner("Pia Partner", 10), partner("Zed Nopay", 0), partner("Hal Hand", 15, { settled_outside: true }),
    ]));
    open();
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText(ADMIN_CANCEL.sharesStand(["Owen's 15 minutes", "Pia's 10 minutes"], "Sam"))).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/Zed|Hal/);
  });

  it("an invited partner who has not accepted holds no standing share", async () => {
    serve(true, record([ORGANISER, partner("Owen Partner", 15, { status: "invited" })]));
    open();
    expect(await screen.findByText(CANCEL_SHEET.checkedIn("Sam"))).toBeInTheDocument();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/shares stand/);
  });

  it("nobody checked in: shares come back, the record is not read and nothing is said of them standing", async () => {
    const stub = serve(false, record([ORGANISER, partner("Owen Partner", 15)]));
    open();
    expect(await screen.findByRole("button", { name: CANCEL_SHEET.confirm(1) })).toBeInTheDocument();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/shares stand/);
    expect(stub.calls.some((c) => c.path === `/api/v1/bookings/${ID}`)).toBe(false);
  });

  it("the record will not read: the sheet still offers the cancel and claims nothing about shares", async () => {
    stubFetch([{ path: `/api/v1/bookings/${ID}/cancellation-quote`, body: quote(true) }]);
    open();
    expect(await screen.findByText(CANCEL_SHEET.checkedIn("Sam"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) })).toBeInTheDocument();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/shares stand/);
  });
});
