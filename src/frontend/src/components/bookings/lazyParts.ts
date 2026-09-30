import { lazy, useEffect } from "react";

/**
 * Perf (R4, perf report Frontend 3) — the parts of Bookings most visits never open, out of the
 * page's own chunk: the cancel sheet (~25 KB) and the split step. Each is imported when it is
 * first needed, and fetched ahead at idle once the page has what it came for, so the first
 * tap on a booking does not wait on the network.
 */
export const loadCancelSheet = () => import("./CancelSheet");
export const loadSplitStep = () => import("./SplitStep");

export const LazyCancelSheet = lazy(() => loadCancelSheet().then((m) => ({ default: m.CancelSheet })));
export const LazySplitStep = lazy(() => loadSplitStep().then((m) => ({ default: m.SplitStep })));

/** Fetch `load` at idle once `ready` — after the page's own reads, never competing with them. */
export function usePrefetchWhen(ready: boolean, load: () => Promise<unknown>): void {
  useEffect(() => {
    if (!ready) return undefined;
    let idle: number | null = null;
    const run = () => { void load().catch(() => undefined); };
    if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(run, { timeout: 4_000 });
    else run();
    return () => { if (idle !== null && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle); };
  }, [ready, load]);
}
