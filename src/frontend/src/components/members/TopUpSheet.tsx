import { useState } from "react";
import { Alert } from "../Alert";
import { Button, Input, Label } from "../Button";
import { ConfirmButton } from "../ConfirmButton";
import { Modal } from "../Modal";
import { formatMoney } from "../../lib/utils";
import { type AdjustReasonCode } from "../../lib/adminApi";
import {
  ADD_LINK, LIVE_PUSH_NOTE, MINUS_REFUSED, TAKE_BACK_CONSEQUENCE, TAKE_BACK_LINK,
  balanceSentence, confirmConsequence, doneSentence, overdraftWarning, reasonChoicesFor,
  reasonLabel, revenueNote, sheetTitle, validateAmount, validateReason,
  type CreditDirection,
} from "../../lib/topUpCopy";

/**
 * Put money into a member's wallet, or take it back — two flows, never one signed field.
 * (D3-B08)
 *
 * <p>
 * <b>The shape is three steps because money is three questions.</b> How much · why · is this
 * right. The third is not ceremony: the balance the member ends on is the only figure that
 * tells a volunteer they typed the number they meant, and before this it appeared solely in a
 * four-second toast, after the fact, over a row that had already changed.
 * </p>
 *
 * <p>
 * <b>Nothing here touches the idempotency machinery.</b> The key, the in-flight ref and the
 * double-click guard live on the page and stay exactly as they are — that code has a paid-for
 * bug history (a double-click posted +7 twice and moved a member 444 → 458; four clicks on a
 * slow connection granted R44.00 where R11.00 was typed) and this component calls into it
 * rather than around it.
 * </p>
 *
 * <p>
 * <b>Built on `Modal` rather than a new `Sheet` primitive.</b> D3 proposed a `Sheet` that
 * `Modal` would then be re-implemented on top of, which is the chrome lane's to build and
 * would be a second focus-trap implementation if built here. When it lands this component
 * swaps its wrapper and nothing else changes.
 * </p>
 */

type Applied = { balanceAfterCredits: number };

