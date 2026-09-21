import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * R3-9 / D-H3 — the PWA promise, held against a REAL production build.
 *
 * <p>
 * <b>The finding.</b> The manifest declares `display: standalone` and a shortcut straight to
 * `/my-code`, so a member is invited to put the club's code page on their home screen. Reviewer
 * D took that invitation, turned the signal off, and got the browser's own offline error page.
 * Everything R2 built for that moment — `lib/lastKnown`, the offline-capable route in
 * `RequireAuth`, the "this is what we last knew" copy — is behind an app that never started.
 * </p>
 *
 * <p>
 * <b>Why nothing already here could see it.</b> `e2e/service-worker.spec.ts` drives the real
 * worker against a hand-written shell — a string of HTML with no script tag in it — so it proves
 * the CACHING RULES and cannot prove the app boots. Every other browser test runs against the
 * Vite dev server, where `main.tsx` deliberately does not register a worker at all. And the unit
 * suite reads `public/sw.js` in a Node `vm`. Three test layers, and the one thing none of them
 * touches is a production bundle in a browser with the network off — which is the only place
 * this defect exists.
 * </p>
 *
 * <p>
 * <b>What the gap actually was.</b> The shell was cached on install; the hashed
 * `/assets/index-*.js` was not. A first visit loads that script BEFORE the worker has claimed
 * the page, so it never passes through the worker and never reaches the asset cache — and the
 * next cold start serves a cached `index.html` whose only script 404s into a blank page. The
 * app worked offline on the third visit and nowhere else, which is indistinguishable from
 * "sometimes it works".
 * </p>
 */

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(here, "..");
const DIST = join(FRONTEND, "dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

let server: Server;
let origin: string;

/** The newest mtime anywhere under a path — the sources this build is made of. */
function newestUnder(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(path)
    .filter((name) => name !== "node_modules" && name !== "dist")
    .reduce((newest, name) => Math.max(newest, newestUnder(join(path, name))), stat.mtimeMs);
}

/**
 * One project builds and measures the bundle.
 *
 * <p>
 * Nothing here is viewport-dependent — it is a service worker, a cache and a boot — and the two
 * Playwright projects are two workers, which would be two `vite build`s racing each other into
 * one `dist/`. The rest of the suite runs in both because layout is the thing it is about.
 * </p>
 */
test.skip(({ isMobile }) => !!isMobile, "the bundle is the same bundle at every viewport");

/**
 * One worker, because there is one `dist/`.
 *
 * <p>
 * The config runs `fullyParallel`, which splits a FILE's tests across workers — and every
 * worker runs `beforeAll`. Observed on this file: three `vite build`s racing into one
 * directory and two tests failing on half-written assets. These three cases share one built
 * artifact, so they share one worker.
 * </p>
 */
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({}, testInfo) => {
  // The skip above is evaluated per TEST, which is after this hook has already run — so
  // without this the mobile worker builds `dist/` as well, and two `vite build`s race into one
  // directory. Observed: two "built in 12s" lines on one run.
  if (testInfo.project.use.isMobile) return;
  // A cold `vite build` is about forty seconds and a hook gets the ordinary test timeout, so
  // without this the first run on a clean checkout fails with "Test ended" in the middle of a
  // navigation — a failure that says nothing about the build it was waiting for.
  test.setTimeout(300_000);
  /**
   * The build is the fixture, so the test builds it — and rebuilds it when it is STALE.
   *
   * <p>
   * A spec that skipped itself on a missing `dist/` would pass on every machine where the thing
   * it tests has never been compiled, and the gate it stands in for is exactly "does the
   * shipped bundle work". Worse, and found here the hard way: an existing `dist/` from an older
   * checkout tests the OLD worker, silently, and reports it as this one. The first red run of
   * this file was fixed and stayed red for that reason.
   * </p>
   *
   * <p>
   * `npm run build` is about fifteen seconds and is idempotent, so a run that has just built —
   * which the quality gate does — pays only the mtime comparison.
   * </p>
   */
  const built = existsSync(join(DIST, "index.html")) ? statSync(join(DIST, "index.html")).mtimeMs : 0;
  const sources = Math.max(
    newestUnder(join(FRONTEND, "src")),
    newestUnder(join(FRONTEND, "public")),
    newestUnder(join(FRONTEND, "index.html")),
    newestUnder(join(FRONTEND, "vite.config.ts")),
  );
  if (built < sources) {
    execFileSync("npm", ["run", "build"], { cwd: FRONTEND, stdio: "inherit", timeout: 300_000 });
  }

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // Nothing here answers the API. Offline or not, the worker must never reach for it and the
    // page must cope — which is what `lib/lastKnown` and the offline-capable route are for.
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "offline_probe" }));
      return;
    }

    const asset = join(DIST, url.pathname.replace(/^\/+/, ""));
    const isFile = asset.startsWith(DIST) && existsSync(asset) && statSync(asset).isFile();
    const file = isFile ? asset : join(DIST, "index.html");
    // The SPA fallback nginx.conf performs, so a deep link is the one shell — which is also
    // what makes "the worker fell back to the cached shell" a meaningful claim.
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the dist server did not bind a port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (!server) return;
  await new Promise<void>((done) => server.close(() => done()));
});

