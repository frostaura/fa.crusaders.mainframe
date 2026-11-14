import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { CheckCircle, Info, Warning, WarningCircle, X, type Icon } from "./ui/icons";
import { toastReadingMs } from "./toastTiming";
import { ToastContext, type ToastContextValue } from "./toastContext";

export type ToastTone = "info" | "success" | "danger" | "warning";

type ToastItem = {
  id: number;
  tone: ToastTone;
  text: string;
  /** ms before the toast auto-dismisses. Default 4000. Set 0 to keep until manually closed. */
  durationMs: number;
  /** Whether this failure left the world exactly as it was. See {@link NOTHING_CHANGED}. */
  unchanged: boolean;
  /** When it was raised (ms). A move to another page drops toasts older than {@link TOAST_KEEP_ACROSS_NAV_MS}. */
  raisedAt: number;
};

/**
 * Go-live BM-14 — a toast is about the page it was raised on. "Couldn't add the passkey" from the
 * get-started wizard stayed over My Code for 40 s after Finish, on the screen held to the door
 * scanner. Moving to another page now dismisses every toast raised more than this long before the
 * move; one raised in the same breath as the navigation ("Booking cancelled", then the list) is the
 * news of the move, and travels with it.
 */
export const TOAST_KEEP_ACROSS_NAV_MS = 1500;

/**
 * The sentence, in one place, because it is a claim about the world and not a wording.
 *
 * Exported so a call site can assert on it, and so the four doors call sites and the two
 * device ones cannot each invent their own near-miss of it.
 */
export const NOTHING_CHANGED = "Nothing changed.";

/** The toast's own words that are not a call site's (R19 X19-3: its dismiss button's name). */
export const TOAST_COPY = { dismiss: "Dismiss" } as const;

export function ToastProvider({ children, routeKey }: { children: React.ReactNode; routeKey?: string }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  // BM-14: a change of page drops what the last page said, unless it was said just now.
  const lastRoute = useRef(routeKey);
  useEffect(() => {
    if (lastRoute.current === routeKey) return;
    lastRoute.current = routeKey;
    const cutoff = Date.now() - TOAST_KEEP_ACROSS_NAV_MS;
    setToasts((t) => (t.some((x) => x.raisedAt < cutoff) ? t.filter((x) => x.raisedAt >= cutoff) : t));
  }, [routeKey]);

  const remove = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback<ToastContextValue["push"]>((input) => {
    const id = ++idRef.current;
    const unchanged = input.unchanged ?? false;
    const asked = input.durationMs ?? 4000;
    const item: ToastItem = {
      id,
      tone: input.tone ?? "info",
      text: input.text,
      // X4-8: never less than the words take to read ("Nothing changed." included); 0 still means
      // "until dismissed".
      durationMs: asked === 0 ? 0 : Math.max(asked, toastReadingMs(unchanged ? `${input.text} ${NOTHING_CHANGED}` : input.text)),
      unchanged,
      raisedAt: Date.now(),
    };
    setToasts((t) => [...t, item]);
  }, []);


  // One value for the life of the provider: it re-renders on every change of page now (BM-14),
  // and a fresh object each time would re-render every `useToast` caller — the whole grid.
  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={remove} />
    </ToastContext.Provider>
  );
}

/** Tone → the coloured bar on the leading edge and the mark beside the words. */
const TONE_BAR: Record<ToastTone, string> = {
  info: "bg-info-strong",
  success: "bg-success-strong",
  warning: "bg-warning-strong",
  danger: "bg-danger-strong",
};

const TONE_INK: Record<ToastTone, string> = {
  info: "text-info-strong",
  success: "text-success-strong",
  warning: "text-warning-strong",
  danger: "text-danger-strong",
};

/** The shape carries the tone as well as the colour — colour is never the only signal. */
const TONE_ICON: Record<ToastTone, Icon> = {
  info: Info,
  success: CheckCircle,
  warning: Warning,
  danger: WarningCircle,
};

