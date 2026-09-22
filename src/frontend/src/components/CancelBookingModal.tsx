import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button, fieldClassName } from "./Button";
import { endpoints, type CancellationQuote } from "../lib/api";
import { formatMoney } from "../lib/utils";
import { describeBookingError } from "../lib/bookingErrors";

type Props = {
  bookingId: string;
  courtName: string;
  whenLabel: string;
  /** True for an admin cancelling someone else's booking — unlocks waiving the penalty. */
  asAdmin: boolean;
  /**
   * The booking's own player, when the viewer is not them. First name only, because that
   * is all the grid carries and all it is allowed to: "the booking grid shows photo + name
   * only".
   */
  memberName?: string | null;
  onClose: () => void;
  onConfirm: (waivePenalty: boolean, waiveReason: string) => Promise<void>;
};

/**
 * §7: the cancellation modal must display, in figures, what cancelling costs — before
 * the member commits.
 *
 * <p>
 * There was no modal. The whole confirmation was a grid cell whose label changed from
 * "Mine" to "Confirm cancel", stating no amount, no penalty and no attendance, and the
 * message afterwards read "Booking cancelled — refund pending." whatever had actually
 * happened. It said that when R50.00 came back. It said it when R35.00 came back
 * and R15.00 was kept as a penalty the member was never warned about. And it said it —
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
export function CancelBookingModal(props: Props) {
  const { bookingId, courtName, whenLabel, asAdmin, memberName, onClose, onConfirm } = props;
  const [quote, setQuote] = useState<CancellationQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waive, setWaive] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const subject = subjectOf(asAdmin, memberName);

  useEffect(() => {
    let live = true;
    endpoints.cancellationQuote(bookingId)
      .then((q) => { if (live) setQuote(q); })
      .catch((e) => { if (live) setError(describeBookingError(e, "Couldn't work out what this cancellation costs.")); });
    return () => { live = false; };
  }, [bookingId]);

  const waiving = asAdmin && waive;
  const reasonMissing = waiving && reason.trim() === "";

  const confirm = async () => {
    if (busy || reasonMissing) return;
    setBusy(true);
    try { await onConfirm(waiving, waiving ? reason.trim() : ""); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="Cancel this booking?" onClose={onClose}>
      <p className="text-sm text-text-secondary mb-3">
        {[subject, courtName, whenLabel].filter(Boolean).join(" · ")}
      </p>

      {error && <p className="text-sm text-danger-strong mb-3">{error}</p>}
      {!quote && !error && <p className="text-sm text-text-muted mb-3">Checking what this costs…</p>}

      {quote && (
        <div className="mb-4">
          <Consequence quote={quote} waived={waiving} subject={subject} />
        </div>
      )}

      {quote && asAdmin && quote.penaltyCredits > 0 && (
        <WaiveControl
          penaltyCredits={quote.penaltyCredits}
          waive={waive} setWaive={setWaive}
          reason={reason} setReason={setReason}
          reasonMissing={reasonMissing}
        />
      )}

      <div className="flex gap-2 justify-end">
        <Button intent="decline" variant="ghost" onClick={onClose} disabled={busy}>Keep the booking</Button>
        {/*
          `destructive`, and this is the example ruling 4 was written about. The consequence
          this button commits to is stated two paragraphs above it in figures — 35.00 back,
          15.00 kept as a penalty, or nothing at all once somebody has scanned in. A thumbs-up
          over that is the software congratulating a member on losing money. No thumb, no
          celebration on success, and it settles rather than snapping.
        */}
        <Button intent="destructive" variant="danger" onClick={confirm} disabled={busy || reasonMissing || (!quote && !error)}>
          {busy ? "Cancelling…" : "Cancel the booking"}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Whose booking this dialog is about: the member's name when an admin is acting on their
 * behalf, and null when it is the viewer's own.
 *
 * <p>
 * An admin is not the member. The dialog used to tell a desk account that "the full
 * R50.00 goes back to YOUR wallet" and that "YOU'VE already checked in", about somebody
 * else's court and somebody else's scan, with the member never named anywhere in it — so
 * nothing on screen could catch a wrong slot clicked on a crowded grid.
 * </p>
 */
function subjectOf(asAdmin: boolean, memberName?: string | null): string | null {
  if (!asAdmin) return null;
  return memberName ?? "This member";
}

