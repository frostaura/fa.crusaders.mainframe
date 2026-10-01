import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { CANCEL_SHEET } from "@/lib/bookingsCopy";
import { UNSURE_TEXT } from "@/lib/bookingErrors";
import { DETAIL_CANCEL, DETAIL_CANCELLED } from "@/lib/playersCopy";
import { BOOKING, DETAIL_PATH, detail, renderDetail, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R2 F2-2 — a cancel from the booking's own page whose reply was lost (a 504 after the club had
 * cancelled and refunded). The page re-reads the booking and says what it finds, never "couldn't
 * cancel" or "may or may not", and stops offering Cancel on a booking that is gone.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const QUOTE = {
  bookingId: BOOKING, amountChargedMinutes: 100, refundMinutes: 100, penaltyMinutes: 0, penaltyPct: 50,
  penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false,
};

const CANCELLED = detail({
  status: "cancelled",
  permissions: {
    can_invite: false, can_change_split: false, can_cancel: false, can_accept: false, can_decline: false,
    can_withdraw: false, withdraw_closes_at: "2026-09-30T14:00:00Z",
  },
});

async function pressCancel() {
  fireEvent.click(await screen.findByRole("button", { name: DETAIL_CANCEL.open }));
  const sheet = await screen.findByRole("dialog");
  fireEvent.click(within(sheet).getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
  return sheet;
}

describe("a cancel whose reply was lost (R2 F2-2)", () => {
  it("re-reads the booking: cancelled is said as cancelled, and Cancel is no longer offered", async () => {
    serve({
      detail: { path: DETAIL_PATH, body: detail(), sequence: [detail(), CANCELLED] },
      extra: [
        { path: `${DETAIL_PATH}/cancellation-quote`, body: QUOTE },
        { method: "POST", path: `${DETAIL_PATH}/cancel`, status: 504, body: { error: "gateway_timeout" } },
      ],
    });
    renderDetail();
    await pressCancel();
    expect(await screen.findByText(DETAIL_CANCELLED.banner)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: DETAIL_CANCEL.open })).toBeNull());
    expect(screen.queryByText(UNSURE_TEXT.cancel.unchecked)).toBeNull();
    expect(screen.queryByText(/may or may not/)).toBeNull();
    expect(screen.queryByText(/Couldn't cancel/)).toBeNull();
  });

  it("a booking still there after the lost reply says so — nothing cancelled, no credit moved", async () => {
    serve({
      detail: { path: DETAIL_PATH, body: detail() },
      extra: [
        { path: `${DETAIL_PATH}/cancellation-quote`, body: QUOTE },
        { method: "POST", path: `${DETAIL_PATH}/cancel`, status: 504, body: { error: "gateway_timeout" } },
      ],
    });
    renderDetail();
    const sheet = await pressCancel();
    expect(await within(sheet).findByText(UNSURE_TEXT.cancel.checked)).toBeInTheDocument();
  });
});
