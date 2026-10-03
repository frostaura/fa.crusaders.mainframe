import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { CaretDown, X } from "@/components/ui/icons";
import { SCALING_ICON, SCALING_ICON_TARGET } from "@/components/ui/layout";
import { cn } from "@/lib/utils";

// Up here, above every function: lizard's .tsx lexer reads this generic as a tag, and below
// `rescueFromBody` it ran that function on to the end of the file (R7) — every dialog part
// after it went unmeasured. The surface's props (`DialogSurface`).
type ContentProps = React.ComponentProps<typeof DialogPrimitive.Content>;
type SurfaceProps = ContentProps & {
  /** Refuse outside clicks once something inside has been typed into. Default `true`. */
  guardTyped?: boolean;
  /**
   * What to focus on open. Defaults to Radix's choice (the first tabbable control). Return
   * `null` and the default applies, so a call site that cannot find its target never lands on
   * `<body>`.
   */
  initialFocus?: () => HTMLElement | null | undefined;
  /**
   * @deprecated Ignored (F4-9): the × is always "Close" + the dialog's title, so it can never
   * share a name with a footer button. Kept only so call sites compile until they drop it.
   */
  closeLabel?: string;
};

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
 * <b>Always a close ×.</b> Every dialog carries a 44px icon button named "Close" and its title, top-right — it is
 * rendered by the content itself, so a call site cannot forget it. It sits LAST in the DOM so the
 * default initial focus lands on the dialog's own first control, not on the way out.
 * </p>
 *
 * <p>
 * <b>Focus goes back where it came from (F4.5).</b> Radix returns focus on close only to a
 * `DialogTrigger`, and almost no dialog here has one — they open from a grid cell, a row, a menu
 * or a state change — so eleven of them dropped focus on `<body>`: a keyboard user back at the top
 * of the document, a screen-reader user in silence. The surface records what had focus when it
 * opened and returns it there; when that element has gone (a menu item, a re-rendered row) it
 * falls back to the page's `<main>`, never to `<body>`. A call site's own `onCloseAutoFocus` that
 * prevents the default (ConfirmDialog, MemberDialogs) still wins.
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
/** The close ×'s own word; its accessible name is this plus the dialog's title (F4-9). */
export const DIALOG_CLOSE = "Close";

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

/**
 * The 44px close ×, shared by dialog and sheet so there is one of it.
 *
 * <p>
 * <b>Named "Close" + the dialog's own title (F4-9)</b> — "Close Top up", "Close Record a result" —
 * through `aria-labelledby` pointing at its own word and at the title Radix already labels the
 * dialog with. Call sites used to rename it "Cancel" or leave it "Close", and either way a screen
 * reader's button list read two identical names, the × and the footer's own Cancel/Close, with no
 * way to tell which was which. The title id is read off the rendered dialog (Radix does not export
 * it), set as an attribute React never manages. A dialog with no title still says "Close".
 * </p>
 */
function CloseButton() {
  const wordId = React.useId();
  const ref = React.useRef<HTMLButtonElement>(null);
  React.useLayoutEffect(() => {
    const button = ref.current;
    const titleId = button?.closest("[role=dialog], [role=alertdialog]")?.getAttribute("aria-labelledby");
    if (button && titleId && document.getElementById(titleId)) button.setAttribute("aria-labelledby", `${wordId} ${titleId}`);
  });
  return (
    <DialogPrimitive.Close
      ref={ref}
      data-slot="dialog-close"
      className={cn(
        "absolute right-2 top-2 inline-flex items-center justify-center rounded-lg", SCALING_ICON_TARGET,
        "border border-transparent text-text-secondary transition-colors duration-fast ease-standard",
        "hover:bg-bg-muted hover:text-text-primary motion-reduce:transition-none",
      )}
    >
      <X size={SCALING_ICON} aria-hidden="true" />
      <span id={wordId} className="sr-only">{DIALOG_CLOSE}</span>
    </DialogPrimitive.Close>
  );
}

