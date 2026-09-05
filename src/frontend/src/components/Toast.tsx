import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

export type ToastTone = "info" | "success" | "danger" | "warning";

type ToastItem = {
  id: number;
  tone: ToastTone;
  text: string;
  /** ms before the toast auto-dismisses. Default 4000. Set 0 to keep until manually closed. */
  durationMs: number;
};

type ToastContextValue = {
  push: (input: { tone?: ToastTone; text: string; durationMs?: number }) => void;
};

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
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed left-1/2 top-[100px] z-[200] -translate-x-1/2 flex flex-col items-center gap-2 w-[min(92vw,420px)]"
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
        "transition-all duration-300 ease-out",
        tones[toast.tone],
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
      )}
    >
      {toast.text}
    </div>
  );
}
