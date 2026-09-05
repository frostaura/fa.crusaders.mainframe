/*
 * The offline shell — static assets only, never member data.
 *
 * docs/specs/feature-spec.md §12 asks for two things: installable on a home screen, and
 * offline read-only use. The manifest and the icons buy the first. This buys as much of the
 * second as can be bought SAFELY, which is less than the spec originally promised, and §12 has
 * been corrected to say so.
 *
 * WHY THIS WORKER CACHES NO API RESPONSE, EVER
 * --------------------------------------------
 * The previous version of this file (v1) cached /api/v1/wallet, /api/v1/me/profile and
 * /api/v1/whoami stale-while-revalidate. That was a privacy leak, not a performance feature,
 * and the mechanism is worth writing down so nobody re-adds it:
 *
 *   - The Cache API keys entries on the request URL. It does NOT vary on the Authorization
 *     header. Two members signing in on the same browser profile issue byte-identical GETs to
 *     /api/v1/wallet, so `cache.match(request)` hands the second member the first member's
 *     stored response.
 *   - CacheStorage is scoped to the ORIGIN, not to a login. One club-desk tablet, one browser
 *     profile, every member who has ever used it.
 *   - Stale-while-revalidate returns the cached copy FIRST. So member B's first paint of the
 *     wallet was member A's balance and ledger, and a cached /whoami could boot the app under
 *     member A's identity and is_admin flag until the revalidation landed.
 *   - The only thing that cleared it was the deliberate Sign-out button. The ways a session
 *     actually ends on a shared device — the member walks away, the token expires, an admin
 *     revokes it — cleared nothing.
 *
 * The alternative considered and rejected was keying the cache per session (a cache name
 * derived from the token's subject, evicting every other session's cache on first sight of a
 * new one). It works on paper. It was rejected because it is unobservable machinery guarding a
 * privacy boundary in a money system: it cannot be exercised in this repo's automation (the
 * headless Chromium here refuses to register a worker at all), and a subtle bug in it looks
 * exactly like a working cache. Not caching member data has no failure mode.
 *
 * WHAT IS CACHED
 * --------------
 *   1. Hashed build assets (/assets/*) — immutable by construction, Vite puts the content hash
 *      in the filename — cache-first, with the activate sweep removing what a new build no
 *      longer names.
 *   2. Navigations — network-first with the cached shell as the fallback. Network-first because
 *      a stale index.html pointing at deleted asset hashes is a white screen, and a white
 *      screen is worse than a slow one.
 *   3. The shell files and icons named below.
 *
 * Everything under /api/ goes straight to the network, is never intercepted and is never
 * stored. Writes fail loudly when there is no signal, which is correct: a booking queued
 * offline that lands minutes later against a slot somebody else has taken is a money bug
 * wearing an offline-support costume.
 *
 * Every cache write goes through `mayCache()` — one chokepoint, so a future edit that adds a
 * caching path cannot accidentally route around the rule.
 */

const VERSION = "v2";
const SHELL_CACHE = `crusaders-shell-${VERSION}`;
const ASSET_CACHE = `crusaders-assets-${VERSION}`;
const OWNED = [SHELL_CACHE, ASSET_CACHE];

/**
 * Every cache this worker has ever owned starts with this prefix, including `crusaders-api-v1`
 * from the leaking version. The activate sweep below is what removes that one from devices the
 * old worker already ran on — the version bump is load-bearing, not cosmetic.
 */
const CACHE_PREFIX = "crusaders-";

/** The shell itself. Asset filenames are hashed at build time, so they are cached on first use. */
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png"];

/**
 * The single decision about whether anything may be stored.
 *
 * A request under /api/, or one carrying an Authorization header, is a member's own data and
 * is never cached — the header check is belt-and-braces behind the path check, so that a
 * credentialed request to some future non-/api/ path is refused too.
 */
function mayCache(request, response) {
  if (!request || request.method !== "GET") return false;
  // Author-set headers are visible to the worker; Authorization is not a forbidden header name.
  if (request.headers && request.headers.get("authorization")) return false;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;

  if (!response || !response.ok) return false;
  // An opaque cross-origin response has an unreadable body and an unknowable status.
  if (response.type === "opaque" || response.type === "opaqueredirect") return false;

  const headers = response.headers;
  if (headers) {
    const control = headers.get("cache-control") || "";
    if (/no-store|private/i.test(control)) return false;
    const vary = (headers.get("vary") || "").toLowerCase();
    if (vary.includes("authorization") || vary === "*") return false;
    if (headers.get("set-cookie")) return false;
  }
  return true;
}

/** The only place a response is written. Silently declines anything `mayCache` refuses. */
async function cachePut(cacheName, request, response) {
  if (!mayCache(request, response)) return false;
  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());
  return true;
}

/** Deletes every cache this worker owns. Sign-out, and the sweep on activate, both use it. */
async function purgeOwnedCaches(keep = []) {
  const names = await caches.keys();
  await Promise.all(
    names.filter((n) => n.startsWith(CACHE_PREFIX) && !keep.includes(n)).map((n) => caches.delete(n)),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Individually, not addAll: addAll is atomic, so one 404 on one file throws the whole
    // install away and the app silently has no offline support at all.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Removes the previous build's asset cache AND `crusaders-api-v1`, the cache the leaking
    // version filled with member data on every device it ever ran on.
    await purgeOwnedCaches(OWNED);
    await self.clients.claim();
  })());
});

/**
 * Sign-out, session expiry, revocation and any 401 all send this. It empties everything the
 * worker holds — the shell and the assets included. They carry no member data, so this is
 * belt-and-braces rather than the defence; the defence is that member data was never stored.
 * The cost is one shell re-fetch on the next load, which on a shared club device is the right
 * trade.
 */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "CLEAR_CACHES") {
    event.waitUntil((async () => {
      await purgeOwnedCaches();
      const source = event.source;
      if (source && typeof source.postMessage === "function") {
        source.postMessage({ type: "CACHES_CLEARED" });
      }
    })());
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  await cachePut(cacheName, request, response);
  return response;
}

async function networkFirstShell(request) {
  try {
    const response = await fetch(request);
    // Keyed on /index.html rather than on the navigated URL, so every route falls back to the
    // one shell. `cachePut` still gets the real request, so its rules still apply.
    if (mayCache(request, response)) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put("/index.html", response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match("/index.html", { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Nothing under /api/ is intercepted at all. Not read from a cache, not written to one, not
  // revalidated. See the header of this file for why — the short version is that the Cache API
  // ignores the Authorization header and CacheStorage belongs to the browser profile, not to
  // the member. The live balance stream (/api/v1/wallet/stream) falls under this too: a cached
  // SSE response replays one stale balance and then hangs.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstShell(request));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
  if (SHELL.includes(url.pathname) || url.pathname.startsWith("/icon-") || url.pathname === "/apple-touch-icon.png") {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});
