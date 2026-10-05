import { describe, expect, it } from "vitest";
import { ORIGIN, loadServiceWorker, swRequest } from "./test/swHarness";

/**
 * R16 X16-2 — the last build's files are removed only once THIS build's are all on the phone.
 *
 * <p>
 * `finishInstall` fetched the rest of the build (`precacheRest`) and then purged every earlier
 * build's asset cache. With no signal, `precache.json` did not read, so the list was empty, nothing
 * was "missing", the purge ran anyway — and the run counted as done, so no later navigation tried
 * again. A phone that updated on the way out of the club's WiFi kept neither build's pages. The purge
 * now waits for a list that was READ and a cache that holds every file on it; anything short of that
 * leaves the earlier build where it is and lets the next navigation try again.
 * </p>
 */

const INDEX = '<script type="module" src="/assets/index-BBBB.js"></script>';
const EARLIER = "crusaders-assets-aaaaaaaaaaaa";
const LIST = {
  assets: ["/assets/index-BBBB.js", "/assets/Wallet-CCCC.js", "/assets/AdminLedger-FFFF.js"],
  first: ["/assets/Wallet-CCCC.js"],
};

/** A phone whose signal the test switches, and one desk chunk that may refuse to arrive. */
function phone() {
  const state = { listOnline: true, deskChunkOnline: true };
  const offline = () => Promise.reject(new TypeError("Failed to fetch"));
  const sw = loadServiceWorker({
    "/index.html": () => new Response(INDEX, { status: 200 }),
    "/precache.json": () => (state.listOnline ? new Response(JSON.stringify(LIST), { status: 200 }) : offline()),
    "/assets/AdminLedger-FFFF.js": () => (state.deskChunkOnline ? new Response("ledger", { status: 200 }) : offline()),
  }, { build: "bbbbbbbbbbbb" });
  return { sw, state };
}

async function withEarlierBuild(sw: ReturnType<typeof phone>["sw"]) {
  const earlier = await sw.caches.open(EARLIER);
  await earlier.put(`${ORIGIN}/assets/Wallet-OLD1.js`, new Response("old wallet", { status: 200 }));
}

describe("the earlier build's assets go only once this build's are all cached (R16 X16-2)", () => {
  it("the list cannot be read after install: the earlier build stays, and the next navigation finishes the job", async () => {
    const { sw, state } = phone();
    await withEarlierBuild(sw);
    await sw.install();
    state.listOnline = false; // signal lost between install and the rest
    await sw.activate();
    await sw.background();
    expect(await sw.caches.keys(), "purged on an unread list").toContain(EARLIER);

    state.listOnline = true;
    await sw.dispatchFetch(swRequest("/bookings", { mode: "navigate" }));
    expect(await sw.caches.keys(), "the retry ran and purged").not.toContain(EARLIER);
    expect(sw.caches.storedUrls()).toContain(`${ORIGIN}/assets/AdminLedger-FFFF.js`);
  });

  it("one listed file does not arrive: the earlier build stays until it does", async () => {
    const { sw, state } = phone();
    await withEarlierBuild(sw);
    state.deskChunkOnline = false;
    await sw.install();
    await sw.activate();
    await sw.background();
    expect(await sw.caches.keys(), "purged with a gap left").toContain(EARLIER);

    state.deskChunkOnline = true;
    await sw.dispatchFetch(swRequest("/wallet", { mode: "navigate" }));
    expect(sw.caches.storedUrls()).toContain(`${ORIGIN}/assets/AdminLedger-FFFF.js`);
    expect(await sw.caches.keys()).not.toContain(EARLIER);
  });

  it("everything arrives: the purge runs once, and later navigations do not ask for the list again", async () => {
    const { sw } = phone();
    await withEarlierBuild(sw);
    await sw.install();
    await sw.activate();
    await sw.background();
    expect(await sw.caches.keys()).not.toContain(EARLIER);
    const before = sw.networkCalls.filter((r) => new URL(r.url, ORIGIN).pathname === "/precache.json").length;
    await sw.dispatchFetch(swRequest("/bookings", { mode: "navigate" }));
    const after = sw.networkCalls.filter((r) => new URL(r.url, ORIGIN).pathname === "/precache.json").length;
    expect(after).toBe(before);
  });
});
