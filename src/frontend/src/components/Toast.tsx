import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

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

function ToastViewport({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  // `z-[200]`, above `Modal`'s `z-[100]` overlay and not below it. A toast raised while a
  // dialog was open painted UNDER the dialog's 30% black scrim, so the only explanation a
  // member got for a refusal read as greyed-out background chrome — and any dialog taller
  // than the toast's own strip hid it outright. Booking refusals no longer travel this way
  // at all (they render inside the dialog), but a toast raised over any other dialog has
  // the same problem and this is the layer that fixes it.
  //
  /**
   * <b>C10 — no `aria-live` here, because each toast already is one.</b>
   *
   * <p>
   * This container carried `aria-live="polite"` AND every toast inside it carries
   * `role="status"`, which is the same live region nested in itself. A screen reader
   * announced the download toast twice: once because a node was inserted into a live
   * region, and once because the node inserted was itself a live region. The rule is one
   * live ancestor, and the toast is the better place for it — it is the thing that arrives,
   * it is what carries the text, and it keeps announcing correctly if the viewport is ever
   * moved or split.
   * </p>
   */
  //
  /**
   * <b>R3-28 / B10 — it sits at the BOTTOM, because what it was covering was the answer.</b>
   *
   * <p>
   * It was anchored under the header (B13: measured rather than the `top-[100px]` guess that
   * covered the tab strip at a 32 px root font). Under the header is exactly where a page puts
   * the thing a toast most often contradicts: reviewer B failed a shut and watched "Could not
   * shut that door." land on top of the door's own status line, so the one sentence that could
   * have settled which of the two was true was the one hidden by the other.
   * </p>
   *
   * <p>
   * The bottom edge is the far side of the screen from every heading, chip and status line in
   * this product, and it is where a phone puts a message anyway. `env(safe-area-inset-bottom)`
   * keeps it clear of the home indicator on a notched phone — the viewport meta already carries
   * `viewport-fit=cover`, so without it the strip sits underneath the gesture bar.
   * </p>
   *
   * <p>
   * `--app-chrome-height` stays published by `Layout` — the route-heading scroll margin in
   * `index.css` reads it — it is simply no longer this strip's problem.
   * </p>
   */
  return (
    <div
      /*
       * A CLASS, not an inline style, and the reason is a test rather than a preference:
       * jsdom's CSS parser mangles `env()` in an inline declaration — it serialised this one
       * back as `calc(12px + env(0px * , * safe-area-i…` — so the one assertion that could
       * hold the anchoring would have been asserting about a string jsdom invented. Tailwind
       * emits the arbitrary value verbatim into the stylesheet, where the browser parses it.
       */
      className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom,0px)+12px)] left-1/2 z-[200] -translate-x-1/2 flex flex-col items-center gap-2 w-[min(92vw,420px)]"
    >
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

  const tones: Record<ToastTone, string> = {
    info: "bg-info-soft text-info-strong border-info-strong/20",
    success: "bg-success-soft text-success-strong border-success-strong/20",
    warning: "bg-warning-soft text-warning-strong border-warning-strong/20",
    danger: "bg-danger-soft text-danger-strong border-danger-strong/20",
  };

  const dismiss = () => { setVisible(false); window.setTimeout(() => onDismiss(toast.id), 250); };

  // A toast is dismissed by tapping it, and it used to be a plain div that said so with
  // nothing but `cursor-pointer`: no focus ring, no keyboard route to it at all, and none
  // of the hover treatment the rest of the product now shares. `data-interactive` is what
  // the base layer in index.css keys on for a surface that is not a <button> — and once a
  // thing can be pressed, it has to be pressable without a mouse. `role="status"` stays:
  // the toast still has to ANNOUNCE itself, which is a different job from being pressable.
  return (
    <div
      role="status"
      data-interactive
      tabIndex={0}
      aria-label={`${toast.text} — dismiss`}
      onClick={dismiss}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); dismiss(); } }}
      className={cn(
        "pointer-events-auto select-none",
        "rounded-lg border px-4 py-2.5 text-sm font-medium shadow-md w-full",
        // `duration-enter`, not `duration-300`. This was the one timing in the product that
        // lived nowhere but here — a third duration beside the theme's two, invisible to
        // anybody reading tailwind.config.ts and unreachable from TypeScript. The removal
        // timer below is `durationMs + 250`, which still clears the 220 ms this resolves to.
        "transition-all duration-enter ease-out",
        tones[toast.tone],
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
      )}
    >
      {toast.text}
      {/* R3-28 — the second fact, in the same breath as the first. "It did not work" leaves an
          admin looking at a status line they can no longer trust; "and nothing changed" is the
          sentence that lets them stop looking. Its own line rather than appended to the text,
          so a call site cannot half-say it. */}
      {toast.unchanged && <span className="mt-0.5 block font-normal">{NOTHING_CHANGED}</span>}
    </div>
  );
}
