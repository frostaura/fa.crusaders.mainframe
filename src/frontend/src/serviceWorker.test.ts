import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ORIGIN, loadServiceWorker, swRequest, type SwSandbox } from "./test/swHarness";
import { SW_BUILD_PLACEHOLDER, stampServiceWorker } from "./swBuild";

/** The one asset cache a worker has made (its name carries the build). */
function assetCacheOf(sw: SwSandbox): string {
  const names = [...sw.caches.stores.keys()].filter((n) => n.startsWith("crusaders-assets-"));
  expect(names).toHaveLength(1);
  return names[0];
}

/**
 * E-F06 — the offline cache must not bleed between members on a shared device.
 *
 * <p>
 * The shipped worker cached /api/v1/wallet, /api/v1/me/profile and /api/v1/whoami
 * stale-while-revalidate. The Cache API keys on the request URL and ignores the Authorization
 * header, and CacheStorage belongs to the browser profile rather than to a login — so on a club
 * desk tablet the second member to open /wallet was shown the first member's balance and
 * ledger, and a cached /whoami could boot the app under the first member's identity and
 * is_admin flag. The only thing that cleared it was the deliberate Sign-out button, which is
 * not how a session on a shared device ends.
 * </p>
 *
 * <p>
 * These run the REAL `public/sw.js` in a sandbox whose Cache implementation keys on URL alone —
 * that is the defect, modelled, not a simplification. The shipped tests matched strings against
 * the source and would have passed against the leaking version unchanged.
 * </p>
 *
 * <p>
 * A model is still a model. The unmodelled version of the same claim — a real
 * `navigator.serviceWorker.register`, the browser's own Cache API, two members reading one URL
 * over real HTTP — is `e2e/service-worker.spec.ts`. Keep both: this one runs on every commit,
 * that one answers "but is the browser really like that?".
 * </p>
 */

/** Every authenticated GET the app makes. None of these may ever be stored. */
const MEMBER_DATA_PATHS = [
  "/api/v1/wallet",
  "/api/v1/wallet/ledger",
  "/api/v1/wallet/stream",
  "/api/v1/me/profile",
  "/api/v1/whoami",
  "/api/v1/schedule",
  "/api/v1/bookings",
  "/api/v1/admin/members",
  "/api/v1/admin/ledger",
];

const ALICE = "Bearer alice.token";
const BOB = "Bearer bob.token";

describe("no member data is ever cached", () => {
  it("stores nothing for any authenticated API read, however many times it is asked", async () => {
    const sw = loadServiceWorker();

    for (const path of MEMBER_DATA_PATHS) {
      await sw.dispatchFetch(swRequest(path, { authorization: ALICE }));
      await sw.dispatchFetch(swRequest(path, { authorization: ALICE }));
    }

    const stored = sw.caches.storedUrls();
    expect(stored.filter((url) => new URL(url).pathname.startsWith("/api/"))).toEqual([]);
    expect(stored).toEqual([]);
  });

  it("does not intercept API reads at all, so nothing can be served from a cache", async () => {
    const sw = loadServiceWorker();
    for (const path of MEMBER_DATA_PATHS) {
      const event = await sw.dispatchFetch(swRequest(path, { authorization: ALICE }));
      expect(event.responded, `${path} was intercepted by the worker`).toBe(false);
    }
  });

  it("hands the next member the network, not the last member's wallet", async () => {
    // The leak, staged exactly: a cache already holding Alice's wallet, and Bob asking for his.
    // The URLs are identical and the Cache API cannot tell them apart, so the only defence is
    // that the worker does not look.
    const sw = loadServiceWorker({
      "/api/v1/wallet": () => new Response(JSON.stringify({ member: "bob", balance: 0 }), { status: 200 }),
    });
    const poisoned = await sw.caches.open("crusaders-api-v2");
    await poisoned.put(
      `${ORIGIN}/api/v1/wallet`,
      new Response(JSON.stringify({ member: "alice", balance: 412.5 }), { status: 200 }),
    );

    const event = await sw.dispatchFetch(swRequest("/api/v1/wallet", { authorization: BOB }));

    // Not intercepted at all: Bob's own fetch goes to the API, which authorises it as Bob.
    // Under the shipped worker this event was answered from `poisoned` with Alice's body.
    expect(event.responded).toBe(false);
    expect(await event.response()).toBeNull();
    // The stale entry is not read and not refreshed — the store is exactly as it was left.
    expect(sw.caches.storedUrls()).toEqual([`${ORIGIN}/api/v1/wallet`]);
    expect(await (await poisoned.match(`${ORIGIN}/api/v1/wallet`))!.text()).toContain("alice");
  });

  it("refuses to cache a credentialed request even on a path it otherwise caches", async () => {
    // The chokepoint, not the path list. An icon is cacheable; an icon fetched with a bearer
    // token is a request carrying a credential, and nothing carrying a credential is stored.
    const sw = loadServiceWorker();

    const anonymous = await sw.dispatchFetch(swRequest("/icon-192.png"));
    expect(anonymous.responded).toBe(true);
    expect(sw.caches.storedUrls()).toEqual([`${ORIGIN}/icon-192.png`]);

    const sw2 = loadServiceWorker();
    const credentialed = await sw2.dispatchFetch(swRequest("/icon-192.png", { authorization: ALICE }));
    expect(credentialed.responded).toBe(true);
    expect(sw2.caches.storedUrls()).toEqual([]);
  });

  it("refuses to cache a response the server marked private or no-store", async () => {
    const sw = loadServiceWorker({
      "/favicon.svg": () => new Response("<svg/>", { status: 200, headers: { "cache-control": "private, no-store" } }),
    });
    await sw.dispatchFetch(swRequest("/favicon.svg"));
    expect(sw.caches.storedUrls()).toEqual([]);
  });
});