/**
 * Where toasts appear (design-system.md, Components → toast).
 *
 * <p>
 * <b>Phone: bottom-centre, ABOVE the tab bar.</b> The shell publishes the bar's height as
 * `--app-bottom-bar-height` (it already includes the safe area); where there is no bar the
 * home-indicator inset is the floor, so the strip never sits under the gesture bar (the viewport
 * meta carries `viewport-fit=cover`). The bottom is also the far side of the screen from the
 * status lines a failure toast most often contradicts (R3-28 / B10). A docked ContextBar (Top up,
 * Accept &amp; pay) publishes `--context-bar-height`, and the strip climbs over it rather than
 * covering the one verb the page docked within thumb reach (R4 form factor).
 * </p>
 *
 * <p>
 * <b>From `sm`: top-right, under the measured chrome</b> (`--app-chrome-height`, published by the
 * layout — B13 replaced a guessed `top-[100px]` that covered the tab strip), 384px wide.
 * </p>
 *
 * <p>
 * A CLASS, not an inline style: jsdom's CSS parser mangles `env()` in an inline declaration, so
 * the only assertion that could hold the anchoring would be asserting about a string jsdom
 * invented. Tailwind emits the arbitrary value verbatim, where the browser parses it.
 * </p>
 */
export const TOAST_VIEWPORT_CLASS = cn(
  "pointer-events-none fixed inset-x-[min(1rem,16px)] z-toast mx-auto flex max-w-md flex-col items-stretch gap-2",
  "bottom-[calc(max(var(--app-bottom-bar-height,0px),env(safe-area-inset-bottom,0px))+12px+var(--context-bar-height,0px))]",
  "sm:bottom-auto sm:left-auto sm:right-6 sm:top-[calc(var(--app-chrome-height,4rem)+12px)] sm:mx-0 sm:w-96",
);

