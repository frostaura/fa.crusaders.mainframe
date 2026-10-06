import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui/button";

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
 * <b>It carries the code's own clock. D12.</b> A member holding this up to a scanner had no
 * way to tell a code about to rotate from a fresh one. The caller passes the sentence
 * ("New code in 12 seconds"); the overlay re-renders with the page, so the symbol under the
 * member's thumb is always the current step's.
 * </p>
 *
 * <p>
 * <b>D1 removed the dead state.</b> A booking or ident code fetched from the club could run out
 * with no signal to renew it, and this overlay had a whole arm for saying so. The single
 * rotating code is made on the phone from a key it holds, every thirty seconds, with or
 * without signal — there is no code on this screen that can die, so there is no arm for one.
 * </p>
 *
 * <p>
 * <b>The brightness line.</b> A phone on auto-brightness in a dark doorway can dim the white
 * this overlay exists to show. The page cannot set the brightness (no web API can), so it asks.
 * </p>
 */
/**
 * Everything in this column that is not the symbol, in `rem`, itemised.
 *
 * <p>
 * The square is bounded on BOTH axes in one expression — `min(100vw-1rem, 100vh-RESERVE)` —
 * because `min(92vw, 92vh)` in landscape is a square as tall as the whole viewport with a
 * code line and a button still to place under it. A `justify-center` column then overflows
 * at both ends: the symbol's top quiet zone goes off the top of the glass and Done goes off
 * the bottom.
 * </p>
 *
 * <p>
 * <b>It is itemised because a reserve written as one number is a number nobody knows to
 * change.</b> It was `6.5rem`, correct for a code line and a button; D12 then added the
 * countdown between them and the landscape symbol went back to −6px, with nothing in the
 * source connecting the new line to the old constant. Each part below names the class it
 * measures, so adding a line to this overlay means adding a row here — and the landscape
 * case in `e2e/my-code.spec.ts` fails until it is.
 * </p>
 */
const COLUMN_RESERVE = [
  0.5,  // `py-2` above the symbol
  0.5,  // `gap-2` under it
  1.75, // the code line, `text-lg` on a 1.75rem line box
  0.5,  // `gap-2`
  1.25, // the countdown and the brightness hint, `text-sm` on ONE 1.25rem line box where the
        // screen is short (landscape) — they share a wrapping row, so the line is only a
        // second one in portrait, where the square is bounded by the width and has height spare
  0.5,  // `gap-2`
  2.75, // Done, `min-h-11`
  0.5,  // `p-2` below it
].reduce((a, b) => a + b, 0);

/**
 * The square: as wide as the glass allows, as tall as what is left after {@link COLUMN_RESERVE}.
 *
 * <p>
 * An inline `style` rather than an arbitrary Tailwind class, and the reason is mechanical:
 * Tailwind generates CSS by scanning the source for literal class strings, so a class name
 * built from a template literal produces NO rule at all — silently, with the element left
 * unsized and the symbol collapsed. A value this overlay computes has to travel as a value.
 * </p>
 *
 * <p>
 * It travels as a CUSTOM PROPERTY that `width` and `height` then both read, for two
 * reasons. One length, declared once, cannot come apart into a rectangle. And a custom
 * property is stored verbatim by every CSS implementation, including jsdom's — which parses
 * `min()` with mixed units as invalid and silently drops it, so a plain `width: min(…)`
 * inline style reads back as the empty string in the unit tests and cannot be asserted on
 * at all. The property is declared on the same element that reads it, so there is no
 * inherited fallback to paint if it ever goes missing.
 * </p>
 */
/*
  <b>R3-36 (D-L2): the horizontal inset is gone, and the arithmetic below is why it is the
  only thing that could go.</b>

  Measured at 390×844 the dark modules came out 270px wide — sixty-nine per cent of the
  glass, under a sea of white — and "the largest area the screen can give it" was not what
  the overlay was doing. The 1rem was two of the missing pixels per side; the other 104 are
  the QR specification's four-module quiet zone, which `QrSvg` draws INSIDE the symbol.

  It stays. A version-1 symbol is 21 modules across and the quiet zone is 4 a side, so a box
  of width W renders modules of W/29 and exactly four modules of white around them — which
  is the largest the symbol can be while the white beside it is still a quiet zone. Taking
  the zone out to draw a bigger picture buys 38% of module size and spends the margin a
  scanner in a dark doorway reads the finder patterns against, on the one screen in this
  product whose whole job is to be scanned. So the inset goes, the quiet zone does not, and
  the honest gain is 374px of box to 390.

  The vertical `p-2` stays and is still in {@link COLUMN_RESERVE}: there the square is not
  the binding constraint in portrait at all, and the padding is what keeps Done off the
  bottom bezel in landscape.
*/
const SQUARE = `min(100vw, 100vh - ${COLUMN_RESERVE}rem)`;

/** The square as a style object: declared once, read twice. See {@link SQUARE}. */
const SQUARE_BOX = { "--fsq-square": SQUARE, width: "var(--fsq-square)" } as React.CSSProperties;
const SQUARE_BOTH = { ...SQUARE_BOX, height: "var(--fsq-square)" } as React.CSSProperties;

