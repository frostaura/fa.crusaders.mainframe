import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { endpoints, type CancellationQuote } from "../lib/api";
import { formatCredits } from "../lib/utils";
import { describeBookingError } from "../lib/bookingErrors";

type Props = {
  bookingId: string;
  courtName: string;
  whenLabel: string;
  /** True for an admin cancelling someone else's booking — unlocks waiving the penalty. */
  asAdmin: boolean;
  onClose: () => void;
  onConfirm: (waivePenalty: boolean) => Promise<void>;
};

/**
 * §7: the cancellation modal must display, in figures, what cancelling costs — before
 * the member commits.
 *
 * <p>
 * There was no modal. The whole confirmation was a grid cell whose label changed from
 * "Mine" to "Confirm cancel", stating no amount, no penalty and no attendance, and the
 * message afterwards read "Booking cancelled — refund pending." whatever had actually
 * happened. It said that when 50.00 credits came back. It said it when 35.00 came back
 * and 15.00 was kept as a penalty the member was never warned about. And it said it —
 * word for word — to a member who had already scanned in at the box and therefore lost
 * the entire price, with nothing on screen mentioning that the court was lit.
 * </p>
 *
 * <p>
 * The figures come from the server the moment this opens, not from the schedule payload
 * and not from arithmetic repeated here: the answer turns on the clock and on whether
 * somebody has scanned in, and both move after a schedule is loaded. Duplicating the
 * penalty arithmetic in the client would also be a second place for money to be wrong.
 * </p>
 */
export function CancelBookingModal({ bookingId, courtName, whenLabel, asAdmin, onClose, onConfirm }: Props) {
  const [quote, setQuote] = useState<CancellationQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waive, setWaive] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    endpoints.cancellationQuote(bookingId)
      .then((q) => { if (live) setQuote(q); })
      .catch((e) => { if (live) setError(describeBookingError(e, "Couldn't work out what this cancellation costs.")); });
    return () => { live = false; };
  }, [bookingId]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try { await onConfirm(asAdmin && waive); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="Cancel this booking?" onClose={onClose}>
      <p className="text-sm text-text-secondary mb-3">{courtName} · {whenLabel}</p>

      {error && <p className="text-sm text-danger-strong mb-3">{error}</p>}
      {!quote && !error && <p className="text-sm text-text-muted mb-3">Checking what this costs…</p>}

      {quote && (
        <div className="mb-4">
          <Consequence quote={quote} waived={asAdmin && waive} />
        </div>
      )}

      {quote && asAdmin && quote.penaltyCredits > 0 && (
        <label className="flex items-center gap-2 text-sm mb-4" htmlFor="waive-penalty">
          <input
            id="waive-penalty"
            type="checkbox"
            checked={waive}
            onChange={(e) => setWaive(e.target.checked)}
          />
          <span>Waive the {formatCredits(quote.penaltyCredits)} penalty (logged against your account)</span>
        </label>
      )}

      <div className="flex gap-2 justify-end">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Keep the booking</Button>
        <Button variant="danger" onClick={confirm} disabled={busy || (!quote && !error)}>
          {busy ? "Cancelling…" : "Cancel the booking"}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * The one sentence the member has to read. Three cases, and the third is the one the
 * product used to hide completely.
 */
function Consequence({ quote, waived }: { quote: CancellationQuote; waived: boolean }) {
  if (quote.checkedIn) {
    return (
      <p className="text-sm rounded-lg bg-danger-soft text-danger-strong p-3">
        <strong>You've already checked in and the lights have been on, so nothing is refunded.</strong>{" "}
        The {formatCredits(quote.amountChargedCredits)} you paid for this court stays spent.
      </p>
    );
  }

  const penalty = waived ? 0 : quote.penaltyCredits;
  const refund = waived ? quote.amountChargedCredits : quote.refundCredits;

  if (penalty > 0) {
    return (
      <p className="text-sm rounded-lg bg-warning-soft text-warning-strong p-3">
        <strong>Cancelling within the penalty window.</strong>{" "}
        A {quote.penaltyPct}% penalty of {formatCredits(penalty)} is deducted and{" "}
        <strong>{formatCredits(refund)}</strong> goes back to your credit.
      </p>
    );
  }

  return (
    <p className="text-sm rounded-lg bg-success-soft text-success-strong p-3">
      <strong>Cancelling now is free.</strong>{" "}
      The full {formatCredits(refund)} goes back to your credit.
      {waived && quote.penaltyCredits > 0 && " (Penalty waived by you.)"}
    </p>
  );
}
