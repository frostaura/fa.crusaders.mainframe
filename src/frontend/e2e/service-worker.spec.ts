import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * E-F06 — the offline shell, driven through a REAL service worker registration.
 *
 * <p>
 * <b>Why this file exists.</b> The worker's rules were pinned only by `src/serviceWorker.test.ts`,
 * which evaluates `public/sw.js` in a Node `vm` with a hand-written Cache. That harness is honest
 * and it catches the defect it models — but it is a model, and the decision recorded in
 * `docs/specs/feature-spec.md` §12 (that the service worker caches no member data at all) is a
 * privacy boundary in a money system. A boundary is worth one test that no model stands behind:
 * a real Chromium, a real `navigator.serviceWorker.register`, the real Cache API, real HTTP.
 * </p>
 *
 * <p>
 * <b>It also disproves the reason this repository used to give for a design decision.</b>
 * `public/sw.js` records that per-session cache keying was first rejected partly because "a
 * service worker could not be registered in this repo's automation". It can, and this spec is the
 * proof: it registers one on the Chromium Playwright already drives for `narrow-viewport.spec.ts`.
 * The rejection stands on its own merits (see §12), not on a machine limitation that was never
 * real.
 *
 * <b>How many places carried that sentence is deliberately not stated here.</b> The previous
 * wording said "four places / three files", which was wrong, and no count of a claim in history
 * can be checked by reading the tree this comment ships in. The live wording of the surviving
 * note is in `public/sw.js` and `src/test/swHarness.ts`; that is what a reader can verify.
 * </p>
 *
 * <p>
 * <b>Why it serves its own origin instead of using the app.</b> `src/lib/pwa.ts` registers the
 * worker only in a production build, and route interception does not reach requests a worker makes
 * for itself. So this spec stands up a small HTTP server that serves the real `public/sw.js` plus
 * a wallet endpoint that answers with whoever asked — which is exactly the question the leak got
 * wrong. Nothing here is stubbed inside the browser: the worker, the Cache API and the fetches are
 * the browser's own.
 * </p>
 */

const here = dirname(fileURLToPath(import.meta.url));
const swSource = () => readFileSync(resolve(here, "../public/sw.js"), "utf8");

const SHELL_HTML = "<!doctype html><html><head><title>Crusaders Mainframe</title></head><body><div id=\"root\">shell</div></body></html>";

/**
 * The origin under test.
 *
 * <p>
 * Port 0 so the two Playwright projects (mobile and desktop) can run this file in parallel
 * without colliding. `127.0.0.1` rather than a hostname because a service worker needs a secure
 * context, and loopback counts as one.
 * </p>
 */
let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const authorization = req.headers.authorization ?? null;

    if (url.pathname === "/sw.js") {
      // Served the way `src/frontend/nginx.conf` serves a static file, so the worker under test
      // is byte-for-byte the one the club would download.
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(swSource());
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      // No cache-control header, deliberately: the API does not send one, so the ONLY thing
      // standing between two members and a shared cache entry is the worker's own rule. A
      // `no-store` here would make this spec pass against a worker that had no rule at all.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ member: authorization, balance_credits: authorization === "Bearer alice" ? 412.5 : 0 }));
      return;
    }

    if (url.pathname === "/manifest.webmanifest") {
      res.writeHead(200, { "content-type": "application/manifest+json" });
      res.end(JSON.stringify({ name: "Crusaders Mainframe", start_url: "/" }));
      return;
    }

    if (url.pathname.startsWith("/icon-") || url.pathname === "/favicon.svg" || url.pathname.startsWith("/assets/")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(`static:${url.pathname}`);
      return;
    }

    // Every other path is a navigation: one shell, as the app itself is served.
    res.writeHead(200, { "content-type": "text/html" });
    res.end(SHELL_HTML);
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the probe server did not bind a port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

/** Registers the real worker and waits until it is the one answering this page's fetches. */
async function takeControl(page: import("@playwright/test").Page): Promise<string> {
  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    return registration.scope;
  });
  // `install` calls skipWaiting and `activate` calls clients.claim, so control arrives without a
  // reload — but it arrives asynchronously, so wait for it rather than assuming it.
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 15_000 });
  return scope;
}

/** Every URL in every cache this origin holds, grouped by cache name. */
async function cacheContents(page: import("@playwright/test").Page): Promise<Record<string, string[]>> {
  return await page.evaluate(async () => {
    const out: Record<string, string[]> = {};
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      out[name] = (await cache.keys()).map((request) => new URL(request.url).pathname).sort();
    }
    return out;
  });
}

test("a real service worker registers in this repo's automation and takes control of the page", async ({ page }) => {
  // The positive half, and the reason the spec exists at all: if this fails, every "nothing is
  // cached" assertion below would pass vacuously, on a page no worker was ever in front of.
  await page.goto(`${origin}/`);
  const scope = await takeControl(page);

  expect(scope).toBe(`${origin}/`);
  const script = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);
  expect(script).toBe(`${origin}/sw.js`);

  // And it does its job: an anonymous static asset really is stored. This is what makes the
  // absence assertions in the next test mean something.
  await page.evaluate(() => fetch("/icon-192.png").then((r) => r.text()));
  await expect.poll(async () => {
    const stored = await cacheContents(page);
    return Object.entries(stored).find(([name]) => name.startsWith("crusaders-shell"))?.[1] ?? [];
  }).toContain("/icon-192.png");
});

test("two members on one browser profile never share a cached response", async ({ page }) => {
  await page.goto(`${origin}/`);
  await takeControl(page);

  const read = (token: string) =>
    page.evaluate(
      (auth) => fetch("/api/v1/wallet", { headers: { authorization: auth } }).then((r) => r.json()),
      token,
    );

  // Alice reads her wallet twice — once to populate whatever the worker keeps, once to be sure a
  // second identical GET is answered the same way.
  expect((await read("Bearer alice")).member).toBe("Bearer alice");
  expect((await read("Bearer alice")).member).toBe("Bearer alice");

  // Bob signs in on the same club-desk tablet. Same URL, same method, different member. The Cache
  // API keys on the URL and ignores the Authorization header, so a worker that stored Alice's
  // response hands it to Bob — that is the leak, reproduced live in round two before the fix.
  const bob = await read("Bearer bob");
  expect(bob.member, "Bob was served a response belonging to another member").toBe("Bearer bob");
  expect(bob.balance_credits).toBe(0);

  // And nothing under /api/ reached storage at all, so there is nothing left for a third member,
  // for a devtools reader, or for the next person to pick the tablet up.
  const stored = await cacheContents(page);
  const apiUrls = Object.values(stored).flat().filter((path) => path.startsWith("/api/"));
  expect(apiUrls, "the worker stored a member-data response").toEqual([]);
});

test("what §12 still promises: the app opens with no signal", async ({ page, context }) => {
  await page.goto(`${origin}/`);
  await takeControl(page);

  // Warm the shell the way a member's first visit does.
  await page.goto(`${origin}/schedule`);
  await expect(page).toHaveTitle("Crusaders Mainframe");

  await context.setOffline(true);
  try {
    await page.goto(`${origin}/wallet`);
    // A route the member has never opened still gets the interface rather than the browser's
    // offline page: the worker falls back to the one cached shell for every navigation.
    await expect(page).toHaveTitle("Crusaders Mainframe");
    await expect(page.locator("#root")).toHaveText("shell");
  } finally {
    await context.setOffline(false);
  }
});
