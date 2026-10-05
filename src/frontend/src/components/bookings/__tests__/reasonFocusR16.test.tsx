import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { stubFetch } from "@/test/harness";
import { CANCEL_SHEET, LIFT_HOLD_SHEET } from "@/lib/bookingsCopy";
import { CancelSheet } from "../CancelSheet";
import { LiftHoldSheet } from "../LiftHoldSheet";
import type { GridBooking } from "../types";

/**
 * R16 X16-3 — a sheet that needs a reason does not refuse in silence. Pressing its verb with the
 * reason empty put the complaint under the field and left the keyboard on the button: a screen
 * reader heard nothing, and a keyboard had to hunt for the field. Like the desk's Sell sheet
 * (`focusFirstComplaint`), the keyboard now goes to the field, which carries the complaint as its
 * description — so landing there says what is missing.
 */

const THEIRS: GridBooking = {
  bookingId: "bk-9", courtId: "c1", courtName: "Court 1",
  startsAt: "2030-09-09T16:00:00.000Z", endsAt: "2030-09-09T16:45:00.000Z", whenLabel: "Mon 9 Sep, 18:00",
  mine: false, memberFirstName: "Thandi", memberPhotoUrl: null, checkedIn: null, amountChargedMinutes: 50,
  timezone: "Africa/Johannesburg",
};
const QUOTE = {
  bookingId: "bk-9", amountChargedMinutes: 50, refundMinutes: 50, penaltyMinutes: 0, penaltyPct: 30,
  penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false,
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Providers({ children }: { children: ReactNode }) {
  return <MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter>;
}

describe("R16 X16-3 — a missing reason takes the keyboard to the reason", () => {
  it.each([
    ["one member's booking", [THEIRS]],
    ["two members' bookings", [THEIRS, { ...THEIRS, bookingId: "bk-10", courtName: "Court 2", memberFirstName: "Owen" }]],
  ])("the club's cancel (%s): Cancel with no reason focuses the reason, which says what is missing", async (_name, bookings) => {
    const stub = stubFetch([
      { path: "/api/v1/bookings/bk-9/cancellation-quote", body: QUOTE },
      { path: "/api/v1/bookings/bk-10/cancellation-quote", body: { ...QUOTE, bookingId: "bk-10" } },
    ]);
    const user = userEvent.setup();
    render(<CancelSheet open onOpenChange={() => {}} bookings={bookings} isAdmin onCancelled={() => {}} />, { wrapper: Providers });
    const confirm = await screen.findByRole("button", { name: CANCEL_SHEET.confirm(bookings.length) });
    await user.click(confirm);
    const reason = screen.getByRole("textbox", { name: CANCEL_SHEET.reasonLabel });
    await waitFor(() => expect(reason).toHaveFocus());
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(reason).toHaveAccessibleDescription(expect.stringContaining(CANCEL_SHEET.reasonMissing));
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("lifting a hold: Lift with no reason focuses the reason, which says what is missing", async () => {
    const onLift = vi.fn();
    const user = userEvent.setup();
    render(
      <LiftHoldSheet hold={{ blockId: "blk-1", where: "Court 1 at 17:00", label: "Coaching" }} open onOpenChange={() => {}} onLift={onLift} />,
      { wrapper: Providers },
    );
    await user.click(screen.getByRole("button", { name: LIFT_HOLD_SHEET.confirm }));
    const reason = screen.getByRole("textbox", { name: LIFT_HOLD_SHEET.reasonLabel });
    await waitFor(() => expect(reason).toHaveFocus());
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(reason).toHaveAccessibleDescription(expect.stringContaining(LIFT_HOLD_SHEET.reasonMissing));
    expect(onLift).not.toHaveBeenCalled();
  });
});
