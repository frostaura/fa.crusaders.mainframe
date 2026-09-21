import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
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
   * <b>What makes it safe beside react-router.</b> The entry is pushed at the SAME url, so
   * the router sees a location it already has and re-renders nothing, and the router's own
   * state is spread through so its `idx` bookkeeping survives the round trip. The entry
   * carries a marker, and every path that could unwind it checks that marker first: if the
   * member navigated onward with this open, the entry is buried, the marker no longer
   * matches, and nothing is unwound rather than a step of somebody's history being stolen.
   * </p>
   */
  useEffect(() => {
    // ONE entry per opening, however many times this effect runs.
    //
    // React mounts, unmounts and remounts every effect once in development, and a push
    // per invocation leaves two entries behind one overlay: the member closes the code,
    // presses back expecting to leave the page, and stays on it. The ref survives the
    // phantom remount — which is precisely what makes it the right place to record that
    // the entry already exists — and a genuine reopen is a new component with fresh refs.
    if (entry.current === null) {
      const marker = Date.now();
      const previous = (window.history.state ?? {}) as Record<string, unknown>;
      try {
        window.history.pushState({ ...previous, fullScreenQr: marker }, "", window.location.href);
        entry.current = marker;
      } catch {
        // A browser that refuses pushState (a sandboxed frame, a file: url) simply does
        // not get the gesture. Nothing else on this overlay depends on it.
        entry.current = null;
      }
    }

    const onPop = () => {
      // The pop consumed our entry, so there is nothing left to unwind afterwards.
      entry.current = null;
      close.current();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /**
   * Closing by tap, by Escape, or by Done — and the unwind that belongs HERE and not in
   * the effect's cleanup.
   *
   * <p>
   * <b>It was in the cleanup, and that was a bug a browser found in two seconds.</b> React
   * mounts, unmounts and remounts every effect once in development, and the cleanup's
   * `history.back()` fired on that phantom unmount: the overlay pushed its entry, popped
   * it again and closed itself before a finger left the glass. A cleanup cannot tell a
   * remount from a real close, so it must not be where a side effect that means "the
   * member is finished with this" lives.
   * </p>
   *
   * <p>
   * So closing is one function with one decision. If our entry is still the current one,
   * go back — the popstate handler above is what then calls `onClose`, which keeps both
   * routes to closed on a single path. If it is not ours any more, the member has
   * navigated and there is nothing to unwind, so close directly.
   * </p>
   */
  const dismiss = useCallback(() => {
    const state = (window.history.state ?? {}) as Record<string, unknown>;
    if (entry.current !== null && state.fullScreenQr === entry.current) {
      entry.current = null;
      window.history.back();
      return;
    }
    close.current();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismiss]);

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

  /**
   * <b>Rendered into `document.body`, not where it sits in the tree.</b>
   *
   * <p>
   * `position: fixed` is supposed to resolve against the viewport, and inside the app's
   * shell it did not: measured in a real browser at 360×780, this overlay came out at
   * y=24 with a height of 756 while a bare `position:fixed;inset:0` div appended to the
   * body in the same document measured 0×780. Something between the page column and the
   * body — the scrolling `<main>`, most likely — is giving fixed descendants a containing
   * block of their own, and the twenty-four pixels it costs are the top of the app header
   * showing through the top of a code somebody is holding at a door.
   * </p>
   *
   * <p>
   * A portal is the fix rather than a larger z-index, because the problem is the
   * containing block and not the paint order: no z-index reaches outside a stacking
   * context it is trapped in. It also makes the overlay independent of whatever the page
   * column does next, which for a control whose whole job is to cover everything is the
   * right relationship.
   * </p>
   */
  return createPortal(
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
      onClick={dismiss}
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
      <Button variant="outline" className="shrink-0 min-h-11" onClick={(e) => { e.stopPropagation(); dismiss(); }}>
        Done
      </Button>
    </div>,
    document.body,
  );
}
