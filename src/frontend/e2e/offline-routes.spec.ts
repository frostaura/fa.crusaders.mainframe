import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { memberCodeSecretB64, MEMBER_CODE } from "./fixtures";
import { CHUNK_COPY } from "../src/lib/shellCopy";

/**
 * F4.3 — a page this phone has never opened, with no signal, on a PRODUCTION build.
 *
 * <p>
 * Every page but the entry's few is a lazy chunk, and the service worker used to precache only
 * what `index.html` names. So a member who had only ever opened My Code, lost signal and tapped
 * Wallet got the chunk fetch failing and the generic "This page hit a problem". Now the build
 * lists every chunk in `precache.json` and install caches them all; a chunk that is somehow
 * still missing gets a boundary that says the page opens when the phone is back online; and a
 * deploy under an open tab (the old chunk hash 404s) reloads once, never in a loop.
 * </p>
 *
 * <p>
 * Built and served like `my-code-offline.spec.ts` (its header says why the dev server cannot
 * answer this: no worker there at all). Its own build directory, so the two files never empty
 * each other's.
 * </p>
 */
test.describe.configure({ mode: "serial" });

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, "..");
const outDir = (project: string) => join(tmpdir(), `crusaders-e2e-prod-routes-${project}`);

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
let chunks: string[] = [];

test.beforeAll(async ({ browserName }, testInfo) => {
  void browserName;
  const dist = outDir(testInfo.project.name);
  execFileSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], { cwd: frontend, stdio: "pipe", timeout: 300_000 });
  chunks = (JSON.parse(readFileSync(join(dist, "precache.json"), "utf8")) as { assets: string[] }).assets;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const file = join(dist, url.pathname);
    // As nginx: a real file, a 404 for a missing asset, the shell for every route.
    if (existsSync(file) && extname(file)) {
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
      return;
    }
    if (url.pathname.startsWith("/assets/")) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[".html"] });
    res.end(readFileSync(join(dist, "index.html")));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the static server did not bind a port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const SESSION = { tenant_slug: "crusaders", tenant_id: "00000000-0000-0000-0000-000000000001", user_id: "00000000-0000-0000-0000-000000000009", is_authenticated: true, is_admin: false };

async function api(page: Page) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith("/whoami") ? SESSION
      : path.endsWith("/me/code/enrol") ? { v: 1, ref: MEMBER_CODE.ref, generation: 1, secret: memberCodeSecretB64(), tz: MEMBER_CODE.tz, step_seconds: 30, server_time_ms: Date.now() }
        : path.endsWith("/me/code") ? { v: 1, ref: MEMBER_CODE.ref, generation: 1, tz: MEMBER_CODE.tz, server_time_ms: Date.now() }
          : path.endsWith("/wallet") ? { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 50 }
            : null;
    if (body === null) return route.fulfill({ status: 501, contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function signedInAtMyCode(page: Page) {
  await page.addInitScript(() => { window.localStorage.setItem("crusaders.mainframe.token", "e2e-token"); });
  await api(page);
  await page.goto(`${origin}/my-code`);
  await expect(page.getByLabel("Your code", { exact: true })).toHaveText(/^118Y9\d{14}$/);
}

async function workerInControl(page: Page) {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return !!registration && !!navigator.serviceWorker.controller;
  }, undefined, { timeout: 20_000 });
}

async function cachedUrls(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
    }
    return urls;
  });
}

async function offline(page: Page, context: BrowserContext) {
  await page.unroute("**/api/**");
  await context.setOffline(true);
}

/** The in-app link — the tab bar on a phone, the top bar on a desktop. */
const navTo = (page: Page, name: string) => page.getByRole("link", { name, exact: true }).first().click();

test.describe("with the service worker", () => {
  test("install caches every chunk the build lists, and a never-opened page opens with no signal", async ({ page, context }) => {
    await signedInAtMyCode(page);
    await workerInControl(page);
    // Install finishes before the worker takes control, so the list should already be complete.
    await expect.poll(async () => {
      const cached = await cachedUrls(page);
      return chunks.filter((c) => !cached.includes(c));
    }, { message: "chunks the worker did not precache" }).toEqual([]);

    await offline(page, context);
    await navTo(page, "Wallet");

    await expect(page).toHaveURL(/\/wallet$/);
    await expect(page.getByRole("heading", { level: 1, name: "Wallet" })).toBeVisible();
    await expect(page.getByText("This page hit a problem")).toHaveCount(0);
  });

  test("a chunk that is somehow not on the phone gets the offline boundary with Retry, not a crash", async ({ page, context }) => {
    await signedInAtMyCode(page);
    await workerInControl(page);
    await expect.poll(async () => (await cachedUrls(page)).some((u) => /^\/assets\/Wallet-[^/]+\.js$/.test(u))).toBe(true);
    // A worker from before `precache.json` existed: the Wallet chunk was never cached.
    await page.evaluate(async () => {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) if (/\/assets\/Wallet-[^/]+\.js$/.test(req.url)) await cache.delete(req);
      }
    });

    await offline(page, context);
    await navTo(page, "Wallet");

    await expect(page.getByRole("heading", { level: 1, name: CHUNK_COPY.offlineTitle })).toBeVisible();
    await expect(page.getByRole("button", { name: CHUNK_COPY.retry })).toBeVisible();
    await expect(page.getByText("This page hit a problem")).toHaveCount(0);
  });
});

test.describe("a deploy under an open tab", () => {
  test.use({ serviceWorkers: "block" });

  /**
   * Every DOCUMENT load of this page, so a reload loop would show as a count. `load`, not
   * `framenavigated`: the latter also fires for the router's own pushState.
   */
  function countLoads(page: Page): () => number {
    let loads = 0;
    page.on("load", () => { loads += 1; });
    return () => loads;
  }

  test("an old chunk that 404s reloads the page once and then opens the new build", async ({ page }) => {
    const loads = countLoads(page);
    await signedInAtMyCode(page);
    const wallet = chunks.find((c) => /^\/assets\/Wallet-[^/]+\.js$/.test(c))!;
    let refused = 0;
    // The first ask for the chunk is the old build's hash, gone from the server; after the one
    // reload the page asks again and the (new) build has it.
    await page.route(`**${wallet}`, async (route) => {
      if (refused++ === 0) return route.fulfill({ status: 404, body: "" });
      return route.continue();
    });
    const before = loads();

    await navTo(page, "Wallet");

    await expect(page.getByRole("heading", { level: 1, name: "Wallet" })).toBeVisible();
    expect(loads() - before, "exactly one reload").toBe(1);
  });

  test("a chunk that is still missing after the reload is explained, never reloaded again", async ({ page }) => {
    const loads = countLoads(page);
    await signedInAtMyCode(page);
    const wallet = chunks.find((c) => /^\/assets\/Wallet-[^/]+\.js$/.test(c))!;
    await page.route(`**${wallet}`, (route) => route.fulfill({ status: 404, body: "" }));
    const before = loads();

    await navTo(page, "Wallet");

    await expect(page.getByRole("heading", { level: 1, name: CHUNK_COPY.failedTitle })).toBeVisible();
    await expect(page.getByRole("button", { name: CHUNK_COPY.retry })).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(loads() - before, "one reload, then the boundary — no loop").toBe(1);
  });
});
