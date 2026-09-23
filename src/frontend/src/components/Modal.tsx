import { useCallback, useEffect, useRef } from "react";
import { DIALOG_KEPT_OPEN, Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

/**
 * The COMPAT dialog — `components/ui/dialog.tsx` (Radix Dialog) behind the props every existing
 * call site already passes: `title`, `onClose`, `initialFocus`, `describedById`.
 *
 * <p>
 * <b>What it keeps, and why each was earned.</b> The hand-rolled version this replaces was
 * measured on the live booking dialog with focus left on the cell behind, three Tabs walking out
 * into "Skip to main content", and Escape handing focus to a DIFFERENT court's cell — which on a
 * grid of near-identical buttons is how a wrong booking gets made (D3-B05 / D4 §2.3). So:
 * </p>
 * <ul>
 *   <li>focus goes in — to `initialFocus()` where the call site names one, else the first control;</li>
 *   <li>Tab is trapped (Radix's scope, plus a document-level guard below that also pulls focus
 *       back when something outside has taken it);</li>
 *   <li>focus comes back to the opener on close — unless the page moved it somewhere deliberate
 *       while the dialog was closing, which wins;</li>
 *   <li>an outside click is refused once anything has been typed or picked, and a polite live
 *       region says so, again on every refusal; Escape still closes (the primitive's guard);</li>
 *   <li>the body stops scrolling while it is open.</li>
 * </ul>
 *
 * <p>
 * <b>What is new:</b> the primitive's shape (bottom sheet below 640px, centred card above), the
 * h2 title, and <b>always a close ×</b> — a 44px icon button ({@link CLOSE_LABEL}), last in the DOM so
 * default focus still lands on the dialog's own first control. Deleted with the shims in P10.
 * </p>
 */

/** What the dialog says when an overlay click is refused because there is typed text in it. */
export const MODAL_KEPT_OPEN = DIALOG_KEPT_OPEN;

/**
 * The close ×'s name here. Not the primitive's bare "Close": the dialogs this shim serves carry
 * their own footer buttons, some already named "Close", and two controls with one name in one
 * dialog cannot be told apart by voice or by a screen-reader list. P5 rebuilds these dialogs on
 * the primitive's anatomy and this goes with the shim.
 */
export const CLOSE_LABEL = "Close dialog";

/** What can hold focus inside the panel — a selector, because jsdom has no layout to walk. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type ModalProps = {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
  /**
   * What to focus when the dialog opens. Defaults to the first focusable thing in the panel.
   * Return `null` and the default applies, so a call site that cannot find its target does not
   * land on `<body>`.
   */
  initialFocus?: () => HTMLElement | null | undefined;
  /** The id of the element that DESCRIBES the dialog, where one exists. None is invented. */
  describedById?: string;
};

/**
 * The document-level half of the trap.
 *
 * <p>
 * Radix traps Tab with a handler on the panel, which only fires while focus is already inside.
 * On the document this can also pull focus back after something outside took it — a toast, an
 * autofill, a page that moved it — and it stands aside when Radix has already handled the key.
 * </p>
 */
function useTabTrap(panelRef: React.RefObject<HTMLDivElement | null>) {
  const focusables = useCallback((): HTMLElement[] => {
    const panel = panelRef.current;
    if (!panel) return [];
    return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
      .filter((el) => el.getAttribute("aria-hidden") !== "true" && !el.hasAttribute("inert"));
  }, [panelRef]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const panel = panelRef.current;
      if (e.key !== "Tab" || e.defaultPrevented || !panel) return;
      const items = focusables();
      const active = document.activeElement;
      const inside = active !== null && panel.contains(active);
      const [first, last] = [items[0], items[items.length - 1]];
      const wrapTo = e.shiftKey
        ? (!inside || active === first || active === panel ? last : null)
        : (!inside || active === last ? first : null);
      if (!wrapTo) return;
      e.preventDefault();
      wrapTo.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [focusables, panelRef]);
}

/**
 * Focus back to whoever opened it — captured on the FIRST render, because by the time an effect
 * runs the dialog has already taken focus and `document.activeElement` is no longer the opener.
 *
 * <p>
 * Restored in the unmount cleanup, synchronously, and only where focus is still inside the dialog
 * or adrift: a page that moved focus somewhere deliberate while the dialog was closing (a receipt
 * heading, the row that replaced the one just edited) wins, as `focusAfterAction` declines for
 * the same reason. Radix Dialog restores focus only to its own `DialogTrigger`, which this
 * compat dialog never renders (call sites mount and unmount it), so this is the only restore.
 * </p>
 */
function useRestoreFocus(panelRef: React.RefObject<HTMLDivElement | null>) {
  const openerRef = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  useEffect(() => {
    const opener = openerRef.current;
    const panel = panelRef.current;
    return () => {
      const active = document.activeElement;
      const adrift = active === null || active === document.body || !active.isConnected;
      const stillInside = panel !== null && active !== null && panel.contains(active);
      if (!adrift && !stillInside) return;
      if (opener === document.body) return;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [panelRef]);
}

/** The body scroll lock, restored exactly as it was found. */
function useScrollLock() {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, []);
}

/**
 * A tap on a toast is not a tap outside the dialog. Toasts sit above every dialog (`z-toast`)
 * and are dismissed by tapping them; without this, dismissing one would dismiss the dialog under
 * it too — and with it whatever the toast was explaining.
 */
function keepOpenForToasts(event: Event) {
  const target = event.target;
  if (target instanceof Element && target.closest("[data-toast-viewport]")) event.preventDefault();
}

export function Modal({ children, onClose, title, initialFocus, describedById }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useTabTrap(panelRef);
  useRestoreFocus(panelRef);
  useScrollLock();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        ref={panelRef}
        initialFocus={initialFocus}
        // Always passed, even as undefined: Radix otherwise points describedby at a Description
        // this dialog does not render. A describedby pointing at nothing is worse than none.
        aria-describedby={describedById}
        // Radix hides everything outside instead of declaring the modality; say it as well, as
        // the dialog this replaces did — AT that reads `aria-modal` confines itself either way.
        aria-modal="true"
        closeLabel={CLOSE_LABEL}
        onInteractOutside={keepOpenForToasts}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="pb-4 sm:pb-6">{children}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}