/**
 * The control a pointer last pressed, whatever it was. iOS Safari (and a mouse in desktop Safari)
 * does not focus a button it taps, so a dialog opened by a tap finds `<body>` in
 * `document.activeElement` — the pressed element is the only record of what opened it. One
 * capture-phase listener for the page, installed on first use; the target is resolved to the
 * nearest control so a tap on an icon inside a button returns to the button.
 */
let lastPressed: { element: HTMLElement; at: number } | null = null;
let pressListening = false;

function listenForPresses() {
  if (pressListening || typeof document === "undefined") return;
  pressListening = true;
  document.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest<HTMLElement>("button, a[href], [role=button], [tabindex], input, select, textarea, summary");
    if (control) lastPressed = { element: control, at: Date.now() };
  }, true);
}

/** A press this recent opened the dialog; an older one is somebody else's history. */
const PRESS_WINDOW_MS = 2_000;

/**
 * What opened the surface — read in a layout effect, which runs before Radix's focus scope moves
 * focus inside (a passive effect). Two records: what had FOCUS, and what was PRESSED just before.
 */
function useOpener() {
  const opener = React.useRef<{ focused: Element | null; pressed: HTMLElement | null }>({ focused: null, pressed: null });
  React.useLayoutEffect(() => {
    // A dialog opening now owns focus; a rescue queued by the last one closing must not move it.
    cancelRescue();
    const pressed = lastPressed && Date.now() - lastPressed.at <= PRESS_WINDOW_MS ? lastPressed.element : null;
    opener.current = { focused: document.activeElement, pressed };
  }, []);
  return opener;
}

listenForPresses();

/** An element focus can go back to: in the page, and not `<body>`. */
function usable(element: Element | null): HTMLElement | null {
  return element instanceof HTMLElement && element !== document.body && element.isConnected ? element : null;
}

/**
 * Where focus goes on close, in order: what had focus when the dialog opened, still in the page;
 * else what was pressed to open it (a tap in iOS Safari focuses nothing); else null, and Radix's
 * own default runs (it knows a `DialogTrigger`) with `<main>` as the last resort.
 */
function usableOpener(opener: { focused: Element | null; pressed: HTMLElement | null }): HTMLElement | null {
  return usable(opener.focused) ?? usable(opener.pressed);
}

/**
 * The one pending rescue. It has to outlive the dialog that scheduled it — the surface is
 * unmounting when it runs, which is the point — so it is not tied to a component; it is cancelled
 * when the next dialog opens or the next rescue is scheduled instead. CI caught the leak: a timer
 * left by a closed dialog fired after the test environment was torn down ("document is not
 * defined", dialog.tsx in AdminMembers.test.tsx), which in a browser is a stray focus move after
 * whatever came next had already placed focus.
 */
let pendingRescue: ReturnType<typeof setTimeout> | null = null;

function cancelRescue(): void {
  if (pendingRescue !== null) clearTimeout(pendingRescue);
  pendingRescue = null;
}

/** Radix's default left focus on `<body>`: the page's `<main>` takes it. */
function rescueFromBody(): void {
  cancelRescue();
  pendingRescue = setTimeout(() => {
    pendingRescue = null;
    if (typeof document === "undefined") return; // the page (or a test environment) is gone
    const active = document.activeElement;
    if (active && active !== document.body) return;
    // `as`, not `querySelector<HTMLElement>`: lizard's .tsx lexer reads the generic as a tag and ran
    // this function on through the rest of the file (R7: 227 "lines").
    (document.getElementById("main-content") ?? (document.querySelector("main") as HTMLElement | null))?.focus({ preventScroll: true });
  }, 0);
}


/** The root font size in px — a rem, as the text-size setting has made it. */
function rootPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * R8 L8-12 — where a top-anchored dialog (`dialog-shape` TOP_ANCHORED_SHEET, D12) puts its top
 * edge, published as `--dialog-top` on the surface. It opens CENTRED (it sat at a fixed 4rem: 64px
 * above and 235px below a 500px Book dialog at 1280 × 800, and at 200 % text 8rem ran it to 808 of
 * 800), then holds that top while a step changes its height — D12's point, only the bottom edge
 * moves — and gives way upward only as far as keeps the bottom on the screen. One rem from either
 * edge at least. The other shapes ignore the variable; below `sm` the sheet is a bottom sheet.
 */
