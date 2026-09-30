import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useToast } from "@/components/Toast";
import { type AdjustReasonCode } from "@/lib/adminApi";
import { isGuid } from "@/lib/creditAdjustment";
import { RELATED_BOOKING } from "@/lib/membersCopy";
import { attemptAdjustment, type AdjustmentKey } from "./adjustmentAttempt";
import { patchRow, type MemberRow } from "./membersModel";
import type { AppliedAdjustment } from "./TopUpSheet";

/**
 * One hand movement of credit from the members list.
 *
 * <p>
 * <b>The idempotency machinery is moved here from the page, not changed.</b> It has a paid-for
 * bug history — a double-click posted +7 twice and moved a member 444 → 458, and four clicks on a
 * slow connection granted 44 credits where 11 were typed — and money is ledger-only, so a
 * duplicated row IS the wrong balance with nothing on the ledger to say which of the two was the
 * mistake.
 * </p>
 *
 * <p>
 * <b>Two guards, because they stop two different things.</b> The ref stops the second click: a
 * state flag set by the first has not committed when a double-click's second event reads it. The
 * key stops everything the ref cannot see — a retry after a lost response, a second tab, a
 * request the browser retried under the covers. It names THIS movement and survives until the
 * movement succeeds, so the server answers a repeat with the row it already wrote.
 * </p>
 */
export function useCreditAdjust(setMembers: Dispatch<SetStateAction<MemberRow[] | null>>) {
  const toast = useToast();
  const [target, setTarget] = useState<MemberRow | null>(null);
  const [booking, setBookingState] = useState("");
  // The server's verdict on the named booking, shown at the field rather than as a toast: it is
  // the one input the admin has to change, and a toast that has faded says nothing.
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef<AdjustmentKey>(null);
  const inFlight = useRef(false);

  const open = useCallback((m: MemberRow) => {
    setTarget(m);
    setBookingState("");
    setBookingError(null);
    key.current = null;
    inFlight.current = false;
  }, []);

  const close = useCallback(() => {
    setTarget(null);
    setBookingState("");
    setBookingError(null);
    key.current = null;
    inFlight.current = false;
  }, []);

  const setBooking = useCallback((next: string) => {
    setBookingState(next);
    setBookingError(null);
  }, []);

  /**
   * Returns the new balance on success and `null` on refusal, so the sheet shows its receipt
   * rather than being closed out from under the person reading it. A lost reply is looked up on
   * the ledger before anything is said (`adjustmentAttempt`, review round 2 F3-2).
   */
  const apply = useCallback(async (
    amount: number, reasonCode: AdjustReasonCode, reason: string, zarReceived?: number,
  ): Promise<AppliedAdjustment | null> => {
    if (!target || inFlight.current) return null;
    const bookingId = booking.trim();
    if (bookingId && !isGuid(bookingId)) {
      setBookingError(RELATED_BOOKING.notAGuid);
      return null;
    }
    inFlight.current = true;
    setBusy(true);
    setBookingError(null);
    try {
      const outcome = await attemptAdjustment({
        userId: target.user_id, amount, reasonCode, reason, zarReceived, name: target.full_name ?? target.email,
        ...(bookingId ? { bookingId } : {}),
      }, key);
      if (outcome.kind === "booking") { setBookingError(outcome.message); return null; }
      if (outcome.kind === "failed") {
        toast.push({ tone: "danger", text: outcome.message, unchanged: outcome.unchanged, durationMs: 8000 });
        return null;
      }
      // The row follows the server's answer at once — no refetch that would re-sort the table.
      const after = outcome.balanceAfterCredits;
      if (after !== null) setMembers((rows) => patchRow(rows, target.user_id, { balance_credits: after }));
      return { balanceAfterCredits: after, recovered: outcome.recovered };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [target, booking, setMembers, toast]);

  return { target, booking, setBooking, bookingError, busy, open, close, apply };
}
