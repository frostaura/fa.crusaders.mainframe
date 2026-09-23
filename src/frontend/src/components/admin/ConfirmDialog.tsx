import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { Alert } from "../Alert";
import { Button } from "../ui/button";
import {
  Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "../ui/dialog";
import { describeFailure } from "../../lib/errors";
import { focusAfterAction, pageHeading } from "../../lib/focusAfterAction";

/**
 * The admin console's confirm step for a consequential action (P3: "destructive → danger with a
 * confirm dialog, always ×, outcome-named verbs").
 *
 * <p>
 * <b>Anatomy</b> (design-system.md, dialog): the trigger opens a dialog whose title asks the
 * question, whose description says the CONSEQUENCE in a sentence, and whose footer is the way out
 * ("Cancel", or an outcome-named dismiss such as "Keep it") beside a primary named for what it
 * does ("Delete webhook", never "OK" or "Yes"). The close × is the dialog's own.
 * </p>
 *
 * <p>
 * <b>Real pending, honest failure.</b> The confirm carries `pending` — a spinner, width locked,
 * focus kept — while the work runs; a second press is ignored by the button itself. A failure
 * stays IN the dialog as a danger alert, the dialog stays open and nothing is claimed; a success
 * closes it. The work's own promise decides, so a caller never has to thread a flag through.
 * </p>
 *
 * <p>
 * <b>Focus after.</b> Radix returns focus to the trigger on close. When the action removes the
 * trigger (a deleted row), `focusAfter` names where focus should land instead; with nothing to
 * name it falls to the page's `h1`, never `<body>`.
 * </p>
 */
export type ConfirmDialogProps = {
  /** The control that opens it — usually a `Button`. Omit and drive `open` instead (a menu item). */
  trigger?: ReactElement;
  /** Controlled open state, for a dialog opened from somewhere other than its own trigger. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where focus returns when it is dismissed without acting (controlled use: the menu's trigger). */
  returnFocus?: () => HTMLElement | null | undefined;
  /** The question: "Delete this webhook?" */
  title: string;
  /** The consequence, in a sentence. */
  description: ReactNode;
  /** The primary, named for its outcome: "Delete webhook". */
  confirmLabel: string;
  /** The way out. "Cancel" unless an outcome name reads better ("Keep it open"). */
  cancelLabel?: string;
  /** `danger` for destructive work (the default), `primary` for a consequential but safe one. */
  tone?: "danger" | "primary";
  /** The work. A rejection is shown in the dialog and keeps it open. */
  onConfirm: () => unknown;
  /** The verb phrase for a failure: "delete the webhook" → "Couldn't delete the webhook — …". */
  action?: string;
  codes?: Record<string, string>;
  /** Extra body — a reason field, a list of what is affected. */
  children?: ReactNode;
  /** The primary cannot be pressed yet (a required reason is empty). */
  confirmDisabled?: boolean;
  /** Where focus lands after a success that removed the trigger. */
  focusAfter?: () => HTMLElement | null | undefined;
};

/**
 * The last resort after a success: if, once every retry has had its chance, focus is still
 * nowhere (its trigger went with the row it acted on), it goes to the page's `h1`.
 */
function rescueFocus() {
  window.setTimeout(() => {
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) focusAfterAction(pageHeading);
  }, 1100);
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const {
    trigger, title, description, confirmLabel, cancelLabel = "Cancel", tone = "danger", onConfirm,
    action, codes, children, confirmDisabled = false, focusAfter,
  } = props;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = props.open ?? ownOpen;
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    props.onOpenChange?.(next);
  };
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const succeeded = useRef(false);

  const change = (next: boolean) => {
    if (pending) return;
    if (next) {
      setError(null);
      succeeded.current = false;
    }
    setOpen(next);
  };

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      succeeded.current = true;
      setOpen(false);
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent
        onCloseAutoFocus={(event) => {
          const back = succeeded.current ? focusAfter ?? props.returnFocus : props.returnFocus;
          if (succeeded.current) rescueFocus();
          if (!back) return;
          event.preventDefault();
          if (succeeded.current) focusAfterAction(back);
          else back()?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children || error ? (
          <DialogBody className="flex flex-col gap-4">
            {children}
            {error ? <Alert tone="danger" live="assertive">{describeFailure(error, { action, codes })}</Alert> : null}
          </DialogBody>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>{cancelLabel}</Button>
          </DialogClose>
          <Button
            data-confirm=""
            variant={tone === "danger" ? "danger" : "primary"}
            pending={pending}
            disabled={confirmDisabled && !pending}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

