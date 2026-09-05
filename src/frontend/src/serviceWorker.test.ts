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
