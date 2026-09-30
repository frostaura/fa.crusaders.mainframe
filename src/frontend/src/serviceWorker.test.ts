import { describe, expect, it } from "vitest";
import { ORIGIN, loadServiceWorker, swRequest } from "./test/swHarness";

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

describe("a session ending takes the caches with it", () => {
  it("empties every cache the worker owns when the app says the session is over", async () => {
    const sw = loadServiceWorker();
    await sw.dispatchFetch(swRequest("/icon-192.png"));
    // Whatever an older worker left behind is included: this is the cache that leaked.
    const legacy = await sw.caches.open("crusaders-api-v1");
    await legacy.put(`${ORIGIN}/api/v1/wallet`, new Response("alice", { status: 200 }));
    expect(sw.caches.storedUrls().length).toBeGreaterThan(0);

    const event = await sw.dispatchMessage({ type: "CLEAR_CACHES" });

    expect(await sw.caches.keys()).toEqual([]);
    expect(sw.caches.storedUrls()).toEqual([]);
    expect(event.delivered).toEqual([{ type: "CACHES_CLEARED" }]);
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
    const assets = await (await sw.caches.open("crusaders-assets-v3")).keys();
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

  it("fetches what a member's pages need first, and the desk's pages after (perf round)", async () => {
    const sw = loadServiceWorker({
      "/index.html": () => new Response(INDEX, { status: 200 }),
      "/precache.json": () => new Response(JSON.stringify({
        assets: ["/assets/AdminLedger-FFFF.js", "/assets/Schedule-DDDD.js", "/assets/Wallet-CCCC.js", "/assets/AdminMembers-GGGG.js"],
        first: ["/assets/Schedule-DDDD.js", "/assets/Wallet-CCCC.js"],
      }), { status: 200 }),
    });
    await sw.install();
    const order = sw.networkCalls.map((r) => new URL(r.url, ORIGIN).pathname).filter((p) => p.startsWith("/assets/"));
    const lastMember = Math.max(...["/assets/index-AAAA.js", "/assets/Schedule-DDDD.js", "/assets/Wallet-CCCC.js"].map((p) => order.indexOf(p)));
    const firstDesk = Math.min(...["/assets/AdminLedger-FFFF.js", "/assets/AdminMembers-GGGG.js"].map((p) => order.indexOf(p)));
    expect(lastMember).toBeGreaterThanOrEqual(0);
    expect(firstDesk).toBeGreaterThan(lastMember);
    // Still every chunk on the phone by the end of install (F4.3).
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
