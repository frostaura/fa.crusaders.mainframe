/**
 * Perf lane (2026-09-30) — the opened page's code is fetched BESIDE the session check, but after
 * it is sent: queued first, ~30 chunk files held `whoami` behind them for a second on a phone's six
 * connections. `main.tsx` registers the page's preload here; the bootstrap probe fires it once its
 * request is out (at most once per page load).
 */
let afterSessionCheck: (() => void) | null = null;
export function whenSessionCheckSent(run: () => void) {
  afterSessionCheck = run;
}
export function sessionCheckSent() {
  const run = afterSessionCheck;
  afterSessionCheck = null;
  run?.();
}