describe("a session ending takes the caches with it — all but the shell (M5-1)", () => {
  it("deletes every cache that is not the shell when the app says the session is over", async () => {
    const sw = loadServiceWorker({}, { build: "0123456789abcdef" });
    await sw.install();
    await sw.dispatchFetch(swRequest("/icon-192.png"));
    await sw.dispatchFetch(swRequest("/assets/index-abc123.js"));
    // Whatever an older worker left behind is included: this is the cache that leaked.
    const legacy = await sw.caches.open("crusaders-api-v1");
    await legacy.put(`${ORIGIN}/api/v1/wallet`, new Response("alice", { status: 200 }));

    const event = await sw.dispatchMessage({ type: "CLEAR_CACHES" });

    expect((await sw.caches.keys()).sort()).toEqual(["crusaders-assets-0123456789abcdef", "crusaders-shell-0123456789abcdef"]);
    expect(sw.caches.storedUrls().filter((url) => url.includes("/api/"))).toEqual([]);
    expect(event.delivered).toEqual([{ type: "CACHES_CLEARED" }]);
  });

  it("still opens offline after a session has ended: the shell is served with no signal (M5-1)", async () => {
    // A lapse or a sign-out used to empty the shell too, and the next cold start with no signal
    // was the browser's own ERR_FAILED — My Code included, at the door.
    let online = true;
    const sw = loadServiceWorker({
      "/my-code": () => {
        if (!online) throw new TypeError("Failed to fetch");
        return new Response("<!doctype html><title>Crusaders</title>", { status: 200 });
      },
    });
    await sw.install();
    await sw.dispatchFetch(swRequest("/my-code", { mode: "navigate" }));

    await sw.dispatchMessage({ type: "CLEAR_CACHES" });
    online = false;
    const cold = await sw.dispatchFetch(swRequest("/my-code", { mode: "navigate" }));

    expect(await (await cold.response())!.text()).toContain("Crusaders");
  });

  it("lets a precache in flight finish when a session ends: the shell holds no member data", async () => {
    let signedOut: Promise<unknown> | null = null;
    const sw: ReturnType<typeof loadServiceWorker> = loadServiceWorker({
      "/index.html": () => new Response('<script type="module" src="/assets/index-AAAA.js"></script>', { status: 200 }),
      "/precache.json": () => new Response(JSON.stringify({
        assets: Array.from({ length: 12 }, (_, i) => `/assets/Admin${i}-FFFF.js`), first: [],
      }), { status: 200 }),
      // The member signs out while the desk's pages are being fetched after activation.
      "/assets/Admin0-FFFF.js": () => {
        signedOut ??= sw.dispatchMessage({ type: "CLEAR_CACHES" });
        return new Response("chunk", { status: 200 });
      },
    });
    await sw.install();
    await sw.activate();
    await signedOut;
    expect(sw.caches.storedUrls().filter((u) => u.includes("/assets/Admin"))).toHaveLength(12);
  });

  it("stores nothing more once the page itself has deleted the caches mid-precache (perf round)", async () => {
    let deleted = false;
    const sw: ReturnType<typeof loadServiceWorker> = loadServiceWorker({
      "/index.html": () => new Response('<script type="module" src="/assets/index-AAAA.js"></script>', { status: 200 }),
      "/precache.json": () => new Response(JSON.stringify({
        assets: Array.from({ length: 12 }, (_, i) => `/assets/Admin${i}-FFFF.js`), first: [],
      }), { status: 200 }),
      // `lib/pwa`'s page half of a sign-out: the caches deleted from the page, no message.
      "/assets/Admin0-FFFF.js": () => {
        if (!deleted) { deleted = true; for (const name of [...sw.caches.stores.keys()]) sw.caches.stores.delete(name); }
        return new Response("chunk", { status: 200 });
      },
    });
    await sw.install();
    await sw.activate();
    expect(sw.caches.storedUrls().filter((u) => u.includes("/assets/Admin"))).toEqual([]);
  });

  it("deletes the leaking cache of an earlier worker the moment the new one activates", async () => {
    // Devices that already ran the shipped version are carrying member data right now. Nobody
    // is going to sign out to clean it up, so activation has to.
    const sw = loadServiceWorker();
    const legacy = await sw.caches.open("crusaders-api-v1");
    await legacy.put(`${ORIGIN}/api/v1/wallet`, new Response("alice's balance", { status: 200 }));
    await sw.caches.open("crusaders-shell-v1");

    await sw.activate();

    expect(await sw.caches.keys()).not.toContain("crusaders-api-v1");
    expect(await sw.caches.keys()).not.toContain("crusaders-shell-v1");
    expect(sw.caches.storedUrls()).toEqual([]);
    expect(sw.claimed()).toBe(true);
  });
});

