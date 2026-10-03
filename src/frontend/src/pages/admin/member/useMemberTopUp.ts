import { useCallback, useRef, useState } from "react";
import { useToast } from "@/components/toastContext";
import { isGuid } from "@/lib/deskLedger";
import { type AdjustmentReasonCode } from "@/lib/adminApi";
import { TOP_UP_COPY } from "@/lib/memberDetailCopy";
import { attemptAdjustment, type AdjustmentKey } from "@/components/members/adjustmentAttempt";
import type { ApplyResult } from "@/components/members/TopUpSheet";
import { useLateLanding } from "@/components/bookings/useSendingGuard";
import { doneSentence } from "@/lib/deskMinutesCopy";

/**
 * One hand adjustment of minutes from the member's page (goodwill, corrections — §3.7) — the
 * members list's idempotency discipline (`components/members/useMinutesAdjust`), kept whole for
 * one known member.
 *
 * <p>
 * <b>Two guards, because they stop two different things.</b> The ref stops the second click: a
 * state flag set by the first click has not committed when a double-click's second event reads
 * it. The key stops everything the ref cannot see — a retry after a lost response, a second tab,
 * a request the browser retried under the covers. It names THIS movement and survives until the
 * movement succeeds, so the server answers a repeat with the row it already wrote. That code
 * has a paid-for history on this estate (+7 posted twice; four times what was typed granted on
 * a slow connection), and money is ledger-only, so a duplicated row IS the wrong balance.
 * </p>
 *
 * <p>
 * The sign arrives already decided by `TopUpSheet` from the direction the admin chose by name;
 * nothing here parses a signed field (D3-B08).
 * </p>
 */
export function useMemberTopUp(userId: string, name: string, onApplied: (balanceAfter: number | null) => void) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [booking, setBookingState] = useState("");
  const [bookingError, setBookingError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const key = useRef<AdjustmentKey>(null);

  // R5 I5-3: a landing after the member's page has gone is said in a toast, never silent.
  const { sayIfGone } = useLateLanding(open);

  const reset = useCallback(() => {
    setBookingState("");
    setBookingError(null);
    key.current = null;
    inFlight.current = false;
  }, []);
  const show = useCallback(() => { reset(); setOpen(true); }, [reset]);
  /**
   * R5 I5-3: refused while a movement is in flight — it used to reset the ref and the key mid-
   * flight, so the sheet could be reopened over a movement still on its way.
   */
  const close = useCallback(() => {
    if (inFlight.current) return;
    setOpen(false);
    reset();
  }, [reset]);
  const setBooking = useCallback((next: string) => { setBookingState(next); setBookingError(null); }, []);

  const apply = useCallback(async (
    amount: number, reasonCode: AdjustmentReasonCode, reason: string,
  ): Promise<ApplyResult> => {
    if (inFlight.current) return null;
    const bookingId = booking.trim();
    if (bookingId && !isGuid(bookingId)) {
      setBookingError(TOP_UP_COPY.notAGuid);
      return null;
    }
    inFlight.current = true;
    setBusy(true);
    setBookingError(null);
    try {
      // A lost reply is looked up on the ledger before anything is said (review round 2, F3-2).
      const outcome = await attemptAdjustment({
        userId, amount, reasonCode, reason, name, ...(bookingId ? { bookingId } : {}),
      }, key);
      if (outcome.kind === "booking") {
        setBookingError(outcome.message);
        sayIfGone("danger", () => outcome.message);
        return null;
      }
      if (outcome.kind === "failed") {
        toast.push({ tone: "danger", text: outcome.message, unchanged: outcome.unchanged, durationMs: 8000 });
        // A 409 reused key proved an earlier press landed: the header's figure is stale (R3 I-6).
        if (outcome.balanceNow !== undefined) onApplied(outcome.balanceNow);
        return { said: outcome.said };
      }
      onApplied(outcome.balanceAfterMinutes);
      sayIfGone("success", () => doneSentence(name, outcome.balanceAfterMinutes));
      // No success toast: the sheet keeps its own receipt on screen, which is what money needs.
      return { balanceAfterMinutes: outcome.balanceAfterMinutes, recovered: outcome.recovered };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [userId, name, booking, onApplied, toast, sayIfGone]);

  return { open, busy, show, close, apply, booking, setBooking, bookingError };
}
