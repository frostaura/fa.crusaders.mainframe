import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { CheckCircle, Info, Warning, WarningCircle, type Icon } from "./ui/icons";

export type ToastTone = "info" | "success" | "danger" | "warning";

type ToastItem = {
  id: number;
  tone: ToastTone;
  text: string;
  /** ms before the toast auto-dismisses. Default 4000. Set 0 to keep until manually closed. */
  durationMs: number;
  /** Whether this failure left the world exactly as it was. See {@link NOTHING_CHANGED}. */
  unchanged: boolean;
};

type ToastContextValue = {
  push: (input: {
    tone?: ToastTone;
    text: string;
    durationMs?: number;
    /**
     * Say, in the same breath, that nothing happened. (R3-28 / B10)
     *
     * <p>
     * A failure toast tells an admin that something did not work. It does not tell them
     * whether the door is now shut, half-shut, or exactly as it was — and that is the only
     * question they have. Reviewer B watched a failed shut produce "Could not shut that door."
     * over a status line still reading the old state, with nothing anywhere saying which of
     * the two to believe.
     * </p>
     *
     * <p>
     * Deliberately opt-IN and never inferred from the tone. "It failed" and "nothing changed"
     * are different facts: a request that timed out after the server committed it failed and
     * changed everything. Only a call site that knows the write did not land may say so.
     * </p>
     */
    unchanged?: boolean;
  }) => void;
};

/**
 * The sentence, in one place, because it is a claim about the world and not a wording.
 *
 * Exported so a call site can assert on it, and so the four doors call sites and the two
 * device ones cannot each invent their own near-miss of it.
 */
export const NOTHING_CHANGED = "Nothing changed.";

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback<ToastContextValue["push"]>((input) => {
    const id = ++idRef.current;
    const item: ToastItem = {
      id,
      tone: input.tone ?? "info",
      text: input.text,
      durationMs: input.durationMs ?? 4000,
      unchanged: input.unchanged ?? false,
    };
    setToasts((t) => [...t, item]);
  }, []);


  return (
    <ToastContext.Provider value={{ push }}>
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
 * status lines a failure toast most often contradicts (R3-28 / B10).
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
  "pointer-events-none fixed inset-x-4 z-toast mx-auto flex max-w-md flex-col items-stretch gap-2",
  "bottom-[calc(max(var(--app-bottom-bar-height,0px),env(safe-area-inset-bottom,0px))+12px)]",
  "sm:bottom-auto sm:left-auto sm:right-6 sm:top-[calc(var(--app-chrome-height,4rem)+12px)] sm:mx-0 sm:w-96",
);

function ToastViewport({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  /**
   * <b>`z-toast`, above every dialog and popover</b> (z-index scale: modal 50, popover 60,
   * toast 70). A toast raised while a dialog was open once painted UNDER the scrim, so the only
   * explanation a member got for a refusal read as greyed-out background chrome.
   *
   * <p>
   * <b>C10 — no `aria-live` here, because each toast already is one.</b> This container once
   * carried `aria-live="polite"` AND every toast inside it `role="status"` — the same live region
   * nested in itself — and a screen reader announced the download toast twice. One live
   * ancestor per toast, and the toast is the better place for it: it is the thing that arrives,
   * and it keeps announcing correctly wherever the viewport is moved.
   * </p>
   */
  return (
    <div data-toast-viewport className={TOAST_VIEWPORT_CLASS}>
      {toasts.map((t) => (
        <ToastView key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Mount → animate in next frame.
    const enter = window.requestAnimationFrame(() => setVisible(true));
    let exitTimer: number | undefined;
    let removeTimer: number | undefined;
    if (toast.durationMs > 0) {
      exitTimer = window.setTimeout(() => setVisible(false), toast.durationMs);
      removeTimer = window.setTimeout(() => onDismiss(toast.id), toast.durationMs + 250);
    }
    return () => {
      window.cancelAnimationFrame(enter);
      if (exitTimer) window.clearTimeout(exitTimer);
      if (removeTimer) window.clearTimeout(removeTimer);
    };
  }, [toast.id, toast.durationMs, onDismiss]);

  const dismiss = () => { setVisible(false); window.setTimeout(() => onDismiss(toast.id), 250); };
  const Mark = TONE_ICON[toast.tone];

  // Dismissed by tapping it, so it is pressable without a mouse too: `tabIndex={0}`, Enter and
  // Space, and `data-interactive` for the shared affordance layer in index.css. `role="status"`
  // stays — announcing itself is a different job from being pressable.
  return (
    <div
      role="status"
      data-interactive
      data-tone={toast.tone}
      tabIndex={0}
      aria-label={`${toast.text} — dismiss`}
      onClick={dismiss}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); dismiss(); } }}
      className={cn(
        "pointer-events-auto relative flex w-full select-none items-start gap-3 overflow-hidden",
        "rounded-xl border border-border bg-bg-raised py-3 pl-5 pr-4 text-sm text-text-primary shadow-lg",
        // `duration-enter` — the timing lives in the token layer; the removal timer below is
        // `durationMs + 250`, which clears the 220ms this resolves to.
        "transition-all duration-enter ease-out motion-reduce:transition-none",
        visible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
      )}
    >
      <span aria-hidden="true" data-toast-bar className={cn("absolute inset-y-0 left-0 w-1", TONE_BAR[toast.tone])} />
      <Mark size={20} aria-hidden="true" className={cn("shrink-0", TONE_INK[toast.tone])} />
      <span className="min-w-0 flex-1 break-words font-medium">
        {toast.text}
        {/* R3-28 — the second fact, in the same breath as the first. "It did not work" leaves an
            admin looking at a status line they can no longer trust; "and nothing changed" is the
            sentence that lets them stop looking. Its own line, so a call site cannot half-say it. */}
        {toast.unchanged && <span className="mt-0.5 block font-normal text-text-secondary">{NOTHING_CHANGED}</span>}
      </span>
    </div>
  );
}