export function TopUpSheet({
  name, balance, busy, bookingError, onApply, onClose, renderBookingField,
}: {
  name: string;
  /** What the member has now, or null where the read failed. Null is NOT zero. */
  balance: number | null;
  busy: boolean;
  /** The one refusal that belongs at a field rather than in a banner. */
  bookingError: string | null;
  /**
   * The page's own adjust, generalised. Signed: this component decides the sign from the
   * DIRECTION, which is the whole point — no field in this flow carries one.
   */
  onApply: (amountCredits: number, reasonCode: AdjustReasonCode, reason: string) => Promise<Applied | null>;
  onClose: () => void;
  /** The existing "for a booking" field, passed through unchanged rather than reimplemented. */
  renderBookingField?: () => React.ReactNode;
}) {
  const [direction, setDirection] = useState<CreditDirection>("add");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [amountText, setAmountText] = useState("");
  const [reasonCode, setReasonCode] = useState<AdjustReasonCode | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [complaint, setComplaint] = useState<string | null>(null);
  const [done, setDone] = useState<Applied | null>(null);

  const amount = Number(amountText.trim());
  const valid = validateAmount(amountText) === null ? amount : null;

  /**
   * Switching direction resets the amount and the reason, deliberately.
   *
   * Carrying "100" across from "add" to "take back" is how a flow designed to stop a sign
   * mistake produces one: the number stays on screen, the title changes above it, and the
   * person presses the button they were already going to press.
   */
  const flip = (next: CreditDirection) => {
    setDirection(next);
    setAmountText("");
    setReasonCode(null);
    setReasonText("");
    setComplaint(null);
    setStep(1);
  };

  const quick = [50, 100, 200, 500];

  if (done) {
    return (
      <Modal onClose={onClose} title={sheetTitle(direction, name)}>
        {/* The receipt STAYS. Money deserves more than the four seconds a toast lasts, and
            the number a volunteer needs to check is the one after the movement. */}
        <p className="text-lg font-semibold text-success-strong" role="status">
          {doneSentence(name, done.balanceAfterCredits)}
        </p>
        <p className="mt-2 text-sm text-text-secondary">{LIVE_PUSH_NOTE}</p>
        <div className="mt-4 flex justify-end">
          <Button className="min-h-11" onClick={onClose}>Close</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} title={sheetTitle(direction, name)}>
      <p className="text-sm text-text-muted">{`Step ${step} of 3`}</p>

      {step === 1 && (
        <div className="mt-2 space-y-3">
          <div className="flex flex-wrap gap-2">
            {quick.map((value) => (
              <Button
                key={value}
                variant={amountText === String(value) ? "primary" : "outline"}
                className="min-h-14 px-4 tabular-nums"
                onClick={() => { setAmountText(String(value)); setComplaint(null); }}
              >
                {`${direction === "add" ? "+" : "−"}${formatMoney(value)}`}
              </Button>
            ))}
          </div>
          <div>
            <Label htmlFor="topup-amount">Another amount</Label>
            <Input
              id="topup-amount"
              className="min-h-11"
              inputMode="decimal"
              value={amountText}
              placeholder="e.g. 150"
              onChange={(e) => {
                setAmountText(e.target.value);
                // Said once, at the moment it is typed, rather than on submit — a refusal
                // that waits until the end is a refusal that reads as the form being broken.
                setComplaint(/^[-−]/.test(e.target.value.trim()) ? MINUS_REFUSED : null);
              }}
            />
          </div>
          <p className="text-sm text-text-secondary" data-testid="topup-balance">
            {balanceSentence(name, balance, valid, direction)}
          </p>
          {direction === "take_back" && overdraftWarning(balance, valid) && (
            <Alert tone="warning" live="polite">{overdraftWarning(balance, valid)}</Alert>
          )}
          {complaint && <Alert tone="danger">{complaint}</Alert>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* The other path is a LINK, low in the flow, differently titled and differently
                toned. It is not a sign, a toggle or a minus key: it is a decision with a
                name, which is what stops a typo being a two-hundred-rand mistake. */}
            <Button
              variant="ghost"
              className="min-h-11"
              onClick={() => flip(direction === "add" ? "take_back" : "add")}
            >
              {direction === "add" ? TAKE_BACK_LINK : ADD_LINK}
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" className="min-h-11" onClick={onClose}>Cancel</Button>
              <Button
                className="min-h-11"
                onClick={() => {
                  const said = validateAmount(amountText);
                  if (said) { setComplaint(said); return; }
                  setComplaint(null);
                  setStep(2);
                }}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="mt-2 space-y-3">
          <fieldset>
            <legend className="text-sm font-medium text-text-primary">
              Why? The member sees this on their wallet.
            </legend>
            <div className="mt-1 space-y-1">
              {reasonChoicesFor(direction).map((choice) => (
                <label key={choice.code} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="topup-reason"
                    className="h-5 w-5"
                    checked={reasonCode === choice.code}
                    onChange={() => { setReasonCode(choice.code); setComplaint(null); }}
                  />
                  {choice.label}
                </label>
              ))}
            </div>
          </fieldset>
          {reasonCode && <p className="text-sm text-text-muted">{revenueNote(reasonCode)}</p>}
          <div>
            <Label htmlFor="topup-reason-text">And why this one?</Label>
            <Input
              id="topup-reason-text"
              className="min-h-11"
              value={reasonText}
              placeholder="e.g. R200 cash at the desk, receipt 0412"
              onChange={(e) => { setReasonText(e.target.value); setComplaint(null); }}
            />
          </div>
          {renderBookingField?.()}
          {bookingError && <Alert tone="danger">{bookingError}</Alert>}
          {complaint && <Alert tone="danger">{complaint}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" className="min-h-11" onClick={() => setStep(1)}>Back</Button>
            <Button
              className="min-h-11"
              onClick={() => {
                const said = validateReason(reasonCode, reasonText);
                if (said) { setComplaint(said); return; }
                setComplaint(null);
                setStep(3);
              }}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 3 && valid !== null && reasonCode !== null && (
        <div className="mt-2 space-y-3">
          {/* The three figures, in a table, before anything happens. This is the whole of
              what D3-B08 was missing: the result was previously visible only afterwards. */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-text-muted">Balance now</dt>
            <dd className="tabular-nums text-text-primary">
              {balance === null ? "Couldn't read it" : formatMoney(balance)}
            </dd>
            <dt className="text-text-muted">This</dt>
            <dd className="font-semibold tabular-nums text-text-primary">
              {`${direction === "add" ? "+" : "−"}${formatMoney(valid)}`}
            </dd>
            <dt className="font-semibold text-text-muted">Balance after</dt>
            <dd className="font-semibold tabular-nums text-text-primary">
              {balance === null ? "the club's system works it out" : formatMoney(balance + (direction === "add" ? valid : -valid))}
            </dd>
          </dl>
          <p className="text-sm text-text-secondary">{`Reason: ${reasonLabel(reasonCode)} — “${reasonText.trim()}”`}</p>
          <p className="text-sm text-text-muted">{revenueNote(reasonCode)}</p>
          {direction === "take_back" && <p className="text-sm text-warning-strong">{TAKE_BACK_CONSEQUENCE}</p>}
          <p className="text-sm text-text-muted">{LIVE_PUSH_NOTE}</p>
          {bookingError && <Alert tone="danger">{bookingError}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" className="min-h-11" onClick={() => setStep(2)}>Back</Button>
            <ConfirmButton
              idleLabel={direction === "add" ? `Add ${formatMoney(valid)}` : `Take back ${formatMoney(valid)}`}
              cancelLabel="Don't move any money"
              confirmLabel={confirmConsequence(name, balance, valid, direction)}
              // Both, and they answer different questions: `ariaLabel` is what the ACTION is
              // about ("Add R24.00 — Thandi Mokoena — choose again to confirm") and
              // `subject` is what the way OUT keeps ("Don't move any money — Thandi
              // Mokoena"). Without the first, the armed control's name is the whole
              // consequence sentence and label-in-name holds only by accident.
              ariaLabel={name}
              subject={name}
              tone={direction === "add" ? "info" : "danger"}
              disabled={busy}
              onConfirm={async () => {
                const applied = await onApply(direction === "add" ? valid : -valid, reasonCode, reasonText.trim());
                if (!applied) return "That didn't go through.";
                setDone(applied);
                return doneSentence(name, applied.balanceAfterCredits);
              }}
              className="min-h-11"
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
