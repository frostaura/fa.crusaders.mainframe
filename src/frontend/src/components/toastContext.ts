import { createContext, useContext } from "react";
import type { ToastTone } from "./Toast";

/** What `useToast` hands a call site. The provider and the viewport are in `Toast.tsx`. */
export type ToastContextValue = {
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

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
