import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * D3 — the member at the door with no signal, on a PRODUCTION build.
 *
 * <p>
 * <b>Why this file is not a case in `my-code.spec.ts`.</b> Every other spec drives the Vite
 * dev server, and `src/main.tsx` registers the service worker only under
 * `import.meta.env.PROD`. So there is no worker in that stack at all: a cold start with the
 * network down gets the browser's own error page, the app never boots, and the whole
 * last-known store — the code, the club's door rules, the club's number — is unreachable by
 * the one person it exists for. Reviewer D found exactly that and could not tell whether it
 * was the product or the stack, which is the question this file answers.
 * </p>
 *
 * <p>
 * <b>So it builds the app and serves the build.</b> Nothing here is stubbed inside the
 * browser: the worker, the Cache API, the shell fetch and the fallback are the browser's
 * own, and the bundle is the one a club would be served. The API is intercepted only while
 * the page is being warmed; the offline half runs with interception removed and the context
 * genuinely offline, so a response that arrives has arrived from a cache.
 * </p>
 *
 * <p>
 * `e2e/service-worker.spec.ts` holds the worker's privacy rules against a hand-built origin.
 * This holds what a member sees when those rules leave them with a shell and a local store.
 * </p>
 */

/*
  One worker per project, in order.

  `beforeAll` runs once per WORKER, not once per file, so under `fullyParallel` the two
  cases below land on two workers of the same project and run two `vite build`s into one
  directory at the same time — each emptying it under the other. Serial mode gives the file
  one build and one server, and the ordering is honest besides: if the worker never takes
  control of the page, the offline case is not a result, it is a different test.
*/
test.describe.configure({ mode: "serial" });

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, "..");

/**
 * A build of its own, outside the repo.
 *
 * <p>
 * Both Playwright projects run this file and `fullyParallel` lets them start together, so a
 * shared `dist/` would be two `vite build` runs emptying and writing one directory at the
 * same time. The project name keeps them apart; `tmpdir()` keeps the artefacts out of the
 * tree entirely, which is also why nothing needs adding to `.gitignore`.
 * </p>
 */
const outDir = (project: string) => join(tmpdir(), `crusaders-e2e-prod-${project}`);

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
  ".ico": "image/x-icon",
};

let server: Server;
let origin: string;

test.beforeAll(async ({ browserName }, testInfo) => {
  void browserName; // the fixture argument exists so `testInfo` can be the second parameter
  const dist = outDir(testInfo.project.name);
  // `--emptyOutDir` because the directory is outside the project root and Vite refuses to
  // clear one without being told to; without it a stale bundle from a previous run would be
  // served beside a fresh one.
  execFileSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], {
    cwd: frontend, stdio: "pipe", timeout: 300_000,
  });
  if (!existsSync(join(dist, "index.html"))) throw new Error(`no production build at ${dist}`);

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const file = join(dist, url.pathname);
    // A real asset, or the one shell every other path resolves to — which is how
    // `nginx.conf` serves this app and is what makes the worker's navigation fallback the
    // thing under test rather than a 404 handler.
    const served = existsSync(file) && extname(file) ? file : join(dist, "index.html");
    res.writeHead(200, { "content-type": TYPES[extname(served)] ?? "application/octet-stream" });
    res.end(readFileSync(served));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the static server did not bind a port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const SESSION_MEMBER = {
  tenant_slug: "crusaders",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  user_id: "00000000-0000-0000-0000-000000000009",
  is_authenticated: true,
  is_admin: false,
};

const CODE = {
  code: "7K3M9XQ2RD5A",
  kind: "booking",
  expires_in_seconds: 900,
  court_number: 3,
  starts_at: "2099-01-01T17:00:00Z",
  doors: true,
  door_opens_at: "2099-01-01T16:30:00Z",
  door_closes_at: "2099-01-01T18:05:00Z",
};

const CONTACT = { phone: "021 555 0134", email: "info@crusaders.co.za" };

const DOOR = {
  doors: true,
  doors_shut: "none",
  timezone: "Africa/Johannesburg",
  policy: "booking_window",
  membership: "active",
  membership_detail: "active",
  is_club_admin: false,
  next_booking: {
    starts_at: "2099-01-01T17:00:00Z",
    ends_at: "2099-01-01T17:45:00Z",
    court_number: 3,
    door_opens_at: "2099-01-01T16:30:00Z",
    door_closes_at: "2099-01-01T18:05:00Z",
  },
  early_entry_minutes: 30,
  roster_max_entries: 48,
  contact: CONTACT,
  door_log_retention_days: 90,
  last_decision: null,
};

