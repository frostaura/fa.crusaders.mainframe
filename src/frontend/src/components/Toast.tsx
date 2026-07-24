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
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed left-1/2 top-[100px] z-50 -translate-x-1/2 flex flex-col items-center gap-2 w-[min(92vw,420px)]"
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

  return (
    <div
      role="status"
      onClick={() => { setVisible(false); window.setTimeout(() => onDismiss(toast.id), 250); }}
      className={cn(
        "pointer-events-auto cursor-pointer select-none",
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
