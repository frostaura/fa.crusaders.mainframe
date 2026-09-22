import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/utils";

/**
 * The product's dialog — and, until this change, a dialog that claimed to be one.
 *
 * <p>
 * <b>What it was.</b> Forty-two lines: a portal, Escape, a body scroll lock,
 * <code>aria-modal="true"</code>, and a backdrop click. <b>No focus management of any kind</b>
 * — no ref on the panel, no <code>.focus()</code>, no trap, no restore. Measured on the live
 * booking dialog at 375×812:
 * </p>
 *
 * <pre>
 * focus AFTER open : { tag: "BUTTON", label: "Book Court 4 at 23:15…", inDialog: false }
 *   tab1 -> "Keep looking"         inDialog: true
 *   tab2 -> "Book for 50.00 cr"    inDialog: true
 *   tab3 -> "Skip to main content" inDialog: FALSE   &lt;- walked out of the modal
 *   6 x Shift+Tab -> "Available"   inDialog: FALSE   &lt;- into the grid behind the scrim
 * after Escape     : focus = "Book Court 1 at 23:15…" &lt;- NOT the Court 4 cell that opened it
 * </pre>
 *
 * <p>
 * Three defects in one. A screen-reader user is confined by <code>aria-modal</code> while a
 * keyboard user is not, so the two disagree. Focus never enters the dialog, so a keyboard user
 * has to Tab blind to find the confirm. And Escape hands focus to a <em>different court's</em>
 * cell — on a grid of near-identical buttons, which is how a wrong booking gets made.
 * </p>
 *
 * <p>
 * <b>And the fourth, which is not about focus.</b> It closed on <em>any</em> overlay click, so
 * a mis-tap beside the dialog silently discarded a typed rejection reason, suspension reason or
 * credit adjustment. Below, an overlay click on a dialog somebody has typed into is ignored and
 * said out loud; Escape still closes, because Escape is a deliberate gesture and a mis-tap is
 * not. That asymmetry is the whole design.
 * </p>
 *
 * <p>
 * Every prop that existed still exists and means the same thing. `initialFocus` and
 * `describedById` are additive and optional.
 * </p>
 */

/**
 * What can hold focus inside a dialog.
 *
 * <p>
 * Deliberately a selector rather than a walk of the accessibility tree: a dialog's panel is a
 * small subtree, and `offsetParent`-style visibility checks answer `null` for everything under
 * jsdom, which would make the trap untestable in the runner that has to hold it.
 * </p>
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** What the dialog says when an overlay click is refused because there is typed text in it. */
export const MODAL_KEPT_OPEN = "Still here — your text hasn't been lost. Use Escape, or a button below, to close this.";

