import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceTransport } from "@/lib/liveBalance";
import { refuse, signOut, stubFetch } from "@/test/harness";
import { CANCEL_SHEET } from "@/lib/bookingsCopy";
import { CANCEL_ENDED } from "@/lib/cancelSheetCopy";
import { CancelSheet } from "../CancelSheet";
import type { GridBooking } from "../types";

/**
 * R19 L19-5 — a cancel the club refused for good (R18 L18-10) kept the sheet's opening words over
 * it: "Cancel this booking? Here's what goes back if you cancel now." above a refusal — nothing
 * goes back, nothing is being cancelled — and the refusal said "The schedule behind this is up to
 * date now." on the BOOKING page, where no schedule is behind it. The sheet now heads a final
 * refusal as what it is, and names the place behind it truthfully: the schedule, the booking's own
 * page, or a member's bookings list at the desk.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  signOut();
});

const quietStream: BalanceTransport = { open: () => Promise.resolve({ close: () => undefined }) };
const BOOKING: GridBooking = {
  bookingId: "bk-1", courtId: "c1", courtName: "Court 1",
  startsAt: "2030-09-09T16:00:00.000Z", endsAt: "2030-09-09T16:45:00.000Z", whenLabel: "Mon 9 Sep, 18:00",
  mine: true, memberFirstName: null, memberPhotoUrl: null, checkedIn: null, amountChargedMinutes: 50,
  timezone: "Africa/Johannesburg",
};
const THEIRS: GridBooking = { ...BOOKING, mine: false, memberFirstName: "Thandi" };
const quote = {
  bookingId: "bk-1", amountChargedMinutes: 50, refundMinutes: 50, penaltyMinutes: 0, penaltyPct: 30,
  penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false,
};
const SCHEDULE_CLAUSE = "The schedule behind this is up to date now.";

function openAt(path: string, refusal: { status: number; body: unknown }, booking: GridBooking = BOOKING) {
  const admin = !booking.mine;
  stubFetch([
    { path: "/api/v1/admin/bookings/bk-1/cancellation-quote", body: quote },
    { path: "/api/v1/bookings/bk-1/cancellation-quote", body: quote },
    { method: "POST", path: admin ? "/api/v1/admin/bookings/bk-1/cancel" : "/api/v1/bookings/bk-1/cancel", body: refuse(refusal.status, refusal.body) },
  ]);
  function Providers({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <BalanceProvider transport={quietStream}><ToastProvider>{children}</ToastProvider></BalanceProvider>
        </AuthProvider>
      </MemoryRouter>
    );
  }
  render(<CancelSheet open onOpenChange={() => undefined} bookings={[booking]} isAdmin={admin} onStale={() => undefined} />, { wrapper: Providers });
  return screen.getByRole("dialog");
}

async function press(dialog: HTMLElement, admin = false) {
  if (admin) fireEvent.change(await within(dialog).findByRole("textbox"), { target: { value: "Booked in error" } });
  fireEvent.click(await within(dialog).findByRole("button", { name: CANCEL_SHEET.confirm(1) }));
  await waitFor(() => expect(dialog.querySelector("[data-sheet-refusal]")).not.toBeNull());
  return dialog.querySelector<HTMLElement>("[data-sheet-refusal]")!;
}

const PLACES = [
  ["the booking's own page", "/bookings/bk-1", CANCEL_ENDED.behind.booking],
  ["a member's bookings at the desk", "/admin/members/u1/bookings", CANCEL_ENDED.behind.memberBookings],
  ["the schedule", "/bookings", SCHEDULE_CLAUSE],
] as const;

describe("R19 L19-5 — a final cancel refusal says what happened, and where", () => {
  for (const [label, path, behind] of PLACES) {
    it(`already cancelled, from ${label}: no "Cancel this booking? Here's what goes back", and the right place behind`, async () => {
      const dialog = openAt(path, { status: 409, body: { error: "booking_not_open" } });
      const alert = await press(dialog);
      await waitFor(() => expect(within(dialog).getByRole("heading")).toHaveTextContent(CANCEL_ENDED.title));
      expect(dialog).not.toHaveTextContent(CANCEL_SHEET.title(1));
      expect(dialog).not.toHaveTextContent(CANCEL_SHEET.description(1));
      expect(dialog).toHaveAccessibleDescription(CANCEL_ENDED.description);
      expect(alert).toHaveTextContent(behind);
      if (behind !== SCHEDULE_CLAUSE) expect(alert).not.toHaveTextContent(/schedule/i);
    });
  }

  it("gone (booking_not_found) from the booking page names the booking page, not the schedule", async () => {
    const dialog = openAt("/bookings/bk-1", { status: 404, body: { error: "booking_not_found" } });
    const alert = await press(dialog);
    expect(alert).toHaveTextContent(CANCEL_ENDED.behind.booking);
    expect(alert).not.toHaveTextContent(/schedule/i);
  });

  it("the desk's cancel of a played booking, from the admin booking page: the final heading, its own reason", async () => {
    const dialog = openAt("/bookings/bk-1", { status: 409, body: { error: "not_cancellable", status: "completed" } }, THEIRS);
    const alert = await press(dialog, true);
    await waitFor(() => expect(within(dialog).getByRole("heading")).toHaveTextContent(CANCEL_ENDED.title));
    expect(alert).toHaveTextContent(/has been played/);
    expect(dialog).not.toHaveTextContent(CANCEL_SHEET.description(1));
  });

  it("a refusal that can be tried again keeps the sheet's own question", async () => {
    const dialog = openAt("/bookings/bk-1", { status: 429, body: { error: "rate_limited", retry_after_seconds: 5 } });
    await press(dialog);
    expect(within(dialog).getByRole("heading")).toHaveTextContent(CANCEL_SHEET.title(1));
    expect(dialog).toHaveTextContent(CANCEL_SHEET.description(1));
  });
});