export function FullScreenQr(props: {
  /** The whole code, unbroken — what the scanner reads and what the caption spells. */
  code: string;
  /** The code as the member reads it (grouped); defaults to {@link code}. */
  codeText?: ReactNode;
  children: ReactNode;
  /** The one clock a member at a scanner can see — "New code in 12 seconds". D12. */
  countdown: string;
  /** Under the countdown: ask for a brighter screen. */
  hint?: string;
  onClose: () => void;
}) {
  const { code, codeText, children, countdown, hint, onClose } = props;
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

  /**
   * Escape closes it, and Tab cannot leave it. C9 / D14.
   *
   * <p>
   * <b>`aria-modal="true"` was a claim this overlay did not honour.</b> Tab walked straight
   * out of it and through the page underneath — the header, the tab strip, every link on
   * the code page — while a screen reader went on announcing a dialog. For a keyboard or
   * screen-reader user that is worse than no dialog semantics at all: the promise is what
   * stops them looking for the way out.
   * </p>
   *
   * <p>
   * The trap is a keydown handler rather than a focus-sentinel pair because this overlay has
   * at most three focusable things in it and a wrapping cycle over them is exactly what a
   * member expects. Back still closes only the overlay — that is the popstate effect above,
   * and nothing here touches it.
   * </p>
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { dismiss(); return; }
      if (e.key !== "Tab") return;
      const root = dialog.current;
      if (!root) return;
      const stops = [...root.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), [tabindex]")]
        .filter((el) => el.tabIndex >= 0 && el !== root);
      // Nothing to move between: the dialog itself keeps focus rather than handing it to
      // the page it is covering.
      if (stops.length === 0) { e.preventDefault(); root.focus(); return; }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!e.shiftKey && active === root) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismiss]);

  /**
   * The page behind it is `inert`, and the background does not scroll. C9 / D14.
   *
   * <p>
   * `inert` is what makes the claim true for every input method at once — pointer, caret
   * browsing, screen-reader virtual cursor, and the find-in-page a Tab trap does not reach.
   * The scroll lock is the pointer half of the same finding: dragging on the overlay moved
   * the page underneath it, so a member closed the code and found themselves somewhere else
   * on the page than where they left.
   * </p>
   *
   * <p>
   * Both are restored to what they were rather than to a default. Another overlay may own
   * them, and clearing somebody else's lock on the way out is how a page ends up permanently
   * unscrollable.
   * </p>
   */
  useEffect(() => {
    const self = dialog.current;
    // Every SIBLING of this overlay, rather than `#root` by name. The portal renders into
    // `document.body`, so the app's mount point is one of these — and naming it `#root`
    // ties a correctness property to an id that exists in `index.html` and in no test
    // harness, which is a guard that quietly does nothing wherever it is not production.
    const behind = [...document.body.children].filter((node) => node !== self);
    const was = behind.map((node) => node.hasAttribute("inert"));
    for (const node of behind) node.setAttribute("inert", "");
    const body = document.body;
    const wasOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      // Restored to what each one WAS, not to a default: another overlay may own an inert
      // sibling, and clearing somebody else's is how a page ends up permanently unusable.
      behind.forEach((node, i) => { if (!was[i]) node.removeAttribute("inert"); });
      body.style.overflow = wasOverflow;
    };
  }, []);

  /**
   * Screen Wake Lock while the code is up — feature-detected, and silent either way.
   *
   * <p>
   * <b>Re-requested whenever the page comes back into view.</b> A browser releases a screen lock
   * the moment the page is hidden — a notification pulled down, a glance at another app — and does
   * not give it back. Without asking again, the second time a member held this up at a door the
   * phone dimmed halfway through the scan.
   * </p>
   */
  useEffect(() => {
    let sentinel: { release: () => Promise<void> } | null = null;
    let live = true;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } };
    const acquire = () => {
      if (!live || document.visibilityState === "hidden") return;
      try {
        nav.wakeLock?.request("screen")
          .then((lock) => { if (live) sentinel = lock; else void lock.release(); })
          .catch(() => { /* denied, or the page was not visible. Nothing visible changes. */ });
      } catch { /* no such API here */ }
    };
    const onVisibility = () => { if (document.visibilityState === "visible") acquire(); };
    acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisibility);
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
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-2 bg-white py-2"
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

        `rem` rather than a pixel count: what is being reserved is the code line plus the
        countdown plus the button plus the gaps, and every one of those scales with the root
        font — which is the whole of why this page broke at 32px in the first place. The
        parts are enumerated in {@link COLUMN_RESERVE}, because a reserve written as one
        number is a number the next person to add a line does not know to change: that is
        precisely what happened when D12's countdown arrived under a `6.5rem` that predated
        it, and the symbol's top quiet zone went back off the glass in landscape.
      */}
      <div
        style={SQUARE_BOTH}
        /*
          It may SHRINK, and that is the safety valve rather than the design. The reserve
          above is exact for the column as it stands, but a code that wraps to two lines at
          a large root font, or a button a shared component grows by a pixel, would put the
          symbol back off the top of the glass. `min-h-0` lets flex take the difference out
          of the square instead; the SVG's own `preserveAspectRatio` keeps the symbol square
          and centred inside whatever box is left, so it degrades to smaller rather than to
          clipped.
        */
        className="min-h-0"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
      {/* `break-all`: nineteen monospaced characters are wider than a 360px phone once the
          root font is turned up, and a code that runs off the edge is a code nobody can read
          back to the desk. The groups are spans with no spaces between them, so the text is the
          unbroken code for a screen reader and for copy and paste alike. */}
      <p className="sr-only">
        {codeText ?? code}
      </p>
      {/* D12. The one clock a member holding this against a scanner can see. Black on white
          like everything else here — a muted grey is light the scanner does not get back. */}
      <p className="flex max-w-full shrink-0 flex-wrap justify-center gap-x-3 px-4 text-center text-sm text-black">
        <span>{countdown}</span>
        {hint ? <span>{hint}</span> : null}
      </p>
      <Button variant="outline" className="shrink-0" onClick={(e) => { e.stopPropagation(); dismiss(); }}>
        Done
      </Button>
    </div>,
    document.body,
  );
}