/** Waits until the worker the app registered for itself is the one answering this page. */
async function workerHasControl(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 20_000 });
}

/** Every path in every cache this origin holds. */
async function cachedPaths(page: import("@playwright/test").Page): Promise<string[]> {
  return await page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      out.push(...(await cache.keys()).map((request) => new URL(request.url).pathname));
    }
    return out.sort();
  });
}

test("a member who has opened the app once can open it again with no signal at all", async ({ page, context }) => {
  // One visit, online, exactly as a member's first visit goes. `main.tsx` registers the worker
  // itself under `import.meta.env.PROD` — nothing here registers it by hand, because "does the
  // shipped app set this up for itself" is half of what is being tested.
  await page.goto(`${origin}/`);
  await workerHasControl(page);

  // The entry bundle is in the cache before anything goes offline. This is the assertion the
  // finding turns on: the script was fetched before the worker existed, so nothing put it there
  // unless the worker went and got it.
  const warm = await cachedPaths(page);
  const entry = warm.filter((path) => path.startsWith("/assets/") && path.endsWith(".js"));
  expect(entry, `the app's own bundle was never cached; the cache holds ${JSON.stringify(warm)}`)
    .not.toEqual([]);

  await context.setOffline(true);
  try {
    // A COLD start: a new page, the home-screen shortcut's own route, no network.
    const cold = await context.newPage();
    await cold.goto(`${origin}/my-code`);

    // The proof that the APP booted rather than just the HTML arriving: the document title is
    // set by `RouteAnnouncer` from JavaScript. The static `index.html` says "Crusaders
    // Mainframe" and nothing else ever changes it.
    await expect(cold).toHaveTitle(/— Crusaders Mainframe$/, { timeout: 15_000 });
    const rendered = await cold.evaluate(() => document.getElementById("root")?.childElementCount ?? 0);
    expect(rendered, "the shell loaded but React never rendered into it").toBeGreaterThan(0);
    await cold.close();
  } finally {
    await context.setOffline(false);
  }
});

/**
 * The privacy half, which is the reason this worker caches so little.
 *
 * <p>
 * `public/sw.js` carries the whole argument: the Cache API keys on the URL and ignores the
 * Authorization header, and CacheStorage belongs to the browser profile rather than to the
 * member — so one club-desk tablet is one cache shared by everyone who has ever signed in on
 * it. Nothing under `/api/` is cached, and precaching the shell must not have quietly changed
 * that.
 * </p>
 */
test("caches the shell and the build, and nothing that belongs to a member", async ({ page }) => {
  await page.goto(`${origin}/`);
  await workerHasControl(page);
  // Let the app make its own opening requests — whoami, profile, wallet — all of which 503 here
  // and none of which may be stored either way.
  await page.waitForTimeout(500);

  const paths = await cachedPaths(page);
  expect(paths.filter((path) => path.startsWith("/api/")), "a member's own data is in the cache").toEqual([]);
  expect(paths.filter((path) => path.startsWith("/uploads/")), "a member's photo is in the cache").toEqual([]);
  // What it IS allowed to hold: the shell, the icons, the manifest and the hashed build.
  const stranger = paths.filter((path) => !/^\/(index\.html)?$|^\/assets\/|^\/icon-|^\/apple-touch-icon\.png$|^\/favicon\.svg$|^\/manifest\.webmanifest$/.test(path));
  expect(stranger, `the worker cached something nobody decided it should: ${JSON.stringify(stranger)}`).toEqual([]);
});

/**
 * And a shared device is left with nothing readable. (E-F06)
 *
 * <p>
 * The worker holds no member data, so this is the second line rather than the first — but the
 * first line has to be able to change without this one being forgotten, and a club-desk tablet
 * is one browser profile passed between people.
 * </p>
 */
test("a sign-out leaves nothing of this app in the browser's caches", async ({ page }) => {
  await page.goto(`${origin}/`);
  await workerHasControl(page);
  expect(await cachedPaths(page)).not.toEqual([]);

  // What `lib/pwa.clearOfflineCache` does, through the same public entry point the sign-out
  // path uses. Imported from the built bundle is not possible, so this is the page's half of
  // it — the purge that runs whatever the worker's state is.
  await page.evaluate(async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith("crusaders-")).map((n) => caches.delete(n)));
  });

  expect(await cachedPaths(page)).toEqual([]);
});
