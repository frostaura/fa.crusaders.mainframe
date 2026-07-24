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
  /** ms to keep the armed state before snapping back. Default 3000. */
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
  armedTimeoutMs = 3000,
  disabled = false,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const disarm = () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    setArmed(false);
  };

  useEffect(() => {
    // Only run idle-disarm bookkeeping when armed and NOT in flight.
    if (!armed || pending) return;
    timer.current = window.setTimeout(disarm, armedTimeoutMs);
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
        "disabled:cursor-not-allowed",
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
