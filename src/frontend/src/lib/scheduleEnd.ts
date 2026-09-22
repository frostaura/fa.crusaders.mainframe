import { useCallback } from "react";
import { endpoints, type ScheduleDay } from "./api";
import { cancellationOutcome, describeBookingError, provesStaleGrid } from "./bookingErrors";

export type CancelTarget = {
  bookingId: string; courtName: string; whenLabel: string; mine: boolean;
  /** The booking's own player, for the dialog an ADMIN is deciding on. Null for one's own. */
  memberName: string | null;
};

function withoutBooking(day: ScheduleDay | null, bookingId: string): ScheduleDay | null {
  return day ? { ...day, slots: day.slots.filter((s) => s.bookingId !== bookingId) } : day;
}

type Toast = { push: (t: { tone: "success" | "danger"; text: string }) => void };

type Args = {
  cancelling: CancelTarget | null;
  setCancelling: (t: CancelTarget | null) => void;
  setDay: (f: (d: ScheduleDay | null) => ScheduleDay | null) => void;
  reconcile: () => void;
  /**
   * Re-read the wallet, flagged as THIS page's doing.
   *
   * <p>
   * The cancel endpoint answers `refunded_credits` and `penalty_credits` and no balance, so
   * there is no server figure to `apply` — and `balance + refunded - penalty` in the client
   * would be the optimistic guess `apply` exists to not be, on the one screen where being
   * wrong about money is worst. So the read stays a read and says who asked for it: without
   * the flag the chip raised "The club added R50.00 to your wallet" on top of the toast below, and a
   * member saw one cancellation reported twice, in two different voices.
   * </p>
   */
  refreshBalance: (options?: { expectSelf?: boolean }) => Promise<void> | void;
  toast: Toast;
};

/**
 * The two ways a slot stops being booked: a member (or an admin on their behalf) cancelling,
 * and an admin lifting a block.
 *
 * <p>
 * Extracted from `pages/Schedule.tsx` because that page carries the whole schedule state
 * machine and had grown past the complexity gate's 200-line limit. These two are the most
 * self-contained part of it: both remove a slot from the grid optimistically, both reconcile
 * behind the member, and both report a failure in the same words. Nothing about them needs the
 * page's other state.
 * </p>
 */
export function useSlotEnders({ cancelling, setCancelling, setDay, reconcile, refreshBalance, toast }: Args) {
  const confirmCancel = async (waivePenalty: boolean, waiveReason: string) => {
    if (!cancelling) return;
    try {
      const result = cancelling.mine
        ? await endpoints.cancelBooking(cancelling.bookingId)
        : await endpoints.adminCancelBooking(cancelling.bookingId, waivePenalty, waiveReason);
      // The freed slot leaves the grid at once; the read that confirms it follows behind.
      setDay((d) => withoutBooking(d, cancelling.bookingId));
      setCancelling(null);
      // The figures the server actually moved, not "refund pending", and named for whose
      // wallet moved: §7 refunds the booking's player, never the acting admin.
      toast.push({
        tone: "success",
        text: cancellationOutcome(
          result.refunded_credits, result.penalty_credits,
          cancelling.mine ? null : cancelling.memberName ?? "the member"),
      });
      reconcile();
      void refreshBalance({ expectSelf: true });
    } catch (err) {
      // Same rule as the booking path: a booking that is "no longer there" is the server
      // saying this grid is stale, so it is refetched — and awaited, so the sentence that
      // says the schedule is up to date is true when the member reads it.
      if (provesStaleGrid(err)) await reconcile();
      toast.push({ tone: "danger", text: describeBookingError(err, "Couldn't cancel that booking. Refresh the schedule and try again.") });
    }
  };

  const liftBlock = useCallback(async (blockId: string) => {
    try {
      await endpoints.adminUnblock(blockId);
      setDay((d) => withoutBooking(d, blockId));
      toast.push({ tone: "success", text: "Block lifted — the court is free again." });
      reconcile();
    } catch (err) {
      if (provesStaleGrid(err)) await reconcile();
      toast.push({ tone: "danger", text: describeBookingError(err, "Couldn't lift that block.") });
    }
  }, [reconcile, setDay, toast]);

  return { confirmCancel, liftBlock };
}
