import { useCallback, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { ApiError } from "@/lib/api";
import { isGuid, newIdempotencyKey, relatedBookingRefusal } from "@/lib/creditAdjustment";
import { adminEndpoints, type AdjustReasonCode } from "@/lib/adminApi";
import { TOP_UP_COPY } from "@/lib/memberDetailCopy";
import { adjustRefusal } from "@/lib/topUpCopy";

/**
 * One hand movement of credit from the member's page — the members list's idempotency
 * discipline (`components/members/useCreditAdjust`), kept whole for one known member.
 *
 * <p>
 * <b>Two guards, because they stop two different things.</b> The ref stops the second click: a
 * state flag set by the first click has not committed when a double-click's second event reads
 * it. The key stops everything the ref cannot see — a retry after a lost response, a second tab,
 * a request the browser retried under the covers. It names THIS movement and survives until the
 * movement succeeds, so the server answers a repeat with the row it already wrote. That code
 * has a paid-for history on this estate (+7 posted twice; 44 credits granted where 11 were
 * typed), and money is ledger-only, so a duplicated row IS the wrong balance.
 * </p>
 *
 * <p>
 * The sign arrives already decided by `TopUpSheet` from the direction the admin chose by name;
 * nothing here parses a signed field (D3-B08).
 * </p>
 */
export function useMemberTopUp(userId: string, onApplied: (balanceAfter: number) => void) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [booking, setBookingState] = useState("");
  const [bookingError, setBookingError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const key = useRef<string | null>(null);

  const reset = useCallback(() => {
    setBookingState("");
    setBookingError(null);
    key.current = null;
    inFlight.current = false;
  }, []);
  const show = useCallback(() => { reset(); setOpen(true); }, [reset]);
  const close = useCallback(() => { setOpen(false); reset(); }, [reset]);
  const setBooking = useCallback((next: string) => { setBookingState(next); setBookingError(null); }, []);

  const apply = useCallback(async (
    amount: number, reasonCode: AdjustReasonCode, reason: string, zarReceived?: number,
  ): Promise<{ balanceAfterCredits: number } | null> => {
    if (inFlight.current) return null;
    const bookingId = booking.trim();
    if (bookingId && !isGuid(bookingId)) {
      setBookingError(TOP_UP_COPY.notAGuid);
      return null;
    }
    inFlight.current = true;
    key.current ??= newIdempotencyKey();
    setBusy(true);
    setBookingError(null);
    try {
      const r = await adminEndpoints.adjustCredit(userId, {
        amountCredits: amount, reasonCode, reason,
        ...(bookingId ? { relatedBookingId: bookingId } : {}),
        ...(zarReceived !== undefined ? { zarReceived } : {}),
        idempotencyKey: key.current,
      });
      key.current = null;
      onApplied(r.balance_after_credits);
      // No success toast: the sheet keeps its own receipt on screen, which is what money needs.
      return { balanceAfterCredits: r.balance_after_credits };
    } catch (err) {
      // A refused booking id belongs at its field; anything else is a toast, and it may say
      // "nothing changed" only where the server REFUSED — never where the answer was lost.
      const refusal = relatedBookingRefusal(err);
      if (refusal) { setBookingError(refusal); return null; }
      const refused = err instanceof ApiError && err.status >= 400 && err.status < 500;
      toast.push({ tone: "danger", text: adjustRefusal(err) ?? (refused ? TOP_UP_COPY.refused : TOP_UP_COPY.unreachable), unchanged: refused, durationMs: 8000 });
      return null;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [userId, booking, onApplied, toast]);

  return { open, busy, show, close, apply, booking, setBooking, bookingError };
}
