import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * P4-3 (review round 4, performance lens) — a deploy reaches a phone that already has the app.
 *
 * <p>
 * <b>The finding.</b> `sw.js` carried a hand-kept `VERSION = "v3"` and never changed across
 * deploys. A browser installs a new worker only when the worker's own bytes change, so after a
 * deploy nothing installed: the new build's chunks were never precached (its pages had no code
 * offline) and `crusaders-assets-v3` gathered every build's files for ever.
 * </p>
 *
 * <p>
 * <b>The proof, end to end, in a real Chromium.</b> Two REAL production builds — this checkout,
 * and a copy of it with one source file changed — served in turn from one origin. A member uses
 * build A; the server starts answering with build B; the worker is asked to update. The new
 * worker must install and take control, keep only build B's caches, hold build B's files and none
 * that only build A had, fetch from the network only what changed, and — before and after —
 * hold nothing of the member's: no `/api/` response, and no cached body carrying their data.
 * </p>
 */

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(here, "..");
const MARKER = "MEMBER-DATA-7c1e";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon",
};

const SESSION = {
  tenant_slug: "crusaders", tenant_id: "00000000-0000-0000-0000-000000000001",
  user_id: "00000000-0000-0000-0000-000000000009", is_authenticated: true, is_admin: false,
};

/** The member's own reads, each carrying the marker the caches are searched for. */
const API: Record<string, unknown> = {
  "/api/v1/whoami": SESSION,
  "/api/v1/session": SESSION,
  "/api/v1/me/profile": { user_id: SESSION.user_id, email: `${MARKER}@club.review.test`, full_name: MARKER, status: "Active", is_admin: false, tenant_slug: "crusaders", photo_url: null },
  "/api/v1/wallet": { balance_minutes: 412.5, entries: [{ id: MARKER }], total_entries: 1, offset: 0, limit: 1, note: MARKER },
};

let server: Server;
let origin: string;
let root = "";
let served: string[] = [];
let work = "";
let distA = "";
let distB = "";

/** A production build of `source` into `out` — `vite build`, not the dev server. */
function build(source: string, out: string) {
  execFileSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir"], { cwd: source, stdio: "pipe", timeout: 300_000 });
  if (!existsSync(join(out, "index.html"))) throw new Error(`no build at ${out}`);
}

/** This checkout's frontend, copied without its dependencies (linked) or its outputs. */
function copyOfFrontend(to: string) {
  const skip = new Set(["node_modules", "dist", "test-results", "playwright-report", ".vite"]);
  cpSync(FRONTEND, to, { recursive: true, filter: (src) => !skip.has(src.slice(FRONTEND.length + 1).split("/")[0]) });
  symlinkSync(join(FRONTEND, "node_modules"), join(to, "node_modules"), "dir");
}

const assetsOf = (dist: string) => new Set(readdirSync(join(dist, "assets")).map((f) => `/assets/${f}`));

test.skip(({ isMobile }) => !!isMobile, "one pair of builds; the worker is the same at every viewport");
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  if (test.info().project.use.isMobile) return;
  test.setTimeout(600_000);
  work = mkdtempSync(join(tmpdir(), "crusaders-sw-update-"));
  distA = join(work, "distA");
  distB = join(work, "distB");
  build(FRONTEND, distA);

  // Build B: the same sources with ONE file changed — a real change to a module every page loads.
  const copy = join(work, "src-b");
  copyOfFrontend(copy);
  const file = join(copy, "src", "lib", "authCopy.ts");
  writeFileSync(file, `${readFileSync(file, "utf8")}\nexport const SW_UPDATE_PROBE = "build B";\nconsole.debug(SW_UPDATE_PROBE);\n`);
  build(copy, distB);

  root = distA;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    served.push(url.pathname);
    if (url.pathname.startsWith("/api/")) {
      const body = API[url.pathname];
      res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? { error: "not_here" }));
      return;
    }
    const asset = join(root, url.pathname.replace(/^\/+/, ""));
    const isFile = asset.startsWith(root) && existsSync(asset) && statSync(asset).isFile();
    if (!isFile && url.pathname.startsWith("/assets/")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = isFile ? asset : join(root, "index.html");
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()));
  if (work) rmSync(work, { recursive: true, force: true });
});

/**
 * Every cache, its URLs, and whether any stored body carries the member's marker. A new worker
 * taking control may reload the page mid-read; that read is simply taken again once it has loaded.
 */
async function cacheReport(page: Page): Promise<{ name: string; urls: string[]; marked: string[] }[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readCaches(page);
    } catch (error) {
      if (attempt >= 4 || !/context was destroyed|navigat/i.test(String(error))) throw error;
      await page.waitForLoadState("load");
    }
  }
}

