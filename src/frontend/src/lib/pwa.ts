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
 * Drops the member's cached reads.
 *
 * <p>
 * Called on sign-out. The cached schedule, wallet and profile are a member's own data on their
 * own device, and a club phone is a shared device: the next person to sign in must not find the
 * previous member's balance sitting in a cache. Nothing here is a security boundary — the
 * server authorises every request regardless — it is the difference between a shared phone
 * being tidy and being embarrassing.
 * </p>
 */
export function clearOfflineCache(): void {
  if (!isServiceWorkerSupported()) return;
  navigator.serviceWorker.controller?.postMessage({ type: "CLEAR_API_CACHE" });
}