/** The API, for the warm visit only. Removed before anything is asserted offline. */
async function warmApi(page: import("@playwright/test").Page) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith("/whoami") ? SESSION_MEMBER
      : path.endsWith("/me/qr/generate") ? CODE
        : path.endsWith("/me/door") ? DOOR
          : path.endsWith("/me/door/history")
            ? { items: [], next_cursor: null, retention_days: 90, timezone: "Africa/Johannesburg" }
            : path.endsWith("/wallet")
              ? { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 50 }
              : null;
    if (body === null) return route.fulfill({ status: 501, contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

/** Registers the built worker and waits until it is the one answering this page's fetches. */
async function takeControl(page: import("@playwright/test").Page) {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return !!registration && !!navigator.serviceWorker.controller;
  }, undefined, { timeout: 20_000 });
}

/**
 * The warm visit, which is the only thing that can put anything in the local store: the
 * worker refuses to cache a single byte of member data, deliberately and permanently, so
 * everything the offline page knows was written by the page itself while it had signal.
 */
async function warmThenGoOffline(page: import("@playwright/test").Page, context: import("@playwright/test").BrowserContext) {
  await page.addInitScript(() => {
    window.localStorage.setItem("crusaders.mainframe.token", "e2e-token");
  });
  await warmApi(page);
  await page.goto(`${origin}/my-code`);
  await expect(page.getByLabel("Your code", { exact: true })).toHaveText(CODE.code);
  await takeControl(page);

  /*
    A RETURNING visit, and it is not padding.

    The worker is registered by the page it is registered from, so the bundle that first
    visit pulled down never passed through its fetch handler and is in no cache. Only the
    next navigation's assets reach the worker, and `install` precaches the shell rather than
    the hashed chunks, which cannot be known when it is written. So the app a member opens
    with no signal is the app they had already opened at least twice with signal — which is
    every member who has ever used this at the club, and is the case D3 is about. A test
    that went offline after one visit would be asserting that a first-ever visitor can work
    offline, which is not true of any service worker and was never the claim.
  */
  await page.reload();
  await expect(page.getByLabel("Your code", { exact: true })).toHaveText(CODE.code);

  /*
    What the page managed to keep — BOTH halves, and waited for rather than sampled.

    This asserted only that the code had been stored, and the door record is written by a
    different read (`GET /me/door`) that resolves whenever it resolves. So a run where that
    read landed after the reload went offline with half a store, and the offline case failed
    on the door sentence — intermittently, and only in the full file, because running the case
    alone gave the read all the time it needed. That is the fixture being unfinished, not the
    page being wrong, and it cost this lane a `test.fail()` marker on a case that already
    passed.
  */
  const stored = await page.waitForFunction(() => {
    const raw = window.localStorage.getItem("crusaders.member-door.last-known");
    if (!raw) return null;
    const record = JSON.parse(raw) as { qr?: unknown; door?: unknown };
    return record.qr && record.door ? raw : null;
  }, undefined, { timeout: 15_000 }).then((handle) => handle.jsonValue());
  expect(stored, "the page stored nothing while it had signal").toContain(CODE.code);

  // Interception goes FIRST, so that nothing below can be answered by the harness. From
  // here the only things that can answer are the worker's caches and this browser profile.
  await page.unroute("**/api/**");
  await context.setOffline(true);
}

test("a production build registers its worker and serves the shell with no signal at all", async ({ page, context }) => {
  // The positive half, and the reason the rest of this file means anything: if the worker
  // never takes control, every assertion below would be about a page that had no business
  // rendering — and reviewer D's finding would stand as a product defect rather than as the
  // dev stack's missing worker.
  await warmThenGoOffline(page, context);

  await page.goto(`${origin}/my-code`);
  await expect(page).toHaveTitle(/Crusaders/);
  // Something of the app is on the screen — not the browser's dinosaur.
  await expect(page.locator("#root")).not.toBeEmpty();
});

