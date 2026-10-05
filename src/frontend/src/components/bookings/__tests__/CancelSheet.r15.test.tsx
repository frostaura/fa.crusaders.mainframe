import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { stubFetch } from "@/test/harness";
import { CANCEL_SHEET, refusalReason } from "@/lib/bookingsCopy";
import { ALREADY_CHECKED_IN_TEXT } from "@/lib/bookingErrors";
import { CancelSheet, type CancelSheetProps } from "../CancelSheet";
import type { GridBooking } from "../types";

/**
 * R15 D15-5 — a member may not cancel a booking they have checked in to. The grid's sheet reads the
 * quote's `checkedIn` and refuses up front, in the 409's own words, with no Cancel to press: the
 * member never reaches the server's `already_checked_in`. The club (an admin) still can.
 */

const MINE: GridBooking = {
  bookingId: "bk-1", courtId: "c1", courtName: "Court 1",
  startsAt: "2030-09-09T16:00:00.000Z", endsAt: "2030-09-09T16:45:00.000Z", whenLabel: "Mon 9 Sep, 18:00",
  mine: true, memberFirstName: null, memberPhotoUrl: null, checkedIn: null, amountChargedMinutes: 50,
  timezone: "Africa/Johannesburg",
};
const OTHER: GridBooking = { ...MINE, bookingId: "bk-2", courtName: "Court 2" };
const quote = (id: string, checkedIn: boolean) => ({
  bookingId: id, amountChargedMinutes: 50, refundMinutes: checkedIn ? 0 : 50, penaltyMinutes: 0, penaltyPct: 30,
  penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn, alreadyStarted: false,
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Providers({ children }: { children: ReactNode }) {
  return <MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter>;
}

function open(props: Partial<CancelSheetProps>) {
  render(<CancelSheet open onOpenChange={() => {}} bookings={[MINE]} isAdmin={false} onCancelled={() => {}} {...props} />, { wrapper: Providers });
}

describe("R15 D15-5 — the grid's sheet refuses a checked-in member cancel up front", () => {
  it("one checked-in booking: the refusal in words, and no Cancel to press", async () => {
    const stub = stubFetch([{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: quote("bk-1", true) }]);
    open({});
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText(ALREADY_CHECKED_IN_TEXT)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: CANCEL_SHEET.confirm(1) })).toBeNull();
    expect(within(dialog).getByRole("button", { name: CANCEL_SHEET.keep(1) })).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("an admin's OWN checked-in booking (the member route) is refused too", async () => {
    stubFetch([{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: quote("bk-1", true) }]);
    open({ isAdmin: true });
    expect(await screen.findByText(ALREADY_CHECKED_IN_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: CANCEL_SHEET.confirm(1) })).toBeNull();
  });

  it("not checked in: Cancel is offered as before", async () => {
    stubFetch([{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: quote("bk-1", false) }]);
    open({});
    expect(await screen.findByRole("button", { name: CANCEL_SHEET.confirm(1) })).toBeInTheDocument();
    expect(screen.queryByText(ALREADY_CHECKED_IN_TEXT)).toBeNull();
  });

  it("two bookings, one checked in: that row says why, and only the other is offered", async () => {
    stubFetch([
      { path: "/api/v1/bookings/bk-1/cancellation-quote", body: quote("bk-1", true) },
      { path: "/api/v1/bookings/bk-2/cancellation-quote", body: quote("bk-2", false) },
    ]);
    open({ bookings: [MINE, OTHER] });
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText(refusalReason("already_checked_in"))).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: CANCEL_SHEET.confirm(1) })).toBeInTheDocument());
  });

  it("the club (an admin, a member's booking) is not refused", async () => {
    stubFetch([{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: quote("bk-1", true) }]);
    open({ isAdmin: true, bookings: [{ ...MINE, mine: false, memberFirstName: "Thandi" }] });
    expect(await screen.findByText(CANCEL_SHEET.checkedIn("Thandi"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) })).toBeInTheDocument();
  });
});
