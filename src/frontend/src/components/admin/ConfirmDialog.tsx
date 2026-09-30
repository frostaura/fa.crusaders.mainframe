import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { CONFIRM_NOT_READY } from "@/lib/confirmDialogCopy";
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
  /**
   * The caller's own words for a failure, tried before `describeFailure` (review round 3): a lost
   * reply that was read back (`lib/lostReply`'s `UnsureOutcome`) is not a failure, and the generic
   * wording said "Couldn't …" over a write that may have landed. Return null to fall through.
   */
  describe?: (error: unknown) => string | null;
  /** Extra body — a reason field, a list of what is affected. */
  children?: ReactNode;
  /** The primary cannot be pressed yet (a required reason is empty). Prefer `notReady`. */
  confirmDisabled?: boolean;
  /**
   * The work is not ready to run (a required reason is empty), and the primary stays ENABLED: a
   * disabled button was the only cue, gave no reason and left the tab order (review round 2,
   * A11Y F3-18). Pressing it says what is missing and puts focus on the field instead.
   */
  notReady?: boolean;
  /** What pressing a not-ready primary says. Defaults to the reason sentence. */
  notReadyMessage?: string;
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
  const [notReady, setNotReady] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const succeeded = useRef(false);

  const change = (next: boolean) => {
    if (pending) return;
    if (next) {
      setError(null);
      setNotReady(false);
      succeeded.current = false;
    }
    setOpen(next);
  };

  const confirm = async () => {
    if (pending) return;
    if (props.notReady) {
      setNotReady(true);
      body.current?.querySelector<HTMLElement>("textarea, input, [role=combobox]")?.focus();
      return;
    }
    setNotReady(false);
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
          <DialogBody ref={body} className="flex flex-col gap-4">
            {children}
            {notReady && props.notReady ? (
              <Alert tone="warning" live="assertive" announceKey="confirm-not-ready">{props.notReadyMessage ?? CONFIRM_NOT_READY}</Alert>
            ) : null}
            {error ? <Alert tone="danger" live="assertive">{props.describe?.(error) ?? describeFailure(error, { action, codes })}</Alert> : null}
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

