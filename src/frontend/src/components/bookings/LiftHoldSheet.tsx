import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { LIFT_HOLD_SHEET } from "@/lib/bookingsCopy";

/** The hold an admin pressed Lift on: its id, where it is ("Court 1 at 17:00") and its name. */
export type HoldToLift = { blockId: string; where: string; label: string | null };

export type LiftHoldSheetProps = {
  hold: HoldToLift | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Lifts it — the page's optimistic lift, which says what happened in a toast. */
  onLift: (blockId: string, reason: string) => void;
  onCloseAutoFocus?: (event: Event) => void;
};

/**
 * R5 A5-1 — lifting a club hold confirms and takes a reason, like an admin's cancel.
 *
 * <p>
 * One tap on the grid's lock used to DELETE the hold: no confirm, no undo, and the change record
 * showed the lift with no reason. The reason is required (the API refuses a blank one, 400
 * reason_required) and is recorded. The lift itself stays optimistic — it charges and refunds
 * nobody — so the sheet closes on Lift and the page's toast says how it went.
 * </p>
 */
export function LiftHoldSheet({ hold, open, onOpenChange, onLift, onCloseAutoFocus }: LiftHoldSheetProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-sheet="lift-hold" onCloseAutoFocus={onCloseAutoFocus}>
        {/* Keyed on the hold, so a second hold never inherits the first one's reason. */}
        {hold ? <LiftHoldBody key={hold.blockId} hold={hold} onClose={() => onOpenChange(false)} onLift={onLift} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function LiftHoldBody({ hold, onClose, onLift }: { hold: HoldToLift; onClose: () => void; onLift: LiftHoldSheetProps["onLift"] }) {
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const missing = tried && reason.trim() === "";
  const confirm = () => {
    if (reason.trim() === "") { setTried(true); return; }
    onClose();
    onLift(hold.blockId, reason.trim());
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{LIFT_HOLD_SHEET.title}</DialogTitle>
        <DialogDescription>{LIFT_HOLD_SHEET.description(hold.where, hold.label)}</DialogDescription>
      </DialogHeader>
      <DialogBody className="pb-4">
        <Field invalid={missing}>
          <FieldLabel>{LIFT_HOLD_SHEET.reasonLabel}</FieldLabel>
          <Textarea
            rows={2}
            maxLength={512}
            value={reason}
            placeholder={LIFT_HOLD_SHEET.reasonPlaceholder}
            onChange={(e) => setReason(e.target.value)}
          />
          <FieldDescription>{LIFT_HOLD_SHEET.reasonHint}</FieldDescription>
          {missing ? <FieldError>{LIFT_HOLD_SHEET.reasonMissing}</FieldError> : null}
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{LIFT_HOLD_SHEET.keep}</Button>
        <Button variant="danger" onClick={confirm}>{LIFT_HOLD_SHEET.confirm}</Button>
      </DialogFooter>
    </>
  );
}