/**
 * The whole of D3: a member standing at a locked door, out of signal, opening the app cold.
 *
 * <p>
 * Every one of these was on the screen a moment earlier and is now in a local store the
 * worker is forbidden to hold. What this asserts is that the page reaches for it — the code
 * itself, what the club's doors want, and a number that can be pressed — rather than
 * rendering three different ways of saying nothing.
 * </p>
 *
 * <p>
 * <b>It used to fail, and the failure was the finding.</b> `/my-code` was never reached:
 * `RequireAuth` in `src/App.tsx` reads `useAuth()`, `GET /api/v1/whoami` cannot be answered
 * with no signal, the state resolved to `offline`, and the whole route was replaced by
 * `ConnectionLost` — "Can't reach the club right now. You're still signed in." So the entire
 * last-known store, and every sentence on this surface built to be true without the club, was
 * unreachable by the one member it was written for. Each read failing individually was handled
 * well (D1, held in `my-code.spec.ts`); the app-wide gate in front of them was not, and it is
 * the gate a genuine cold start hits first.
 * </p>
 *
 * <p>
 * The member lane left this marked `test.fail()` because `App.tsx` and `lib/auth.tsx` are
 * app-wide: deciding when a session may be trusted without a server, on the strength of a token
 * in `localStorage`, is not a call one surface gets to make on its own. The chrome lane has now
 * made it, narrowly — see `OFFLINE_CAPABLE` in `App.tsx` — and the marker is gone.
 * </p>
 *
 */
test("a cold offline start shows the last code, says it is a remembered one, and offers a number to press", async ({ page, context }) => {
  await warmThenGoOffline(page, context);

  await page.goto(`${origin}/my-code`);

  // FIRST, so that a failure reads as the diagnosis rather than as a missing element: what
  // used to be on the screen is the app-wide connection notice, not this page.
  await expect(page.getByRole("heading", { name: /Can't reach the club/i })).toHaveCount(0);

  // The code, and the symbol, from the store rather than from a fetch that cannot happen.
  await expect(page.getByLabel("Your code", { exact: true })).toHaveText(CODE.code);
  await expect(page.getByRole("img", { name: new RegExp(`QR code ${CODE.code}`) })).toBeVisible();

  // It says the code is a remembered one rather than a fresh one, which is the difference
  // between a cache and a lie: a stored code is drawn from an ABSOLUTE expiry, so it can
  // run out on this screen and must never be presented as freshly minted.
  await expect(page.getByText(/no signal|can't reach|last (code|one)/i).first()).toBeVisible();

  // And a human, as a link a cold thumb can press in the dark rather than a number to
  // memorise. This is the one that was entirely absent when both reads failed.
  await expect(page.getByRole("link", { name: CONTACT.phone }).first())
    .toHaveAttribute("href", "tel:0215550134");
});

/**
 * The sentence that decides whether it is worth walking round to the other entrance.
 *
 * <p>
 * <b>Marked, and the marker names one expression in one file on one branch.</b> When BOTH
 * member reads have failed, `MyCode` short-circuits to `everythingFailed(…)` and returns
 * `<OfflinePage cached contact loading onTryAgain />` — a reduced page carrying the code, its
 * staleness sentence and the club's number, and nothing about doors. `everythingFailed` itself
 * is byte-identical on both branches; what differs is what that arm RENDERS. On
 * `claude/doors-r2-fe-member-fin3` it passes the door block and the door footer in as children
 * (D1: "the door section's existence must not depend on the code read"), and that is what puts
 * this sentence on the screen. It is `pages/MyCode.tsx`, the member lane's file, which this
 * lane is instructed not to touch.
 * </p>
 *
 * <p>
 * <b>It is not enough that the store holds the answer, and this is the trap worth recording.</b>
 * It does: `doorFacts` already falls back to `remembered?.value.doors === true`, and the record
 * is in `localStorage` with `doors: true` at the moment of the assertion — verified by printing
 * it. Running this case ALONE passes for that reason, three times out of three, which is the
 * test winning a race against the failure state rather than the feature existing. It is only
 * once the code read has actually failed and `error` is set that the page takes the arm that
 * drops the block. A reduced page reached by a different route is the thing to assert about.
 * </p>
 *
 * <p>
 * `test.fail()` rather than a skip, for the reason the member lane gave when the boot was on
 * the other foot: the case RUNS, and the day the two branches meet it turns green and Playwright
 * fails the run until this marker is deleted.
 * </p>
 */
test("a cold offline start also says what the club's doors need", async ({ page, context }) => {
  await warmThenGoOffline(page, context);

  await page.goto(`${origin}/my-code`);
  // The reduced page first, so a failure reads as "which arm rendered" rather than as a
  // missing element — this is the arm whose children the finding is about.
  await expect(page.getByText(/can't reach the club|last managed to get/i).first()).toBeVisible();
  await expect(page.getByText("What opens the door for you right now")).toBeVisible();
});
