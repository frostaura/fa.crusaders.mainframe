import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * The product's dialog — Radix Dialog, restyled to our vocabulary (design-system.md, Components).
 *
 * <p>
 * <b>CSS-responsive, one component.</b> Below `sm` it is a bottom sheet (full width, rounded top,
 * slides up); from `sm` it is a centred `max-w-md` card that pops in. Nothing measures the viewport
 * in JavaScript, so the two shapes cannot disagree about which one is showing.
 * </p>
 *
 * <p>
 * <b>Always a close ×.</b> Every dialog carries a 44px icon button named "Close", top-right — it is
 * rendered by the content itself, so a call site cannot forget it. It sits LAST in the DOM so the
 * default initial focus lands on the dialog's own first control, not on the way out.
 * </p>
 *
 * <p>
 * <b>A mis-tap on the scrim never discards typing.</b> Mirrors `components/Modal.tsx` (D3-B05):
 * once anything inside has fired `input` or `change`, a pointer-down outside is refused and a polite
 * live region says so. Escape still closes — Escape is a deliberate gesture, a mis-tap is not.
 * `guardTyped={false}` opts out for a dialog whose fields are disposable (a search box).
 * </p>
 */

/** What the dialog says when an outside click is refused because there is typed text in it. */
export const DIALOG_KEPT_OPEN =
  "Still here — your text hasn't been lost. Use Escape, or a button below, to close this.";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

/** The scrim. `bg-overlay` already carries the theme's alpha (45% light, 70% dark). */
function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-overlay bg-overlay animate-overlay-in data-[state=closed]:animate-overlay-out",
        "motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Whether anybody has typed into this surface, and how many outside clicks have been refused.
 *
 * <p>
 * Opt-in by observation rather than by a prop, exactly as `Modal` settled it: a call site with a
 * reason field would never remember to declare "I have a reason field". `kept` counts rather than
 * flips — a live region whose text does not change says nothing the second time.
 * </p>
 */
function useTypedGuard(enabled: boolean) {
  const typed = React.useRef(false);
  const [kept, setKept] = React.useState(0);
  const markTyped = React.useCallback(() => {
    typed.current = true;
  }, []);
  const refuse = React.useCallback(
    (event: Event, announce: boolean) => {
      if (!enabled || !typed.current) return;
      event.preventDefault();
      if (announce) setKept((n) => n + 1);
    },
    [enabled],
  );
  return { kept, markTyped, refuse };
}

function composed<E>(theirs: ((event: E) => void) | undefined, ours: (event: E) => void) {
  return (event: E) => {
    theirs?.(event);
    ours(event);
  };
}

/** The 44px close ×, shared by dialog and sheet so there is one of it. */
function CloseButton({ label }: { label: string }) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      className={cn(
        "absolute right-2 top-2 inline-flex size-touch items-center justify-center rounded-lg",
        "border border-transparent text-text-secondary transition-colors duration-fast ease-standard",
        "hover:bg-bg-muted hover:text-text-primary motion-reduce:transition-none",
      )}
    >
      <X size={20} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </DialogPrimitive.Close>
  );
}

type SurfaceProps = React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** Refuse outside clicks once something inside has been typed into. Default `true`. */
  guardTyped?: boolean;
  /**
   * What to focus on open. Defaults to Radix's choice (the first tabbable control). Return
   * `null` and the default applies, so a call site that cannot find its target never lands on
   * `<body>`.
   */
  initialFocus?: () => HTMLElement | null | undefined;
  /** The close ×'s accessible name. "Close" unless the dialog's copy says otherwise. */
  closeLabel?: string;
};

/**
 * The raised panel with its guard, live region and close × — everything a dialog and a sheet
 * share except their shape. Exported for `sheet.tsx`; call sites use `DialogContent`/`SheetContent`.
 */
function DialogSurface(props: SurfaceProps) {
  const {
    guardTyped = true,
    initialFocus,
    closeLabel = "Close",
    className,
    children,
    onOpenAutoFocus,
    onPointerDownOutside,
    onInteractOutside,
    onInputCapture,
    onChangeCapture,
    ...rest
  } = props;
  const guard = useTypedGuard(guardTyped);
  const focusInitial = (event: Event) => {
    const target = initialFocus?.();
    if (!target) return;
    event.preventDefault();
    target.focus();
  };
  return (
    <DialogPrimitive.Content
      className={cn("fixed z-modal flex flex-col border border-border bg-bg-raised text-text-primary shadow-lg", className)}
      onOpenAutoFocus={composed(onOpenAutoFocus, focusInitial)}
      onPointerDownOutside={composed(onPointerDownOutside, (e: Event) => guard.refuse(e, true))}
      onInteractOutside={composed(onInteractOutside, (e: Event) => guard.refuse(e, false))}
      onInputCapture={composed(onInputCapture, guard.markTyped)}
      onChangeCapture={composed(onChangeCapture, guard.markTyped)}
      {...rest}
    >
      {children}
      <CloseButton label={closeLabel} />
      <span aria-live="polite" className="sr-only">
        <span key={guard.kept}>{guard.kept > 0 ? DIALOG_KEPT_OPEN : ""}</span>
      </span>
    </DialogPrimitive.Content>
  );
}

const DIALOG_SHAPE = [
  // Below sm: a bottom sheet.
  "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]",
  "animate-sheet-up data-[state=closed]:animate-sheet-down",
  // From sm: centred without a transform, so the pop-in's scale cannot fight a translate.
  "sm:inset-0 sm:m-auto sm:h-fit sm:max-h-[85dvh] sm:w-full sm:max-w-md sm:rounded-2xl sm:pb-0",
  "sm:animate-pop-in sm:data-[state=closed]:animate-pop-out",
  "motion-reduce:animate-none",
].join(" ");

/** Portal + scrim + the responsive panel. */
function DialogContent({ className, ...props }: SurfaceProps) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogSurface data-slot="dialog-content" className={cn(DIALOG_SHAPE, className)} {...props} />
    </DialogPortal>
  );
}

/** Title + description. Padded clear of the close × on the right. */
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 pb-2 pl-4 pr-14 pt-4 sm:pl-6 sm:pt-6", className)}
      {...props}
    />
  );
}

/** The part that scrolls when the content is taller than the screen; header and footer stay put. */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2 sm:px-6", className)}
      {...props}
    />
  );
}

/**
 * Actions. Source order is dismiss first, primary last: `flex-col-reverse` puts the primary on
 * top on a phone (under the thumb), `sm:flex-row sm:justify-end` puts it on the right on desktop.
 */
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 px-4 pb-4 pt-2 sm:flex-row sm:justify-end sm:px-6 sm:pb-6",
        className,
      )}
      {...props}
    />
  );
}

/** The dialog's name — an `h2`, lg, 600. */
function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg font-semibold text-text-primary", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-text-secondary", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogSurface,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
export type { SurfaceProps as DialogContentProps };
