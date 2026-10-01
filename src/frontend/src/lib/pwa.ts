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

/**
 * The offline shell's caches (any build's — the worker's own activate sweep retires an earlier
 * build's). Matches `public/sw.js`'s `SHELL_CACHE` / `ASSET_CACHE` names and its `KEEP_ON_END`.
 */
const SHELL_CACHE_PREFIXES = ["crusaders-shell-", "crusaders-assets-"];

/** A cache a session ending deletes: this app's, and not the shell. */
function droppedOnEnd(name: string): boolean {
  return name.startsWith(CACHE_PREFIX) && !SHELL_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The message the worker answers by deleting every cache of this app's that is not the shell. */
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
 * Empties the browser's cache storage of everything this app put there except the shell.
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
    await Promise.all(names.filter(droppedOnEnd).map((n) => caches.delete(n)));
  } catch {
    // A browser with CacheStorage disabled (private mode on some engines) throws on keys().
    // There is then nothing cached to clear, so there is nothing to do.
  }
}

/**
 * Drops every cache of this app's that is NOT the offline shell. Called on EVERY route by which a
 * session ends — the deliberate sign-out, an expiry, a revocation, an admin password reset, any
 * 401 — not only on the sign-out button.
 *
 * <p>
 * The worker caches no member data (see `public/sw.js` for why the API cache was removed), so
 * this is the second line rather than the first. It exists because a club-desk tablet is a
 * shared device and the next person to sign in must inherit nothing from the last one — and
 * because the first line has to be able to change without this one being forgotten. What it
 * deletes is everything the shell is not: the leaking worker's `crusaders-api-v1` on a device that
 * ran it, and any cache under the prefix nobody has decided is safe.
 * </p>
 *
 * <p>
 * <b>The shell and the build's assets stay (M5-1, review round 5).</b> They hold no member data —
 * the index.html every visitor gets and content-hashed code — and deleting them meant a phone
 * whose session lapsed could not open the app at all with no signal, My Code included, until it
 * found signal and reloaded: the lapse screen's "your code still works from this phone" was false
 * at the door. A member's kept reads live in IndexedDB and are wiped separately (`wipeMemberData`).
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
