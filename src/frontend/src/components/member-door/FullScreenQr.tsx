import { useEffect, useRef } from "react";
import { Button } from "../Button";

/**
 * The code, full-bleed, at the largest area the screen can give it.
 *
 * <p>
 * <b>Not `Modal`.</b> `Modal` is a bounded card over a scrim, and a scrim removes exactly
 * the white that makes a QR readable in a dark doorway. Every non-white pixel here is
 * light the scanner does not get, so there is no card, no border and no backdrop — just
 * the symbol, the twelve characters under it, and one way out.
 * </p>
 *
 * <p>
 * <b>The wake lock is optional and silent.</b> A phone that dims to ten per cent halfway
 * through a scan is a scan that fails, so the screen is held awake while this is open —
 * but the API is absent on most desktops and can be refused anywhere, and neither changes
 * anything a member sees. It is released on close, on unmount and when the page is
 * hidden.
 * </p>
 *
 * <p>
 * <b>What this deliberately does not do:</b> push a history entry so the hardware back
 * button closes it. A synthetic entry has to fight the router's own stack, and the way
 * that goes wrong is a member trapped on a page whose back button does nothing — which is
 * worse, for this member at this moment, than one extra tap on Done. Escape and a tap
 * anywhere both close it.
 * </p>
 */
export function FullScreenQr(props: { code: string; children: React.ReactNode; onClose: () => void }) {
  const { code, children, onClose } = props;
  const dialog = useRef<HTMLDivElement | null>(null);

  // The dialog itself takes focus, not the Done button: `Button` spreads
  // ButtonHTMLAttributes and a ref is not one of those, and landing a screen-reader user
  // on the labelled dialog is the better of the two anyway.
  useEffect(() => { dialog.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let sentinel: { release: () => Promise<void> } | null = null;
    let live = true;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } };
    try {
      nav.wakeLock?.request("screen")
        .then((lock) => { if (live) sentinel = lock; else void lock.release(); })
        .catch(() => { /* denied, or the page was not visible. Nothing visible changes. */ });
    } catch { /* no such API here */ }
    return () => {
      live = false;
      try { void sentinel?.release(); } catch { /* already gone */ }
    };
  }, []);

  return (
    <div
      ref={dialog}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Your code, full screen"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-white p-4"
      onClick={onClose}
    >
      {/* min(92vw, 92vh): the largest square that fits either way up, with a margin that
          keeps the quiet zone clear of the bezel on a phone held in one hand. */}
      <div className="w-[min(92vw,92vh)] h-[min(92vw,92vh)]" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
      <p className="font-mono text-xl tracking-[0.25em] text-black">{code}</p>
      <Button variant="outline" onClick={(e) => { e.stopPropagation(); onClose(); }}>Done</Button>
    </div>
  );
}
