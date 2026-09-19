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
 */
export function FullScreenQr(props: { code: string; children: React.ReactNode; onClose: () => void }) {
  const { code, children, onClose } = props;
  const dialog = useRef<HTMLDivElement | null>(null);
  /** Our own history entry's marker while it is the current one. See the effect below. */
  const entry = useRef<number | null>(null);
  /**
   * `onClose` as the popstate listener sees it, so the listener is registered once.
   *
   * <p>
   * Kept current in an effect rather than assigned during render. A ref written in a
   * render body is torn by a render React throws away — concurrent rendering does that
   * routinely — and the lint rule that says so is right: the value that would survive is
   * from a tree nobody mounted.
   * </p>
   */
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);

  // The dialog itself takes focus, not the Done button: `Button` spreads
  // ButtonHTMLAttributes and a ref is not one of those, and landing a screen-reader user
  // on the labelled dialog is the better of the two anyway.
  useEffect(() => { dialog.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * The hardware back button closes this rather than leaving the page.
   *
   * <p>
   * <b>It deliberately did not, and the reasoning was sound and wrong.</b> The argument
   * against was that a synthetic entry has to fight the router's own stack and the way
   * that goes wrong is a member trapped on a page whose back button does nothing. The
   * argument for is simply what people do: back IS the close gesture on a phone, and a
   * member holding a full-screen QR at a door pressed it and landed on the schedule,
   * which is strictly worse than either failure mode being guarded against.
   * </p>
   *
   * <p>
   * <b>Three things make it safe beside react-router.</b> The entry is pushed at the SAME
   * url, so the router sees a location it already has and re-renders nothing; the
   * router's own state is spread through, so its `idx` bookkeeping survives the round
   * trip; and the entry carries a marker that is checked before {@link History.back} is
   * ever called on the way out. If the member navigated onward — a link on the card
   * behind, a tab — our entry is buried, the marker no longer matches the current state,
   * and the cleanup does nothing at all rather than stealing a step of somebody's
   * history.
   * </p>
   */
  useEffect(() => {
    const marker = Date.now();
    const previous = (window.history.state ?? {}) as Record<string, unknown>;
    try {
      window.history.pushState({ ...previous, fullScreenQr: marker }, "", window.location.href);
      entry.current = marker;
    } catch {
      // A browser that refuses pushState (a sandboxed frame, a file: url) simply does not
      // get the gesture. Nothing else on this overlay depends on it.
      entry.current = null;
    }

    const onPop = () => {
      // The pop consumed our entry, so there is nothing left to unwind on the way out.
      entry.current = null;
      close.current();
    };
    window.addEventListener("popstate", onPop);

    return () => {
      window.removeEventListener("popstate", onPop);
      const state = (window.history.state ?? {}) as Record<string, unknown>;
      if (entry.current !== null && state.fullScreenQr === entry.current) {
        entry.current = null;
        window.history.back();
      }
    };
  }, []);

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
      /*
        `z-[60]`, not `z-50`: the app header is a sticky `z-30` in its own right and this
        overlay was showing it through along its top edge in landscape. It is also
        `bg-white` with no alpha anywhere in the chain, because a scrim is light the
        scanner does not get.
      */
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-2 bg-white p-2"
      onClick={onClose}
    >
      {/*
        <b>The square is bounded on BOTH axes, in one expression, and that is the fix.</b>
        It was `min(92vw, 92vh)`, which in landscape is a square as tall as the viewport
        with a code line and a Done button still to place under it — so the column
        overflowed at both ends of a `justify-center` flex, the symbol's top quiet zone was
        clipped off the screen and Done was below the fold, a 22px sliver of a 44px
        control. Reserving the rest of the column here is what keeps every part of this
        overlay on the glass.

        `6.5rem` rather than a pixel count: what is being reserved is the code line plus
        the button plus the gaps, and every one of those scales with the root font — which
        is the whole of why this page broke at 32px in the first place.
      */}
      <div
        className="w-[min(100vw-1rem,100vh-6.5rem)] h-[min(100vw-1rem,100vh-6.5rem)] shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
      {/* `break-all`: twelve monospaced characters at 0.25em tracking are wider than a
          360px phone once the root font is turned up, and a code that runs off the edge is
          a code nobody can read back to the desk. */}
      <p className="max-w-full break-all text-center font-mono text-lg tracking-[0.25em] text-black">{code}</p>
      <Button variant="outline" className="shrink-0 min-h-11" onClick={(e) => { e.stopPropagation(); onClose(); }}>
        Done
      </Button>
    </div>
  );
}
