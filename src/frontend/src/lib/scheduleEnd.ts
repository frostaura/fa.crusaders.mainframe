import { useCallback } from "react";
import { endpoints, type ScheduleDay } from "./api";
import { describeBookingError, provesStaleGrid } from "./bookingErrors";

/**
 * Lifting a club hold from the grid — the one slot-ending action that stays on the grid itself.
 *
 * <p>
 * Cancelling a booking moved into `CancelSheet` (P4): the sheet reads the quote, states the
 * figures and does the write. A hold charges nobody and refunds nobody, so it needs no sheet —
 * the lift button is its own confirmation, and it is optimistic: the hold leaves the grid the
 * moment the admin presses, and comes back with a sentence if the server refuses.
 * </p>
 */

type Toast = { push: (t: { tone: "success" | "danger"; text: string }) => void };

type Args = {
  day: ScheduleDay | null;
  setDay: React.Dispatch<React.SetStateAction<ScheduleDay | null>>;
  reconcile: () => Promise<void>;
  toast: Toast;
};

export const HOLD_LIFTED = "Hold lifted — the court is free again.";
export const HOLD_LIFT_FAILED = "Couldn't lift that hold.";

export function useHoldLift({ day, setDay, reconcile, toast }: Args) {
  return useCallback(async (blockId: string) => {
    const removed = day?.slots.filter((s) => s.bookingId === blockId) ?? [];
    setDay((d) => (d ? { ...d, slots: d.slots.filter((s) => s.bookingId !== blockId) } : d));
    try {
      await endpoints.adminUnblock(blockId);
      toast.push({ tone: "success", text: HOLD_LIFTED });
      void reconcile();
    } catch (err) {
      // Put it back before saying anything: the grid must never show a court free that is not.
      setDay((d) => (d ? { ...d, slots: [...d.slots, ...removed] } : d));
      if (provesStaleGrid(err)) await reconcile();
      toast.push({ tone: "danger", text: describeBookingError(err, HOLD_LIFT_FAILED) });
    }
  }, [day, setDay, reconcile, toast]);
}