function readCaches(page: Page) {
  return page.evaluate(async (marker) => {
    const out: { name: string; urls: string[]; marked: string[] }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      const urls: string[] = [];
      const marked: string[] = [];
      for (const request of await cache.keys()) {
        const path = new URL(request.url).pathname;
        urls.push(path);
        const body = await (await cache.match(request))!.text();
        if (body.includes(marker)) marked.push(path);
      }
      out.push({ name, urls, marked });
    }
    return out;
  }, MARKER);
}

function noMemberData(report: Awaited<ReturnType<typeof cacheReport>>) {
  for (const cache of report) {
    expect(cache.urls.filter((u) => u.startsWith("/api/")), `${cache.name} holds an API response`).toEqual([]);
    expect(cache.marked, `${cache.name} holds a body with the member's data`).toEqual([]);
  }
}

/**
 * P4-6 (R4) — what a member's install fetches before the worker takes control: their pages, not
 * the desk's frame (20 kB gzip, named lazily by the entry) and not the report charts (124 kB gzip,
 * a fifth of the install, drawn only by the wallet's Activity tab and the desk's reports). Both
 * are still precached once the worker is in control (`precacheRest`).
 */
test("a member's install set leaves out the desk's frame and the charts", () => {
  const list = JSON.parse(readFileSync(join(distA, "precache.json"), "utf8")) as { assets: string[]; first: string[] };
  const later = list.first.filter((p) => /\/(ReportParts|Charts|adminFrame)-[^/]*\.js$/.test(p));
  expect(later).toEqual([]);
  expect(list.assets.some((p) => /\/ReportParts[^/]*\.js$/.test(p)), "the charts are still listed for later").toBe(true);
  expect(list.first.some((p) => /\/index-[^/]+\.js$/.test(p))).toBe(true);
});

const buildOf = (dist: string) => (JSON.parse(readFileSync(join(dist, "precache.json"), "utf8")) as { build: string }).build;

test("a deploy installs the new build's worker, prunes the old build and caches nothing of the member's", async ({ page }) => {
  test.setTimeout(240_000);
  const [a, b] = [buildOf(distA), buildOf(distB)];
  expect(a, "the two builds must differ").not.toBe(b);
  expect(readFileSync(join(distA, "sw.js"), "utf8")).toContain(`const BUILD = "${a}"`);
  expect(readFileSync(join(distB, "sw.js"), "utf8")).toContain(`const BUILD = "${b}"`);

  // A member on build A, signed in, reading their own data.
  await page.addInitScript(() => localStorage.setItem("crusaders.mainframe.token", "e2e-token"));
  await page.goto(`${origin}/my-code`);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 60_000 });
  await page.evaluate(() => fetch("/api/v1/wallet", { headers: { authorization: "Bearer e2e-token" } }).then((r) => r.text()));
  const entryA = [...assetsOf(distA)].find((p) => /\/index-[^/]+\.js$/.test(p))!;
  await expect.poll(async () => (await cacheReport(page)).find((c) => c.name === `crusaders-assets-${a}`)?.urls.includes(entryA) ?? false,
    { timeout: 60_000 }).toBe(true);
  noMemberData(await cacheReport(page));

  // The deploy: the same origin now serves build B, and the worker checks for an update.
  root = distB;
  served = [];
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  await expect.poll(async () => (await cacheReport(page)).map((c) => c.name).sort(), { timeout: 120_000 })
    .toEqual([`crusaders-assets-${b}`, `crusaders-shell-${b}`]);

  const report = await cacheReport(page);
  const held = new Set(report.find((c) => c.name === `crusaders-assets-${b}`)!.urls);
  const [inA, inB] = [assetsOf(distA), assetsOf(distB)];
  const onlyA = [...inA].filter((p) => !inB.has(p));
  const changed = [...inB].filter((p) => !inA.has(p) && /\.(js|css)$/.test(p));
  expect(onlyA.length, "build B changed nothing").toBeGreaterThan(0);
  expect(onlyA.filter((p) => held.has(p)), "the old build's files are still cached").toEqual([]);
  for (const p of changed) expect(held.has(p), `${p} (new in build B) was not precached`).toBe(true);
  // A deploy re-downloads what changed, not the whole app: a file both builds name came from the
  // last build's cache, not from the server.
  const shared = [...inA].filter((p) => inB.has(p) && /\.(js|css)$/.test(p));
  expect(shared.filter((p) => served.includes(p)), "unchanged files fetched again").toEqual([]);
  noMemberData(report);

  // And the page is now controlled by build B's worker.
  const controller = await page.evaluate(async () => {
    const text = await (await fetch("/sw.js", { cache: "no-store" })).text();
    return { url: navigator.serviceWorker.controller?.scriptURL ?? null, build: /const BUILD = "([^"]+)"/.exec(text)?.[1] };
  });
  expect(controller.url).toContain("/sw.js");
  expect(controller.build).toBe(b);
});