describe("the offline shell survives the fix", () => {
  it("serves a hashed build asset from cache on the second ask", async () => {
    const sw = loadServiceWorker();
    const asset = swRequest("/assets/index-abc123.js");

    await sw.dispatchFetch(asset);
    await sw.dispatchFetch(asset);

    expect(sw.networkCalls).toHaveLength(1);
    expect(sw.caches.storedUrls()).toEqual([`${ORIGIN}/assets/index-abc123.js`]);
  });

  it("falls back to the cached shell when a navigation cannot reach the club", async () => {
    let online = true;
    const sw = loadServiceWorker({
      "/wallet": () => {
        if (!online) throw new TypeError("Failed to fetch");
        return new Response("<!doctype html><title>Crusaders</title>", { status: 200 });
      },
    });

    await sw.dispatchFetch(swRequest("/wallet", { mode: "navigate" }));
    online = false;
    const offline = await sw.dispatchFetch(swRequest("/wallet", { mode: "navigate" }));

    expect(offline.responded).toBe(true);
    expect(await (await offline.response())!.text()).toContain("Crusaders");
  });
});

/**
 * P5-1 (review round 5) — a navigation that STALLS, not fails. On one bar of signal (LiE-Fi) the
 * request neither answers nor errors, and network-first waited for it: My Code drew nothing for
 * 20 s+ while its shell and data sat on the phone. The worker now races the network against
 * {@link NAV_WAIT_MS} and serves the cached shell when the network has not answered by then.
 */
const NAV_WAIT_MS = 2_000;