export function Modal({
  children,
  onClose,
  title,
  initialFocus,
  describedById,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
  /**
   * What to focus when the dialog opens. Defaults to the first focusable thing in the panel.
   *
   * <p>
   * Worth passing where the first focusable thing is the wrong one — a "Keep looking" that
   * comes before a text field the person is here to fill in. Return `null` and the default
   * applies, so a call site that cannot find its target does not land on `<body>`.
   * </p>
   */
  initialFocus?: () => HTMLElement | null | undefined;
  /** The id of the element that DESCRIBES the dialog, where one exists. Measured absent (D4 §2.3). */
  describedById?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  /**
   * Who opened it, captured on the FIRST render rather than in an effect.
   *
   * By the time an effect runs this component has already focused its own panel, so
   * `document.activeElement` is no longer the control the person pressed. A ref initialised
   * during render is the only moment that answer still exists.
   */
  const openerRef = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  /**
   * Whether anybody has typed into this dialog.
   *
   * <p>
   * Opt-in by observation rather than by a prop: `AdminMembers` opens five dialogs with fields
   * in them and none of them would remember to declare it, which is exactly how D3-B05 was
   * shipped. An `input` event anywhere inside the panel is the fact, and it is a fact no call
   * site has to know about.
   * </p>
   */
  const typedInto = useRef(false);
  const [kept, setKept] = useState(0);
  const [visible, setVisible] = useState(false);

  const focusables = useCallback((): HTMLElement[] => {
    const panel = panelRef.current;
    if (!panel) return [];
    return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
      .filter((el) => el.getAttribute("aria-hidden") !== "true" && !el.hasAttribute("inert"));
  }, []);

  // Escape, and the body scroll lock. Unchanged in behaviour from the version this replaces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  /**
   * Focus in, and focus back out. (D3-B05 / D4 §2.3)
   *
   * <p>
   * The restore is in the same effect as the entry deliberately: they are one promise — "I
   * will take the keyboard and I will give it back" — and splitting them across two effects is
   * how one of them ends up conditional on something the other is not.
   * </p>
   *
   * <p>
   * It gives focus back only where focus is still <em>inside this dialog or adrift</em>. A
   * page that moved focus somewhere deliberate while the dialog was closing — a receipt
   * heading, the row that replaced the one just edited — wins, exactly as `focusAfterAction`
   * declines for the same reason.
   * </p>
   */
  useEffect(() => {
    const panel = panelRef.current;
    const opener = openerRef.current;
    const target = initialFocus?.() ?? focusables()[0] ?? panel;
    target?.focus();
    return () => {
      const active = document.activeElement;
      const adrift = active === null || active === document.body || !active.isConnected;
      const stillInside = panel !== null && active !== null && panel.contains(active);
      if (!adrift && !stillInside) return;
      // `document.body` is an HTMLElement and is always connected, so "restore" to it is a
      // no-op that reads as success. There was no opener; leave focus where the page put it.
      if (opener === document.body) return;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
    // `initialFocus` is intentionally not a dependency: it is a call site's arrow function,
    // new on every render, and re-running this effect would re-focus the dialog under
    // somebody who had tabbed on — and, worse, run the restore cleanup while it is still open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusables]);

  /**
   * The trap. On `document`, not on the panel, and that is the point.
   *
   * <p>
   * A handler bound to the panel only fires while focus is already inside it, which is fine
   * until something outside takes focus — a toast, a browser autofill, a page that moved it —
   * and then the trap is gone for the rest of the dialog's life. On the document it can always
   * pull focus back, and it declines to interfere with anything that is not Tab.
   * </p>
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active !== null && panel.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first || active === panel) { e.preventDefault(); last.focus(); }
        return;
      }
      if (!inside || active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [focusables]);

  // Mount, then animate in on the next frame — the same shape `Toast` uses. The dialog had
  // `animationName: "none"` measured on it: the product's most consequential surface arrived
  // with no motion whatever, so nothing marked the moment the page stopped being usable.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setVisible(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  /**
   * An overlay click, refused where there is something to lose.
   *
   * <p>
   * D3-B05's second half. An untouched dialog still closes on a click outside, because that
   * is the gesture people expect and it costs nothing. A dialog with a half-typed suspension
   * reason in it does not, because the cost is the reason — and the click that discards it is
   * usually a mis-tap on a phone, not a decision.
   * </p>
   */
  const onOverlayClick = () => {
    if (!typedInto.current) { onClose(); return; }
    // `kept` increments rather than flipping a boolean: a live region whose text does not
    // change says nothing, and a second mis-tap is exactly when somebody needs telling again.
    setKept((n) => n + 1);
    panelRef.current?.focus();
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      aria-describedby={describedById}
      className="fixed inset-0 z-[100] bg-black/30 flex items-center justify-center p-4 overflow-auto"
      onClick={onOverlayClick}
    >
      <div
        ref={panelRef}
        /**
         * `tabIndex={-1}` — the panel is the floor under the trap.
         *
         * A dialog with nothing focusable in it (a receipt, a spinner) would otherwise have
         * nowhere to put the keyboard, and "nowhere" is `<body>`, which is outside the dialog
         * the `aria-modal` says the person is confined to.
         */
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        // Both events: React's `onChange` on a text input is the browser's `input`, but a
        // `<select>` and a checkbox fire `change` and not `input`. A dialog whose only typed
        // thing is a picked option is still a dialog with a decision in it.
        onInput={() => { typedInto.current = true; }}
        onChange={() => { typedInto.current = true; }}
        className={cn(
          "bg-bg-surface rounded-xl shadow-md max-w-md w-full p-5 outline-none",
          "transition-all duration-enter ease-out motion-reduce:transition-none",
          visible ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-1 scale-[0.98]",
        )}
      >
        <h3 className="font-semibold mb-3">{title}</h3>
        {children}
        {/* ONE polite region, empty until an overlay click is actually refused. `aria-live`
            without `role="status"`, exactly as `ConfirmButton` settles it — a status landmark
            per dialog is a landmark that is empty almost always. */}
        <span aria-live="polite" className="sr-only">
          <span key={kept}>{kept > 0 ? MODAL_KEPT_OPEN : ""}</span>
        </span>
      </div>
    </div>,
    document.body,
  );
}