function useOpenCentred() {
  // A child of the surface, not a ref on it: the surface's own `ref` belongs to the call site.
  const inside = React.useRef(null as HTMLSpanElement | null);
  React.useLayoutEffect(() => {
    const el = inside.current?.parentElement;
    if (!el) return undefined;
    let held: number | null = null;
    const place = (recentre: boolean) => {
      const room = window.innerHeight;
      const gap = rootPx();
      const height = el.offsetHeight;
      if (held === null || recentre) held = Math.max(gap, (room - height) / 2);
      const top = Math.max(gap, Math.min(held, room - gap - height));
      el.style.setProperty("--dialog-top", `${Math.round(top)}px`);
    };
    place(true);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => place(false)) : null;
    observer?.observe(el);
    const recentre = () => place(true);
    window.addEventListener("resize", recentre);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", recentre);
    };
  }, []);
  return inside;
}

/**
 * The raised panel with its guard, live region and close × — everything a dialog and a sheet
 * share except their shape. Exported for `sheet.tsx`; call sites use `DialogContent`/`SheetContent`.
 */
function DialogSurface(props: SurfaceProps) {
  const {
    guardTyped = true,
    initialFocus,
    closeLabel: _ignoredCloseLabel,
    className,
    children,
    onOpenAutoFocus,
    onCloseAutoFocus,
    onPointerDownOutside,
    onInteractOutside,
    onInputCapture,
    onChangeCapture,
    ...rest
  } = props;
  const guard = useTypedGuard(guardTyped);
  const opener = useOpener();
  const inside = useOpenCentred();
  const returnFocus = (event: Event) => {
    if (event.defaultPrevented) return; // the call site placed focus itself
    const target = usableOpener(opener.current);
    if (!target) { rescueFromBody(); return; }
    event.preventDefault();
    target.focus({ preventScroll: true });
  };
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
      onCloseAutoFocus={composed(onCloseAutoFocus, returnFocus)}
      onPointerDownOutside={composed(onPointerDownOutside, (e: Event) => guard.refuse(e, true))}
      onInteractOutside={composed(onInteractOutside, (e: Event) => guard.refuse(e, false))}
      onInputCapture={composed(onInputCapture, guard.markTyped)}
      onChangeCapture={composed(onChangeCapture, guard.markTyped)}
      {...rest}
    >
      {children}
      <CloseButton />
      <span ref={inside} aria-live="polite" className="sr-only">
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

/**
 * R8 L8-5 — the dialog's gutters stop growing with the text at their normal-text pixels below `sm`:
 * at 320 / 200 % text a rem gutter was 32px a side of a 320px sheet, and the footer's rem padding
 * and gap made two stacked buttons 212px of a 589px sheet. The words grow; the gutters need not.
 */
const SHEET_GUTTER = "px-[min(1rem,16px)] sm:px-6";

/**
 * Only the FIRST row of the header clears the close × (R8 L8-5): its right margin is the ×'s
 * target less the header's own gutter, and it is at least as tall as the × reaches, so the next
 * row starts under it. Every row used to carry `pr-14` — 112px of a 320px phone at 200 % text,
 * all the way down a description that never came near the ×.
 */
const CLEAR_OF_CLOSE = "[&>:first-child]:mr-[calc(0.5rem+max(44px,2rem)-min(1rem,16px)+4px)] [&>:first-child]:min-h-[calc(0.5rem+max(44px,2rem)-min(1rem,16px))]";

/**
 * The header's cap: a quarter of the screen on a phone, a third from `sm` — but never less than its
 * title needs (`--dialog-title-room`, measured), so the cap can cut the description, never the title.
 */
const HEADER_CAP = "max-h-[max(25dvh,var(--dialog-title-room,0px))] sm:max-h-[max(33dvh,var(--dialog-title-room,0px))]";

/**
 * Title + description. Padded clear of the close × beside its first row.
 *
 * R4: never more than a share of the screen's height — at 200 % text on a 320×640 phone the title,
 * description and stepper took nearly the whole sheet and left the body a sliver. At normal text a
 * header is far below the cap; at large text it scrolls on its own and the body keeps the rest.
 */
function DialogHeader({ className, children, ...props }: React.ComponentProps<"div">) {
  const ref = React.useRef<HTMLDivElement>(null);
  const { cut, more } = useHeaderCut(ref);
  return (
    <div
      ref={ref}
      data-slot="dialog-header"
      className={cn(
        "relative flex shrink-0 flex-col gap-1.5 overflow-y-auto overscroll-contain pb-2 pt-[min(1rem,16px)] sm:pt-6",
        // Its rows never shrink: the header scrolls instead (a floor on the first row let it squeeze).
        "[&>*]:shrink-0", SHEET_GUTTER, HEADER_CAP, CLEAR_OF_CLOSE,
        className,
      )}
      {...props}
    >
      {children}
      {/*
        R7 L7-14 / R8 — while the header is cut (200 % text on a phone) a strip at its foot says
        there is more: a caret on the sheet's own surface, sticky at the scroller's foot. Opaque and
        in the flow, so it ENDS the visible text rather than painting over its last line (R8: the
        R7 fade and caret sat on top of the words); at the end of the scroll it is empty.
      */}
      {cut ? (
        <span data-header-foot="" data-more-below={more ? "" : undefined} aria-hidden="true"
          className={cn("pointer-events-none sticky -bottom-2 -mb-2 flex h-6 shrink-0 items-center justify-center bg-bg-raised", more && "border-t border-border")}>
          {more ? <CaretDown size="1rem" weight="bold" className="text-text-secondary" /> : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The header's own measure: where its last row ends, whether its cap cuts it, whether more is below
 * what shows above the foot strip — and the room its title needs, set as `--dialog-title-room`.
 */
function measureHeader(el: HTMLElement): { cut: boolean; more: boolean } {
  const parts = Array.from(el.children).filter((c) => !c.hasAttribute("data-header-foot")).map((c) => c as HTMLElement);
  const bottom = Math.max(0, ...parts.map((c) => c.offsetTop + c.offsetHeight));
  const strip = 1.5 * rootPx();
  const title = el.querySelector("[data-slot=dialog-title]") ?? parts[0];
  if (title instanceof HTMLElement) el.style.setProperty("--dialog-title-room", `${Math.ceil(title.offsetTop + title.offsetHeight + strip + 4)}px`);
  const cut = bottom + (parseFloat(getComputedStyle(el).paddingBottom) || 0) > el.clientHeight + 2;
  return { cut, more: cut && el.scrollTop + el.clientHeight - strip < bottom - 2 };
}

/**
 * Whether the header is cut by its cap, and whether there is more below what it shows — re-measured
 * on scroll and on any resize. Publishes `--dialog-title-room`: what the title needs, from the top
 * of the header to the foot of the strip under it.
 */
function useHeaderCut(ref: React.RefObject<HTMLElement | null>): { cut: boolean; more: boolean } {
  const [state, setState] = React.useState({ cut: false, more: false });
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const next = measureHeader(el);
      setState((prev) => (prev.cut === next.cut && prev.more === next.more ? prev : next));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    for (const child of Array.from(el.children)) observer?.observe(child);
    return () => {
      el.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [ref]);
  return state;
}

/** The part that scrolls when the content is taller than the screen; header and footer stay put. */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain py-2", SHEET_GUTTER, className)}
      {...props}
    />
  );
}

/**
 * Actions. Source order is dismiss first, primary last, and the visual order is the SAME on every
 * width (F4-8): stacked on a phone with the primary at the foot, under the thumb; in a row on
 * desktop with the primary on the right. It used to be `flex-col-reverse`, which painted the
 * primary on top while Tab still met Cancel first — keyboard and switch users ran the footer
 * bottom-up (Cancel before Continue, Back before Book), and a dialog's first focus could land on
 * the lower button.
 */
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col gap-[min(0.5rem,8px)] pb-[min(1rem,16px)] pt-[min(0.5rem,8px)] sm:flex-row sm:justify-end sm:gap-2 sm:pb-6 sm:pt-2",
        SHEET_GUTTER,
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
