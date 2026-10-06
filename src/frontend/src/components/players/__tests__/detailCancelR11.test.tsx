import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { CANCEL_SHEET } from "@/lib/bookingsCopy";
import { DETAIL_CANCEL, DETAIL_CANCELLED } from "@/lib/playersCopy";
import { DETAIL_PATH, detail, renderDetail, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R11 X11-2 — cancelling from a booking's page announced twice (the page's polite notice "The
 * booking is cancelled." AND the sheet's toast "Booking cancelled. 30 minutes back…"), and focus
 * fell to `<main>` because the Cancel panel unmounts with its trigger. One announcement — the
 * sheet's, which carries the figures — and focus on the cancelled banner.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const QUOTE = {
  bookingId: "b", amountChargedMinutes: 100, refundMinutes: 100, penaltyMinutes: 0, penaltyPct: 50,
  penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false,
};

describe("R11 X11-2 — a cancel from the booking's page", () => {
  it("is said once, and focus lands on the cancelled banner", async () => {
    const cancelled = detail({
      status: "cancelled",
      permissions: { ...detail().permissions, can_invite: false, can_change_split: false, can_cancel: false },
    });
    serve({
      detail: { path: DETAIL_PATH, body: detail(), sequence: [detail(), cancelled] },
      extra: [
        { path: `${DETAIL_PATH}/cancellation-quote`, body: QUOTE },
        { method: "POST", path: `${DETAIL_PATH}/cancel`, body: { refunded_minutes: 100, penalty_minutes: 0 } },
      ],
    });
    const seen: string[] = [];
    const watch = new MutationObserver(() => {
      if (document.body.textContent?.includes(DETAIL_CANCEL.cancelled)) seen.push("notice");
    });
    watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_CANCEL.open }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    const banner = (await screen.findByText(DETAIL_CANCELLED.banner)).closest("[data-cancelled]") as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(banner), { timeout: 4000 });
    watch.disconnect();
    expect(seen).toHaveLength(0);
    // The sheet's toast, with the figures, is the one announcement.
    // R19 X19-3 — a toast is `[data-toast]` (its words arrive in the viewport's one polite region).
    expect([...document.querySelectorAll("[role=status], [data-toast]")].filter((n) => /cancel/i.test(n.textContent ?? ""))).toHaveLength(1);
  });
});
