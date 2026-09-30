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
 * new one). It works on paper, and it was first rejected here for a reason that was FALSE: that
 * a service worker could not be registered in this repo's automation. One can — `npx playwright
 * test e2e/service-worker.spec.ts` registers this file in a real Chromium, reproduces the
 * two-member leak against the old version and holds the rule below. The reasons that survive:
 *
 *   - Not caching member data has no failure mode. Per-session keying has one and it is silent:
 *     the cache still answers, just with the wrong member's body.
 *   - It would make a privacy boundary depend on the page's own guess at who is signed in, at
 *     the moments the page is least sure — a token that expired while the tab was closed, a
 *     session ended in another tab, an admin acting on behalf of a member.
 *   - What it would buy is a stale balance, and a balance that is not the ledger is the one
 *     number this system may not show. Nothing can be done with it offline anyway: every
 *     booking, cancellation and top-up needs the network.
 *
 * WHAT IS CACHED
 * --------------
 *   1. Hashed build assets (/assets/*) — immutable by construction, Vite puts the content hash
 *      in the filename — cache-first, with the activate sweep removing what a new build no
 *      longer names. The ones `index.html` names AND every chunk the build lists in
 *      `/precache.json` (F4.3) are fetched at INSTALL time; see `precacheBuild` and
 *      `buildChunks` for why waiting for first use is not good enough.
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

/**
 * The build this worker ships with (P4-3, review round 4), written in by the build
 * (`vite.config.ts` → `src/swBuild.ts`); the placeholder is what an unbuilt copy carries.
 *
 * It used to be a hand-kept "v3", so the file never changed across deploys: a browser installs a
 * new worker only when its bytes change, so no deploy ever installed one — the new build's chunks
 * were never precached, and `crusaders-assets-v3` gathered every build's files for ever. Now each
 * build is its own worker with its own caches, and activating it removes every other build's.
 */
const BUILD = "__CRUSADERS_BUILD__";
const SHELL_CACHE = `crusaders-shell-${BUILD}`;
const ASSET_CACHE = `crusaders-assets-${BUILD}`;
const OWNED = [SHELL_CACHE, ASSET_CACHE];
/** Earlier builds' asset caches, read (never written) at install for files this build still names. */
const ASSET_PREFIX = "crusaders-assets-";

/**
 * Every cache this worker has ever owned starts with this prefix, including `crusaders-api-v1`
 * from the leaking version and every earlier build's shell and assets. The activate sweep below is
 * what removes them from devices the old worker already ran on.
 */
const CACHE_PREFIX = "crusaders-";

/** The shell itself. The hashed build assets are read out of it at install — `precacheBuild`. */
/** `/theme-boot.js` is un-hashed and runs before first paint: an offline start without it paints light. */
const SHELL = ["/", "/index.html", "/theme-boot.js", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png"];

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

/** Moves on every purge; a precache that started before one stores nothing after it. */
let cacheGeneration = 0;

/** Deletes every cache this worker owns. Sign-out, and the sweep on activate, both use it. */
async function purgeOwnedCaches(keep = []) {
  if (keep.length === 0) cacheGeneration += 1;
  const names = await caches.keys();
  await Promise.all(
    names.filter((n) => n.startsWith(CACHE_PREFIX) && !keep.includes(n)).map((n) => caches.delete(n)),
  );
}

/**
 * The build's own entry files, cached at INSTALL rather than on first use. (R3-9 / D-H3)
 *
 * WHY THIS EXISTS
 * ---------------
 * The shell used to be `index.html` and the icons, and the note here said the hashed assets
 * "are cached on first use". They are not — not on the visit that installs this worker, which
 * is the only visit most members ever make before they need it:
 *
 *   - A page load fetches `/assets/index-<hash>.js` as part of parsing the document. That
 *     happens BEFORE `load`, which is when `lib/pwa` registers this file, so the request never
 *     passes through a worker and never reaches a cache.
 *   - The next cold start with no signal then served a cached `index.html` whose only script
 *     could not be fetched: a blank page, from a home-screen icon, which is worse than the
 *     browser's own offline page because it looks like the app is broken rather than like the
 *     phone has no signal.
 *   - It came right on the THIRD visit, once a controlled load had fetched the script through
 *     the worker — so it worked sometimes, for reasons no member could see.
 *
 * The filenames are content-hashed, so there is no list to keep: the document names them, and
 * the document is fetched fresh. Failures are swallowed per URL — an install that throws leaves
 * the app with no offline support at all, and a missing font is not worth that.
 *
 * FONTS ARE NOT INCLUDED, deliberately. They are named by the stylesheet rather than by the
 * document, and a missing web font renders in the fallback face: a legible page rather than no
 * page. They land in the cache on first use like anything else once this worker is in control.
 */
async function precacheBuild() {
  const generation = cacheGeneration;
  try {
    const response = await fetch("/index.html", { cache: "no-cache" });
    if (!response.ok) return;
    const html = await response.text();
    // Every /assets/ path the document names, in a `src`, an `href` or a modulepreload — and
    // (F4.3) every chunk the build emitted, so a page never opened with signal still opens
    // without it.
    const listed = await buildChunks();
    const firstUrls = [...new Set([...(html.match(/\/assets\/[A-Za-z0-9._-]+/g) || []), ...listed.first])];
    // PERF (2026-09-30): at INSTALL only the document's own files and every chunk a MEMBER's page
    // needs, a few at a time; the desk's pages once this worker is in control (`precacheRest`).
    // All ~110 at once queued the page's own reads behind them on a phone's six connections, on
    // the very visit that installs this — and an install that fetched all of them two at a time
    // left the member's first visits uncontrolled (no offline) for that much longer.
    await fetchInto(firstUrls, 4, generation);
  } catch {
    // Installed with no network, or behind a captive portal. There is nothing to precache and
    // nothing to be done about it; first use will fill the cache instead.
  }
}

/**
 * Every lazy route's chunk, from the build's own list (`precache.json`, written by the Vite
 * config). (F4.3)
 *
 * WHY: the document names only the entry, so every page a member had not yet opened with signal
 * had no code on the phone — and opening one with none ended on the generic "This page hit a
 * problem". The names are content-hashed, so the list is exact for the build that wrote it. Only
 * `/assets/` paths are taken from it, whatever else it says; an absent or unreadable list costs the
 * offline pages and nothing else, and the page boundary then says "this page opens when you're
 * back online" rather than crashing.
 */
async function buildChunks() {
  const assetsOnly = (list) => (Array.isArray(list) ? list : [])
    .filter((url) => typeof url === "string" && /^\/assets\/[A-Za-z0-9._-]+$/.test(url));
  try {
    const response = await fetch("/precache.json", { cache: "no-cache" });
    if (!response.ok) return { all: [], first: [] };
    const body = await response.json();
    const all = assetsOnly(body && body.assets);
    // `first` (perf, 2026-09-30): what a member's pages need. A list from before it existed puts
    // everything first, as before.
    const first = body && Array.isArray(body.first) ? assetsOnly(body.first).filter((url) => all.includes(url)) : all;
    return { all, first };
  } catch {
    return { all: [], first: [] };
  }
}

/**
 * Every listed chunk not yet in the cache — the desk's pages, after install — two at a time, once
 * this worker is in control. Still every chunk on the phone (F4.3), just not ahead of the page.
 */
async function precacheRest() {
  const generation = cacheGeneration;
  try {
    const listed = await buildChunks();
    const cache = await caches.open(ASSET_CACHE);
    const missing = [];
    for (const url of listed.all) if (!(await cache.match(url))) missing.push(url);
    await fetchInto(missing, 2, generation, true);
  } catch {
    // Offline after install: first use fills the cache instead.
  }
}

/** The file from an earlier build's asset cache, when one holds it; never this build's own. */
async function fromEarlierBuild(url) {
  const names = (await caches.keys()).filter((n) => n.startsWith(ASSET_PREFIX) && n !== ASSET_CACHE);
  for (const name of names) {
    const hit = await (await caches.open(name)).match(url);
    if (hit) return hit;
  }
  return null;
}

/** Fetches and stores `urls`, `lanes` at a time. One asset that will not fetch costs only itself. */
async function fetchInto(urls, lanes, generation = cacheGeneration, cacheMustExist = false) {
  const queue = [...urls];
  // A sign-out's purge after `generation` was read — by this worker, or by the page deleting the
  // caches itself (`cacheMustExist`: the cache is gone) — must not be undone by fetches still going.
  const wanted = async () => generation === cacheGeneration && (!cacheMustExist || (await caches.has(ASSET_CACHE)));
  const lane = async () => {
    while (queue.length > 0 && (await wanted())) {
      // Checked AFTER the await: every lane passed the length check before any of them took a
      // URL, so the spare lanes used to fetch `undefined` — "/undefined", which the SPA fallback
      // answers 200 with the shell, stored in the asset cache (found in R4).
      const url = queue.shift();
      if (url === undefined) return;
      try {
        // A content-hashed file this build still names is the same bytes the last build cached:
        // take it from there rather than the network (a deploy re-downloads only what changed).
        const asset = (await fromEarlierBuild(url)) || (await fetch(url));
        if (!(await wanted())) return;
        // Through `cachePut`, not `cache.add`: one chokepoint decides what may be stored, and
        // a second path into the cache is how the rule above gets quietly broken.
        await cachePut(ASSET_CACHE, new Request(url), asset);
      } catch {
        // One asset that will not fetch must not cost the others their place.
      }
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // Individually, not addAll: addAll is atomic, so one 404 on one file throws the whole
    // install away and the app silently has no offline support at all. P4-2 (R4): past the HTTP
    // cache (`no-cache` revalidates), because `cache.add` took whatever the browser held — an
    // index.html heuristically cached for hours named the previous build's files.
    await Promise.all(SHELL.map(async (url) => {
      try {
        await cachePut(SHELL_CACHE, new Request(url), await fetch(url, { cache: "no-cache" }));
      } catch {
        // One shell file that will not fetch costs only itself.
      }
    }));
    await precacheBuild();
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Removes every earlier build's shell AND `crusaders-api-v1`, the cache the leaking version
    // filled with member data on every device it ever ran on — at once.
    const earlierAssets = (await caches.keys()).filter((n) => n.startsWith(ASSET_PREFIX) && n !== ASSET_CACHE);
    await purgeOwnedCaches([...OWNED, ...earlierAssets]);
    await self.clients.claim();
    // The desk's chunks, taking any file the last build already had from its cache (P4-3)…
    await precacheRest();
    // …and then the last build's assets go too: this build's cache now holds everything it names.
    await purgeOwnedCaches(OWNED);
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
    // P4-2 (R4): revalidated with the server every time — the document names this build's files,
    // and a copy the HTTP cache kept past a deploy is a page asking for files that are gone.
    const response = await fetch(request, { cache: "no-cache" });
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
