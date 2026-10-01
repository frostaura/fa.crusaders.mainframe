import { useCallback } from "react";
import { api, type ScheduleDay } from "./api";
import { describeBookingError, provesStaleGrid } from "./bookingErrors";
import { goneFrom, outcomeUnknown } from "./bookingOutcome";

/**
 * Lifting a club hold from the grid — the one slot-ending action that stays on the grid itself.
 *
 * <p>
 * Cancelling a booking moved into `CancelSheet` (P4): the sheet reads the quote, states the
 * figures and does the write. A hold charges nobody and refunds nobody, so its sheet only
 * confirms and takes the reason (R5 A5-1, `LiftHoldSheet`); the lift is optimistic: the hold
 * leaves the grid the moment the admin confirms, and comes back with a sentence if the server
 * refuses.
 * </p>
 */

type Toast = { push: (t: { tone: "success" | "danger"; text: string }) => void };

type Args = {
  day: ScheduleDay | null;
  setDay: React.Dispatch<React.SetStateAction<ScheduleDay | null>>;
  /** Re-reads the day; null when the read failed. */
  reconcile: () => Promise<ScheduleDay | null>;
  toast: Toast;
};

export const HOLD_LIFTED = "Hold lifted — the court is free again.";
export const HOLD_LIFT_FAILED = "Couldn't lift that hold.";
/** R3 I-4 — offline, nothing is sent. */
export const HOLD_LIFT_OFFLINE = "You're offline, so nothing was sent — the hold is still there. Try again when you're back online.";
/** R3 lost-reply audit: no answer, and the day read back still shows the hold. */
export const HOLD_LIFT_UNANSWERED = "The club's system didn't answer, so we checked the schedule: the hold is still there. Try again in a minute.";
/** No answer, and the day could not be read either. */
export const HOLD_LIFT_UNKNOWN = "The club's system didn't answer and the schedule couldn't be read either, so we can't tell whether the hold was lifted. Refresh the schedule before trying again.";

/**
 * What a lift with no answer did, read off the day (R3 lost-reply audit): gone is lifted — the
 * reply was lost, not the lift — and a hold still there, or a day that would not load, is said so.
 * It used to put the hold back and say "Couldn't lift that hold" about a lift that had landed.
 */
async function readBack(blockId: string, reconcile: Args["reconcile"]): Promise<{ lifted: boolean; text: string }> {
  const day = await reconcile();
  if (!day) return { lifted: false, text: HOLD_LIFT_UNKNOWN };
  if (goneFrom(day, blockId)) return { lifted: true, text: HOLD_LIFTED };
  return { lifted: false, text: HOLD_LIFT_UNANSWERED };
}

/**
 * R5 A5-1 — the lift carries the admin's reason, which the club records (`?reason=`, lane F's
 * shape; a blank one is refused 400 reason_required). Called here rather than through
 * `endpoints.adminUnblock`, whose signature has no reason yet (integrator-owned `lib/api.ts`).
 */
function unblock(blockId: string, reason: string): Promise<void> {
  return api.del<void>(`/api/v1/admin/blocks/${encodeURIComponent(blockId)}?reason=${encodeURIComponent(reason)}`);
}

export function useHoldLift({ day, setDay, reconcile, toast }: Args) {
  return useCallback(async (blockId: string, reason: string) => {
    const removed = day?.slots.filter((s) => s.bookingId === blockId) ?? [];
    const putBack = () => setDay((d) => (d ? { ...d, slots: [...d.slots, ...removed] } : d));
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      toast.push({ tone: "danger", text: HOLD_LIFT_OFFLINE });
      return;
    }
    setDay((d) => (d ? { ...d, slots: d.slots.filter((s) => s.bookingId !== blockId) } : d));
    try {
      await unblock(blockId, reason);
      toast.push({ tone: "success", text: HOLD_LIFTED });
      void reconcile();
    } catch (err) {
      if (outcomeUnknown(err)) {
        // The read-back redraws the day itself; only an unreadable day needs the hold put back.
        const seen = await readBack(blockId, reconcile);
        if (seen.text === HOLD_LIFT_UNKNOWN) putBack();
        toast.push({ tone: seen.lifted ? "success" : "danger", text: seen.text });
        return;
      }
      // Put it back before saying anything: the grid must never show a court free that is not.
      putBack();
      if (provesStaleGrid(err)) await reconcile();
      toast.push({ tone: "danger", text: describeBookingError(err, HOLD_LIFT_FAILED) });
    }
  }, [day, setDay, reconcile, toast]);
}
