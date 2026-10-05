import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { ApiError } from "@/lib/api";
import { CANCEL_SHEET, refusalReason } from "@/lib/bookingsCopy";
import { cancellationOutcome, describeBookingError } from "@/lib/bookingErrors";
import { DETAIL_CANCEL, DETAIL_CANCELLED } from "@/lib/playersCopy";
import { BOOKING, DETAIL_PATH, detail, renderDetail, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const QUOTE = {
  bookingId: BOOKING, amountChargedMinutes: 100, refundMinutes: 100, penaltyMinutes: 0, penaltyPct: 50,
  penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false,
};

const CANCELLED = detail({
  status: "cancelled",
  permissions: { ...detail().permissions, can_invite: false, can_change_split: false, can_cancel: false },
});

/**
 * R15 X15-7 — a cancel whose reply was lost, from the booking's own page: the toast said "the
 * refund isn't shown here — it's on your wallet" while the page's re-read Money card showed the
 * refund under it. The lost-reply sentence now claims nothing about what this screen shows.
 */
describe("R15 X15-7 — the lost-reply cancel toast", () => {
  it("never says the refund isn't shown here; it points at the wallet", async () => {
    serve({
      detail: { path: DETAIL_PATH, body: detail(), sequence: [detail(), CANCELLED, CANCELLED] },
      extra: [
        { path: `${DETAIL_PATH}/cancellation-quote`, body: QUOTE },
        { method: "POST", path: `${DETAIL_PATH}/cancel`, status: 504, body: { error: "gateway_timeout" } },
      ],
    });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_CANCEL.open }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    await screen.findByText(DETAIL_CANCELLED.banner);
    const toast = await screen.findByText(cancellationOutcome(null, null));
    expect(toast.textContent).not.toMatch(/isn't shown here/);
    expect(toast.textContent).toMatch(/wallet/);
  });

  it("the sentence, for the member and for an admin acting for Mia", () => {
    expect(cancellationOutcome(null, null)).not.toMatch(/shown here/);
    expect(cancellationOutcome(null, null, "Mia")).toMatch(/Mia's wallet/);
  });
});

/**
 * R15 D15-5 — a member may not self-cancel a booking they have checked in to (the server answers
 * 409 `already_checked_in`; the club cancels from its own page). The page offers no Cancel once
 * checked in, and the refusal, if one arrives (a check-in landing while the sheet was open), says
 * why in words.
 */
describe("R15 D15-5 — a checked-in booking", () => {
  it("offers no Cancel on the booking's page once checked in, even if the server still says can_cancel", async () => {
    serve({ detail: detail({ attendance: { checked_in_at: "2026-09-30T15:58:00Z", players_checked_in: 1 } }) });
    renderDetail();
    await screen.findByText("Court 1", { exact: false });
    await waitFor(() => expect(screen.queryByRole("button", { name: DETAIL_CANCEL.open })).toBeNull());
  });

  it("not checked in: Cancel is offered", async () => {
    serve({ detail: detail() });
    renderDetail();
    expect(await screen.findByRole("button", { name: DETAIL_CANCEL.open })).toBeInTheDocument();
  });

  it("a 409 already_checked_in in the sheet says the member checked in, never a generic failure", async () => {
    serve({
      detail: detail(),
      extra: [
        { path: `${DETAIL_PATH}/cancellation-quote`, body: QUOTE },
        { method: "POST", path: `${DETAIL_PATH}/cancel`, status: 409, body: { error: "already_checked_in" } },
      ],
    });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_CANCEL.open }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    const said = describeBookingError(new ApiError(409, { error: "already_checked_in" }), CANCEL_SHEET.fallback, { action: "cancel" });
    expect(said).toMatch(/checked in/);
    expect(await screen.findByText(said, { exact: false }, { timeout: 4000 })).toBeInTheDocument();
  });

  it("a bulk row refused already_checked_in has its own reason", () => {
    expect(refusalReason("already_checked_in")).toMatch(/checked in/);
  });
});