function ToastViewport({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  /**
   * <b>`z-toast`, above every dialog and popover</b> (z-index scale: modal 50, popover 60,
   * toast 70). A toast raised while a dialog was open once painted UNDER the scrim, so the only
   * explanation a member got for a refusal read as greyed-out background chrome.
   *
   * <p>
   * <b>R19 X19-3 — THIS is the live region, and it is there, empty, from the first frame.</b>
   * NVDA and JAWS announce what CHANGES inside a live region they already know about; a toast that
   * arrived as its own pre-filled `role="status"` (its text overridden by an `aria-label`) was a
   * region they met already full, and may say nothing about. The viewport is rendered by the
   * provider at the app's root before any toast exists; each toast is inserted into it and carries
   * no live role of its own. Still exactly one live ancestor per toast (C10 — nesting a status in
   * a live container is what announced the download toast twice), now the one that was waiting.
   * Polite, additions only: a toast leaving is not news.
   * </p>
   */
  return (
    <div data-toast-viewport aria-live="polite" aria-relevant="additions text" className={TOAST_VIEWPORT_CLASS}>
      {toasts.map((t) => (
        <ToastView key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/**
 * The toast's clock (R4, X4-8 — WCAG 2.2.1): it runs only while nobody is reading it. A pointer
 * resting on the toast or keyboard focus on it stops the clock; leaving starts it again with
 * what was left, never from zero and never from nothing.
 */
function useToastClock(toast: ToastItem, onDismiss: (id: number) => void) {
  const [visible, setVisible] = useState(false);
  const clock = useRef({ left: toast.durationMs, startedAt: 0, timer: 0, hovered: false, focused: false });

  const leave = useCallback(() => {
    setVisible(false);
    window.setTimeout(() => onDismiss(toast.id), 250);
  }, [onDismiss, toast.id]);

  const stop = useCallback(() => {
    const c = clock.current;
    if (!c.timer) return;
    window.clearTimeout(c.timer);
    c.timer = 0;
    c.left = Math.max(0, c.left - (Date.now() - c.startedAt));
  }, []);

  const start = useCallback(() => {
    const c = clock.current;
    if (c.timer || toast.durationMs <= 0 || c.hovered || c.focused) return;
    c.startedAt = Date.now();
    c.timer = window.setTimeout(() => { c.timer = 0; leave(); }, c.left);
  }, [leave, toast.durationMs]);

  useEffect(() => {
    // Mount → animate in next frame.
    const enter = window.requestAnimationFrame(() => setVisible(true));
    start();
    return () => {
      window.cancelAnimationFrame(enter);
      stop();
    };
  }, [start, stop]);

  const hold = (why: "hovered" | "focused", on: boolean) => {
    clock.current[why] = on;
    if (on) stop();
    else start();
  };
  return { visible, leave, hold };
}

function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const { visible, leave: dismiss, hold } = useToastClock(toast, onDismiss);
  const Mark = TONE_ICON[toast.tone];
  const wordsId = `toast-words-${toast.id}`;

  // Dismissed by tapping anywhere on it (a pointer's convenience), and by its own button — the
  // keyboard's and the screen reader's way, named "Dismiss" and described by the toast's words
  // (R19 X19-3). The surface itself is no longer a live region or a labelled control: its words
  // are what the viewport's live region announces, unaltered.
  return (
    <div
      data-toast=""
      // The shared affordance (a pressable surface looks pressable): a tap anywhere dismisses it.
      data-interactive
      data-tone={toast.tone}
      onClick={dismiss}
      onMouseEnter={() => hold("hovered", true)}
      onMouseLeave={() => hold("hovered", false)}
      onFocus={() => hold("focused", true)}
      onBlur={() => hold("focused", false)}
      className={cn(
        // R19 (B13, measured) — gutters, gaps and the dismiss button in PIXELS: in rem, at 320 / 200 %
        // they left the words a 76px column and a one-sentence toast stood 410px tall over the page.
        "pointer-events-auto relative flex w-full select-none items-start gap-[min(0.75rem,12px)] overflow-hidden",
        "rounded-xl border border-border bg-bg-raised py-[min(0.75rem,12px)] pl-[min(1.25rem,20px)] pr-[min(1rem,16px)] text-sm text-text-primary shadow-lg",
        // `duration-enter` — the timing lives in the token layer; the removal timer below is
        // `durationMs + 250`, which clears the 220ms this resolves to.
        "transition-all duration-enter ease-out motion-reduce:transition-none",
        visible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
      )}
    >
      <span aria-hidden="true" data-toast-bar className={cn("absolute inset-y-0 left-0 w-1", TONE_BAR[toast.tone])} />
      <Mark size={20} aria-hidden="true" className={cn("shrink-0", TONE_INK[toast.tone])} />
      <span id={wordsId} className="min-w-0 flex-1 break-words font-medium">
        {toast.text}
        {/* R3-28 — the second fact, in the same breath as the first. "It did not work" leaves an
            admin looking at a status line they can no longer trust; "and nothing changed" is the
            sentence that lets them stop looking. Its own line, so a call site cannot half-say it.
            A space before it, so the announced words read as two sentences, not "done.Nothing". */}
        {toast.unchanged && <span className="mt-0.5 block font-normal text-text-secondary">{` ${NOTHING_CHANGED}`}</span>}
      </span>
      <button
        type="button"
        data-interactive
        aria-label={TOAST_COPY.dismiss}
        aria-describedby={wordsId}
        onClick={(e) => { e.stopPropagation(); dismiss(); }}
        className={cn(
          // 24px to the eye beside the words; the `after:` box makes it 44px to the finger without
          // growing the toast (the same trick as the `sm` / `icon-sm` buttons).
          "relative -my-0.5 -mr-[min(0.25rem,4px)] inline-flex size-[min(1.5rem,24px)] shrink-0 items-center justify-center rounded-md text-text-muted",
          "after:absolute after:-inset-[10px] after:content-[''] hover:bg-bg-muted hover:text-text-primary",
          // The surface clips (`overflow-hidden`, for the tone bar's corners): the ring goes inside.
          "focus-visible:-outline-offset-2",
        )}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