describe("a stalled navigation falls back to the cached shell (P5-1)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("serves the shell it holds once the network has said nothing for ~2 s, and keeps listening", async () => {
    let stalled = false;
    let answer: ((response: Response) => void) | null = null;
    const sw = loadServiceWorker({
      "/my-code": () => (stalled
        ? new Promise<Response>((resolve) => { answer = resolve; })
        : new Response("<!doctype html><title>shell v1</title>", { status: 200 })),
    });
    await sw.dispatchFetch(swRequest("/my-code", { mode: "navigate" }));

    vi.useFakeTimers();
    stalled = true;
    const event = await sw.dispatchFetch(swRequest("/my-code", { mode: "navigate" }), { settle: false });
    let served: Response | null = null;
    void event.response().then((response) => { served = response; });

    await vi.advanceTimersByTimeAsync(NAV_WAIT_MS - 100);
    expect(served, "it gave up on the network too early").toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(served, "the stalled navigation was still waiting on the network").not.toBeNull();
    expect(await served!.text()).toContain("shell v1");

    // The network answering late still refreshes the shell for the next start.
    answer!(new Response("<!doctype html><title>shell v2</title>", { status: 200 }));
    await event.settle();
    vi.useRealTimers();
    stalled = false;
    const cached = await sw.caches.match("/index.html");
    expect(await cached!.text()).toContain("shell v2");
  });

  it("waits for the network when it has no shell to fall back to", async () => {
    vi.useFakeTimers();
    let answer: ((response: Response) => void) | null = null;
    const sw = loadServiceWorker({
      "/my-code": () => new Promise<Response>((resolve) => { answer = resolve; }),
    });
    const event = await sw.dispatchFetch(swRequest("/my-code", { mode: "navigate" }), { settle: false });
    let served: Response | null = null;
    void event.response().then((response) => { served = response; });
    await vi.advanceTimersByTimeAsync(NAV_WAIT_MS * 3);
    expect(served).toBeNull();
    answer!(new Response("<!doctype html><title>late</title>", { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await served!.text()).toContain("late");
  });

  it("serves the network's answer when it comes in time, with no timer left behind", async () => {
    vi.useFakeTimers();
    const sw = loadServiceWorker({
      "/my-code": () => new Response("<!doctype html><title>fresh</title>", { status: 200 }),
    });
    const event = await sw.dispatchFetch(swRequest("/my-code", { mode: "navigate" }), { settle: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(await (await event.response())!.text()).toContain("fresh");
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * F4.3 — every page's code is on the phone before it is needed.
 *
 * <p>
 * The worker used to precache only what `index.html` names — the entry — so a page a member had
 * never opened with signal had no code on the phone, and opening it with none crashed into the
 * generic error screen. The build now writes `precache.json` (every JS and CSS chunk); install
 * fetches it and caches every `/assets/` path it lists, and nothing else it might say.
 * </p>
 */
describe("install precaches every chunk the build lists", () => {
  const INDEX = '<script type="module" src="/assets/index-AAAA.js"></script><link rel="stylesheet" href="/assets/index-BBBB.css">';

  it("caches the entry and every listed lazy chunk", async () => {
    const sw = loadServiceWorker({
      "/index.html": () => new Response(INDEX, { status: 200 }),
      "/precache.json": () => new Response(JSON.stringify({
        assets: ["/assets/Wallet-CCCC.js", "/assets/Schedule-DDDD.js", "/assets/Schedule-EEEE.css"],
      }), { status: 200 }),
    });
    await sw.install();
    const assets = await (await sw.caches.open(assetCacheOf(sw))).keys();
    expect(assets.sort()).toEqual([
      "/assets/Schedule-DDDD.js", "/assets/Schedule-EEEE.css", "/assets/Wallet-CCCC.js",
      "/assets/index-AAAA.js", "/assets/index-BBBB.css",
    ].map((p) => `${ORIGIN}${p}`).sort());
  });

  it("takes only /assets/ paths from the list, whatever else it names", async () => {
    const sw = loadServiceWorker({
      "/index.html": () => new Response(INDEX, { status: 200 }),
      "/precache.json": () => new Response(JSON.stringify({
        assets: ["/api/v1/wallet", "https://elsewhere.example/assets/x.js", "/assets/../sw.js", "/assets/Ok-1234.js"],
      }), { status: 200 }),
    });
    await sw.install();
    const stored = sw.caches.storedUrls();
    expect(stored).toContain(`${ORIGIN}/assets/Ok-1234.js`);
    expect(stored.some((u) => u.includes("/api/"))).toBe(false);
    expect(stored.some((u) => u.includes("elsewhere") || u.endsWith("/sw.js"))).toBe(false);
  });

  it("installs with what a member's pages need, and fetches the desk's pages once in control (perf round)", async () => {
    const sw = loadServiceWorker({
      "/index.html": () => new Response(INDEX, { status: 200 }),
      "/precache.json": () => new Response(JSON.stringify({
        assets: ["/assets/AdminLedger-FFFF.js", "/assets/Schedule-DDDD.js", "/assets/Wallet-CCCC.js", "/assets/AdminMembers-GGGG.js"],
        first: ["/assets/Schedule-DDDD.js", "/assets/Wallet-CCCC.js"],
      }), { status: 200 }),
    });
    await sw.install();
    expect(sw.caches.storedUrls()).not.toContain(`${ORIGIN}/assets/AdminLedger-FFFF.js`);
    await sw.activate();
    const order = sw.networkCalls.map((r) => new URL(r.url, ORIGIN).pathname).filter((p) => p.startsWith("/assets/"));
    const lastMember = Math.max(...["/assets/index-AAAA.js", "/assets/Schedule-DDDD.js", "/assets/Wallet-CCCC.js"].map((p) => order.indexOf(p)));
    const firstDesk = Math.min(...["/assets/AdminLedger-FFFF.js", "/assets/AdminMembers-GGGG.js"].map((p) => order.indexOf(p)));
    expect(lastMember).toBeGreaterThanOrEqual(0);
    expect(firstDesk).toBeGreaterThan(lastMember);
    // Still every chunk on the phone once it is in control (F4.3).
    expect(sw.caches.storedUrls()).toEqual(expect.arrayContaining(
      ["/assets/AdminLedger-FFFF.js", "/assets/AdminMembers-GGGG.js", "/assets/Schedule-DDDD.js"].map((p) => `${ORIGIN}${p}`)));
  });

  it("still installs, with the entry, when the list is missing", async () => {
    const sw = loadServiceWorker({
      "/index.html": () => new Response(INDEX, { status: 200 }),
      "/precache.json": () => new Response("not found", { status: 404 }),
    });
    await sw.install();
    expect(sw.caches.storedUrls()).toContain(`${ORIGIN}/assets/index-AAAA.js`);
  });
});

/**
 * P4-2 / P4-3 (review round 4, performance lens) — a deploy reaches the phone.
 *
 * <p>
 * The worker was byte-identical across deploys (`VERSION = "v3"`), so no deploy ever installed a
 * new one: the new build's chunks were never precached, and `crusaders-assets-v3` gathered every
 * build's files for ever. And the shell was fetched through the HTTP cache, which held an
 * `index.html` without a Cache-Control header heuristically for hours — naming the last build's
 * files. The build now stamps its id into the worker; each build's worker owns caches named for
 * it, reuses what the last build already cached, and removes the last build's on activate.
 * </p>
 */
describe("a new build replaces the last one", () => {
  const INDEX_A = '<script type="module" src="/assets/index-AAAA.js"></script>';
  const INDEX_B = '<script type="module" src="/assets/index-BBBB.js"></script>';

  it("ships with exactly one build placeholder, and the stamp replaces it", () => {
    const source = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");
    expect(source.split(SW_BUILD_PLACEHOLDER)).toHaveLength(2);
    const stamped = stampServiceWorker(source, "b2b2b2b2b2b2");
    expect(stamped).toContain('const BUILD = "b2b2b2b2b2b2"');
    expect(stamped).not.toContain(SW_BUILD_PLACEHOLDER);
    expect(() => stampServiceWorker(stamped, "b3b3b3b3b3b3")).toThrow(/exactly once/);
    expect(() => stampServiceWorker(source, "../evil")).toThrow(/build id/);
  });

  it("names its caches after its build, and on activate keeps nothing of the last build's", async () => {
    // The last build's worker, installed and running, on a device a member has used.
    const a = loadServiceWorker({
      "/index.html": () => new Response(INDEX_A, { status: 200 }),
      "/precache.json": () => new Response(JSON.stringify({ assets: ["/assets/Same-1111.js", "/assets/Gone-2222.js"] }), { status: 200 }),
    }, { build: "aaaaaaaaaaaa" });
    await a.install();
    await a.activate();
    expect(await a.caches.keys()).toEqual(expect.arrayContaining(["crusaders-assets-aaaaaaaaaaaa", "crusaders-shell-aaaaaaaaaaaa"]));

    // The next build's worker, on the same device (the same CacheStorage).
    const b = loadServiceWorker({
      "/index.html": () => new Response(INDEX_B, { status: 200 }),
      "/precache.json": () => new Response(JSON.stringify({ assets: ["/assets/Same-1111.js", "/assets/New-3333.js"] }), { status: 200 }),
    }, { build: "bbbbbbbbbbbb" });
    for (const [name, store] of a.caches.stores) b.caches.stores.set(name, store);
    await b.install();
    await b.activate();

    expect((await b.caches.keys()).sort()).toEqual(["crusaders-assets-bbbbbbbbbbbb", "crusaders-shell-bbbbbbbbbbbb"]);
    const stored = b.caches.storedUrls();
    expect(stored).toEqual(expect.arrayContaining([
      `${ORIGIN}/assets/index-BBBB.js`, `${ORIGIN}/assets/Same-1111.js`, `${ORIGIN}/assets/New-3333.js`,
    ]));
    expect(stored.filter((u) => /index-AAAA|Gone-2222/.test(u)), "the last build's files are pruned").toEqual([]);
    expect(stored.filter((u) => new URL(u).pathname.startsWith("/api/")), "never member data").toEqual([]);
  });

  it("takes a file the last build already cached from that cache, not the network", async () => {
    const b = loadServiceWorker({
      "/index.html": () => new Response(INDEX_B, { status: 200 }),
      "/precache.json": () => new Response(JSON.stringify({ assets: ["/assets/Same-1111.js"] }), { status: 200 }),
    }, { build: "bbbbbbbbbbbb" });
    const earlier = await b.caches.open("crusaders-assets-aaaaaaaaaaaa");
    await earlier.put(`${ORIGIN}/assets/Same-1111.js`, new Response("same bytes", { status: 200 }));
    await b.install();
    const fetched = b.networkCalls.map((r) => new URL(r.url, ORIGIN).pathname);
    expect(fetched).not.toContain("/assets/Same-1111.js");
    expect(await (await (await b.caches.open("crusaders-assets-bbbbbbbbbbbb")).match(`${ORIGIN}/assets/Same-1111.js`))!.text()).toBe("same bytes");
  });

  it("never asks for a URL that is not on the list when the list is shorter than the lanes", async () => {
    const sw = loadServiceWorker({ "/index.html": () => new Response(INDEX_B, { status: 200 }) }, { build: "bbbbbbbbbbbb" });
    await sw.install();
    expect(sw.networkCalls.every((r) => r && !String(r.url).includes("undefined")), "a lane fetched `undefined`").toBe(true);
    expect(sw.caches.storedUrls().filter((u) => u.includes("undefined"))).toEqual([]);
  });

  it("asks for the shell and every navigation past the HTTP cache", async () => {
    const sw = loadServiceWorker({ "/index.html": () => new Response(INDEX_B, { status: 200 }) }, { build: "bbbbbbbbbbbb" });
    await sw.install();
    await sw.dispatchFetch(swRequest("/bookings", { mode: "navigate" }));
    const asked = sw.networkCalls.map((r, i) => ({ path: new URL(r.url, ORIGIN).pathname, cache: sw.networkInits[i]?.cache }));
    for (const path of ["/", "/index.html", "/theme-boot.js", "/manifest.webmanifest", "/precache.json", "/bookings"]) {
      const calls = asked.filter((c) => c.path === path);
      expect(calls.length, `${path} was never asked for`).toBeGreaterThan(0);
      for (const call of calls) expect(call.cache, `${path} went through the HTTP cache`).toBe("no-cache");
    }
  });
});

