import { Suspense, lazy, useSyncExternalStore, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { isQuietPath, momentOf } from "./celebrationRules";
import { useCelebrations } from "./useCelebrations";

/**
 * The moment itself — the dialog, its words and its medallion — loads only when there IS one
 * (perf lane, 2026-09-30): it pulled `playCopy` and the badge art into the entry chunk for every
 * member on every cold start. A chunk that cannot be fetched (offline) draws nothing rather than
 * breaking the shell; nothing is acknowledged, so the moment shows on a later visit.
 */
type MomentComponent = (props: Parameters<typeof import("./CelebrationMoment").CelebrationMoment>[0]) => ReactNode;
const drawNothing: MomentComponent = () => null;
const CelebrationMoment = lazy(() =>
  import("./CelebrationMoment").then(
    (m): { default: MomentComponent } => ({ default: m.CelebrationMoment }),
    (): { default: MomentComponent } => ({ default: drawNothing }),
  ));

/**
 * The one-shot moment (§9.3), mounted once in the app shell: a badge earned, a monthly goal
 * reached. One at a time, oldest first; more than three waiting collapse into one ("4 new
 * badges") that leads to My game.
 *
 * <p>
 * <b>Never over the pass.</b> Not on `/my-code` (the card at the court must never be covered),
 * not on an invite link or an auth page, and never while any other sheet, dialog or popover is
 * open — it waits for the next route or for the other surface to close. Acknowledged on either
 * button or the close ×, never on display alone.
 * </p>
 *
 * <p>
 * <b>Motion is CSS on the existing tokens</b> — the scrim's `overlay-in`, the medallion's
 * `pop-in`, one `breathe` glow, the ring's `stroke-dashoffset` over `count` — and every one of
 * them stands still under `prefers-reduced-motion`. The dialog's title is its accessible name,
 * so the moment is announced either way.
 * </p>
 */


/* ─────────────────────────────── is any other surface open? ─────────────────────────────── */

const SURFACE = '[role="dialog"]:not([data-celebration]), [role="alertdialog"]';

function subscribeSurfaces(listener: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => undefined;
  const observer = new MutationObserver(listener);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

function anotherSurfaceOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector(SURFACE) !== null;
}

/* ─────────────────────────────── the moment ─────────────────────────────── */

export function CelebrationOverlay() {
  const { pathname } = useLocation();
  const { items, acknowledge } = useCelebrations();
  const blocked = useSyncExternalStore(subscribeSurfaces, anotherSurfaceOpen, () => false);
  const moment = momentOf(items);
  const quiet = isQuietPath(pathname);
  // Held back, not dropped: the same moment shows on the next route, or once the sheet closes.
  const showing = moment !== null && !quiet && !blocked;
  if (!moment || !showing) return null;
  return (
    <Suspense fallback={null}>
      <CelebrationMoment moment={moment} acknowledge={acknowledge} />
    </Suspense>
  );
}
