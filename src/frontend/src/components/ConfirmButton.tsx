import { useEffect, useRef, useState } from "react";
import { Fingerprint, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";

type ConfirmButtonProps = {
  idleLabel: React.ReactNode;
  confirmLabel?: React.ReactNode;
  /** May return a Promise — the button stays armed with a spinner until it resolves. */
  onConfirm: () => void | Promise<void>;
  className?: string;
  /** Idle (resting) variant. Defaults to "info" — soft blue. */
  idleClassName?: string;
  /** Armed (confirm) variant. Defaults to a warm orange alert. */
  armedClassName?: string;
  /**
   * ms to keep the armed state before snapping back. **Off by default.**
   *
   * It used to default to 3000, and that silently broke the one control it most
   * needed to get right. A member who took longer than three seconds to read
   * "Reserve for 50.00 cr?" tapped a button that had already gone back to idle,
   * so the second tap re-armed instead of confirming — a slow reader could tap
   * for ever and never book anything, with no request leaving the browser and
   * nothing on screen to explain it. A confirmation exists to be read; a
   * confirmation with a stopwatch on it punishes the people who read it.
   *
   * Clicking elsewhere and pressing Escape still disarm, which is what actually
   * addresses the concern the timer was reaching for — an armed control left on
   * screen for the next person to touch.
   */
  armedTimeoutMs?: number;
  disabled?: boolean;
};

export function ConfirmButton({
  idleLabel,
  confirmLabel = "Tap to confirm",
  onConfirm,
  className,
  idleClassName = "bg-info-soft text-info-strong hover:bg-info-soft/80",
  armedClassName = "bg-[#F97316] text-white",
  armedTimeoutMs = 0,
  disabled = false,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);
  // Set on mount as well as cleared on unmount. Without the assignment this effect
  // only ever wrote `false`, and React's development double-invoke runs
  // mount → cleanup → mount — so `mounted.current` was false from the first render
  // onwards and the `finally` below never cleared `pending`. The button stuck on
  // "Working…" for ever after one successful action, in dev, on every screen that
  // uses it. It reads as a hung request and is not one.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const disarm = () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    setArmed(false);
  };

  useEffect(() => {
    // Only run idle-disarm bookkeeping when armed and NOT in flight.
    if (!armed || pending) return;
    // A timeout only when a caller asked for one. See armedTimeoutMs above.
    if (armedTimeoutMs > 0) timer.current = window.setTimeout(disarm, armedTimeoutMs);
    const onDocPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) disarm();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") disarm(); };
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [armed, pending, armedTimeoutMs]);

  const handleClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (disabled || pending) return;
    if (!armed) { setArmed(true); return; }
    // Stop the auto-disarm timer immediately and switch to pending visual.
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    setPending(true);
    try {
      await Promise.resolve(onConfirm());
    } finally {
      if (mounted.current) {
        setPending(false);
        setArmed(false);
      }
    }
  };

  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || pending}
      aria-pressed={armed}
      aria-busy={pending}
      onClick={handleClick}
      className={cn(
        "relative overflow-hidden rounded-md text-xs font-medium transition-colors duration-200 ease-out",
        // The lift, the cursor and the focus ring come from the base layer in index.css;
        // this control keeps only its own colour transition. `no-lift` because a grid
        // cell that rises would shift the cells packed against it.
        "no-lift",
        // While pending we keep the armed visual instead of greying out via the disabled style.
        (armed || pending) ? armedClassName : idleClassName,
        pending && "cursor-wait",
        className,
      )}
    >
      <Fingerprint
        aria-hidden
        className={cn(
          "pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 transition-opacity duration-200",
          (armed || pending) ? "opacity-30 text-white" : "opacity-15",
          pending && "opacity-0",
        )}
        size={28}
        strokeWidth={1.5}
      />
      {/* Width sentinel: stack both labels in the same grid cell so the button sizes
          to max(idleLabel, confirmLabel) intrinsic width, regardless of node type. */}
      <span aria-hidden className="invisible whitespace-nowrap px-3 py-2 grid">
        <span className="col-start-1 row-start-1 flex items-center justify-center gap-2">{idleLabel}</span>
        <span className="col-start-1 row-start-1 flex items-center justify-center gap-2">{confirmLabel}</span>
      </span>
      <span
        // Hidden from assistive tech whenever it is not the label on show.
        //
        // The sibling spans already do this and this one did not, so the button's
        // accessible name was every copy of the label concatenated — a screen-reader
        // user heard "Revoke Really revoke?" on a control whose entire purpose is to
        // say ONE of those two things at a time. Found by a test asserting the name.
        aria-hidden={armed || pending}
        className={cn(
          "absolute inset-0 flex items-center justify-center px-3 transition-transform duration-200 ease-out",
          (armed || pending) ? "-translate-y-full opacity-0" : "translate-y-0 opacity-100",
        )}
      >
        {idleLabel}
      </span>
      <span
        aria-hidden={!armed || pending}
        className={cn(
          "absolute inset-0 flex items-center justify-center px-3 transition-transform duration-200 ease-out",
          armed && !pending ? "translate-y-0 opacity-100" : "translate-y-full opacity-0",
        )}
      >
        {confirmLabel}
      </span>
      <span
        aria-hidden={!pending}
        className={cn(
          "absolute inset-0 flex items-center justify-center gap-2 px-3 transition-opacity duration-200",
          pending ? "opacity-100" : "opacity-0",
        )}
      >
        <Loader2 className="animate-spin" size={16} strokeWidth={2.5} />
        <span>Working…</span>
      </span>
    </button>
  );
}
