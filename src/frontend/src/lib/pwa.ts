/**
 * The app's half of the service worker.
 *
 * <p>
 * Registration is deliberately production-only. A service worker in front of the Vite dev
 * server serves a stale module graph after every edit, and the failure looks exactly like a
 * broken build — which is the reason a great many teams end up disabling PWA support entirely
 * rather than debugging it once.
 * </p>
 */

/** Where the worker lives. Root-scoped, because it has to see navigations to every route. */
const SW_URL = "/sw.js";

/** Matches `public/sw.js`. Every cache the worker has ever owned carries this prefix. */
const CACHE_PREFIX = "crusaders-";

/** The message the worker answers by emptying everything it holds. */
export const CLEAR_CACHES = "CLEAR_CACHES";

export function isServiceWorkerSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

/**
 * Registers the offline shell. Safe to call anywhere: it is a no-op without support, and a
 * failed registration is logged rather than thrown — an app that will not start because it
 * could not set up offline support has made things worse, not better.
 */
export function registerServiceWorker(): void {
  if (!isServiceWorkerSupported()) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(SW_URL).catch((err) => {
      console.warn("Offline support is unavailable:", err);
    });
  });
}

/**
 * Empties the browser's cache storage of everything this app put there.
 *
 * <p>
 * Done from the page rather than only by messaging the worker, because the message has a hole
 * in it: `navigator.serviceWorker.controller` is null on the load that installed the worker,
 * after a hard reload, and whenever the worker has been terminated for idleness. On exactly
 * those loads the message goes nowhere and reports success. The page shares the origin's
 * CacheStorage with the worker, so deleting from here always works.
 * </p>
 */
async function purgeCacheStorage(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX)).map((n) => caches.delete(n)));
  } catch {
    // A browser with CacheStorage disabled (private mode on some engines) throws on keys().
    // There is then nothing cached to clear, so there is nothing to do.
  }
}

/**
 * Drops everything the offline shell holds. Called on EVERY route by which a session ends —
 * the deliberate sign-out, an expiry, a revocation, an admin password reset, any 401 — not
 * only on the sign-out button.
 *
 * <p>
 * The worker caches no member data (see `public/sw.js` for why the API cache was removed), so
 * this is the second line rather than the first. It exists because a club-desk tablet is a
 * shared device and the next person to sign in must inherit nothing from the last one — and
 * because the first line has to be able to change without this one being forgotten.
 * </p>
 */
export async function clearOfflineCache(): Promise<void> {
  await purgeCacheStorage();
  if (!isServiceWorkerSupported()) return;
  try {
    // Also tell the worker, so anything it has in flight is dropped rather than written back
    // in behind the purge above.
    navigator.serviceWorker.controller?.postMessage({ type: CLEAR_CACHES });
  } catch {
    // A worker that cannot be messaged has nothing this page cannot delete itself.
  }
}
