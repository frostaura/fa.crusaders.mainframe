/*
 * The offline shell.
 *
 * docs/specs/feature-spec.md §12 asks for two things: installable on a home screen, and
 * "functional offline for read-only operations (view today's bookings, view balance from
 * cache)". The manifest and the icons buy the first. This buys the second.
 *
 * Three caching rules, and nothing else:
 *
 *   1. Hashed build assets (/assets/*) are immutable by construction — Vite puts the content
 *      hash in the filename — so they are cache-first, forever, and the sweep at activate is
 *      what removes the ones a new build no longer names.
 *   2. Navigations are network-first with the cached shell as the fallback. Network-first
 *      rather than cache-first because a stale index.html pointing at deleted asset hashes is
 *      a white screen, and a white screen is worse than a slow one.
 *   3. A short allow-list of read-only GET API calls is stale-while-revalidate, which is what
 *      makes today's bookings and the balance readable on a phone with no signal.
 *
 * Everything else — every POST, PUT, PATCH, DELETE, every API path not on the list — goes
 * straight to the network and is never cached. A booking, a cancellation and a top-up must
 * fail loudly when there is no network; a queued write that lands minutes later against a slot
 * somebody else has taken is a money bug wearing an offline-support costume.
 *
 * On the cached API responses: they are a member's own data on their own device, and the app
 * clears them at sign-out (the CLEAR_API_CACHE message below). They are never a substitute for
 * authorisation — every one of them is re-fetched from the server the moment there is a
 * network, and no cached response can authorise anything, because the server is what authorises.
 */

const VERSION = "v1";
const SHELL_CACHE = `crusaders-shell-${VERSION}`;
const ASSET_CACHE = `crusaders-assets-${VERSION}`;
const API_CACHE = `crusaders-api-${VERSION}`;
const OWNED = [SHELL_CACHE, ASSET_CACHE, API_CACHE];

/** The shell itself. Asset filenames are hashed at build time, so they are cached on first use. */
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png"];

/**
 * Read-only GETs worth having offline. Deliberately short: the schedule (today's bookings), the
 * wallet (the balance and its movements), the member's own profile, and the session probe —
 * without which the app decides it is signed out and shows a sign-in form to somebody holding
 * a phone with no signal.
 */
const CACHEABLE_API = ["/api/v1/schedule", "/api/v1/wallet", "/api/v1/me/profile", "/api/v1/whoami"];

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
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith("crusaders-") && !OWNED.includes(n))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/** Sign-out clears the member's cached reads; the next person on this device starts empty. */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "CLEAR_API_CACHE") {
    event.waitUntil(caches.delete(API_CACHE));
  }
});

function isCacheableApi(url) {
  return CACHEABLE_API.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`));
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirstShell(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put("/index.html", response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match("/index.html", { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);
  const fresh = fetch(request).then((response) => {
    // Only 200s. Caching a 401 would hand the member their own sign-out back, forever.
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  if (cached) {
    // Revalidate in the background; the member sees the cached answer now.
    fresh.catch(() => undefined);
    return cached;
  }
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The SSE stream must never be cached or replayed — it is a live connection, and a cached
  // one would hand back a single stale balance and then hang.
  if (url.pathname.startsWith("/api/v1/wallet/stream")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstShell(request));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    if (isCacheableApi(url)) event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (SHELL.includes(url.pathname) || url.pathname.startsWith("/icon-") || url.pathname === "/apple-touch-icon.png") {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});