/**
 * §7: "Admin can choose to waive the penalty (<b>logged with reason</b>)", repeated in §8 as
 * "penalty waiveable <b>with reason</b>".
 *
 * <p>
 * There was no reason field, and none on the wire either — `AdminCancelRequest` was a bare
 * boolean — so a club auditing waived penalties at month end had a tick and nothing else:
 * no way to tell a genuine club decision from a desk clearing an awkward conversation. The
 * reason is required rather than optional, because an optional audit field on a money
 * movement is one nobody fills in.
 * </p>
 */
function WaiveControl(props: {
  penaltyCredits: number;
  waive: boolean; setWaive: (v: boolean) => void;
  reason: string; setReason: (v: string) => void;
  reasonMissing: boolean;
}) {
  const { penaltyCredits, waive, setWaive, reason, setReason, reasonMissing } = props;
  return (
    <div className="mb-4 space-y-2">
      <label className="flex items-center gap-2 text-sm" htmlFor="waive-penalty">
        <input
          id="waive-penalty"
          type="checkbox"
          checked={waive}
          onChange={(e) => setWaive(e.target.checked)}
        />
        <span>Waive the {formatMoney(penaltyCredits)} penalty (logged against your account)</span>
      </label>
      {waive && (
        <div className="space-y-1">
          <input
            id="waive-reason"
            aria-label="Why the penalty is being waived"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Court double-booked, injury, club decision…"
            className={fieldClassName}
          />
          {reasonMissing && (
            <p className="text-sm text-danger-strong">
              Say why — the waiver is logged against your name and the reason goes with it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The one sentence the person deciding has to read. Three cases, and the third is the one
 * the product used to hide completely.
 *
 * <p>
 * <b>"credit" became "wallet", and that is a rewrite rather than a substitution.</b> The word
 * was doing two jobs — the unit on a number ("50.00 cr") and the noun for the place the money
 * lives ("your credit"). The owner's ruling is about the first, and swapping the noun for the
 * symbol would have produced "goes back to your R". "Wallet" is what the rest of the product
 * already calls it: the chip is a wallet, the route is <code>/wallet</code>, and the top-up
 * copy says "adds to your wallet". A member who has never heard the word "credit" in a club
 * loses nothing.
 * </p>
 *
 * <p>
 * `subject` is the booking's own player, non-null exactly when an admin is cancelling on
 * somebody else's behalf, and it changes the voice of all three: §7 says "refunds always
 * go to the booking's player", and every sentence here was written in the first person.
 * A desk was told the money came back to "your wallet" — an account whose balance is zero
 * permanently and never moved — and, worse, that "<b>you've</b> already checked in and the
 * lights have been on" about a scan somebody else made at a court the admin was not at.
 * The member was never named, so nothing in the dialog could catch a wrong slot clicked on
 * a crowded grid.
 * </p>
 */
function Consequence(props: { quote: CancellationQuote; waived: boolean; subject: string | null }) {
  const { quote, waived, subject } = props;
  const whose = subject ? `${subject}'s wallet` : "your wallet";

  if (quote.checkedIn) {
    return (
      <p className="text-sm rounded-lg bg-danger-soft text-danger-strong p-3">
        <strong>
          {subject
            ? `${subject} has already checked in and the lights have been on, so nothing is refunded.`
            : "You've already checked in and the lights have been on, so nothing is refunded."}
        </strong>{" "}
        The {formatMoney(quote.amountChargedCredits)} paid for this court stays spent.
      </p>
    );
  }

  const penalty = waived ? 0 : quote.penaltyCredits;
  const refund = waived ? quote.amountChargedCredits : quote.refundCredits;

  if (penalty > 0) {
    return (
      <p className="text-sm rounded-lg bg-warning-soft text-warning-strong p-3">
        <strong>Cancelling within the penalty window.</strong>{" "}
        A {quote.penaltyPct}% penalty of {formatMoney(penalty)} is deducted and{" "}
        <strong>{formatMoney(refund)}</strong> goes back to {whose}.
      </p>
    );
  }

  return (
    <p className="text-sm rounded-lg bg-success-soft text-success-strong p-3">
      <strong>Cancelling now is free.</strong>{" "}
      The full {formatMoney(refund)} goes back to {whose}.
      {waived && quote.penaltyCredits > 0 && " (Penalty waived by you.)"}
    </p>
  );
}
