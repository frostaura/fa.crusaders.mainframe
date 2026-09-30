/**
 * Runs the REAL `public/sw.js` — the file the browser downloads — inside a sandbox that models
 * the two properties of the browser APIs that made the leak possible.
 *
 * <p>
 * The shipped version of these tests matched strings against the source, and string matching
 * cannot tell you what the worker DOES — it passed unchanged against a worker that served one
 * member's wallet to another. This evaluates the file, captures its listeners and drives real
 * fetch, message and activate events through them.
 * </p>
 *
 * <p>
 * This header used to say a service worker could not be registered in this repo's automation.
 * That was false: `e2e/service-worker.spec.ts` registers this same file in a real Chromium and
 * is where the unmodelled proof lives. This harness earns its place for a different reason —
 * it runs in `vitest`, which is the gate every change goes through, in milliseconds and with no
 * browser — so the rules below are checked on every commit rather than on every E2E run.
 * </p>
 *
 * <p>
 * The two modelled properties, both load-bearing:
 * </p>
 * <ul>
 *   <li><b>The Cache API keys on the request URL and ignores the Authorization header.</b>
 *       {@link FakeCache} therefore keys on the URL string alone. This is not a simplification —
 *       it is the defect. A cache that varied on the header would make the leak untestable.</li>
 *   <li><b>CacheStorage is scoped to the origin, not to a session.</b> One store, shared by every
 *       member who signs in on this browser profile.</li>
 * </ul>
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { stampServiceWorker } from "../swBuild";

export const ORIGIN = "https://club.example";

/** Enough of a `Request` for the worker: it reads url, method, mode and headers, nothing else. */
export type SwRequest = {
  url: string;
  method: string;
  mode: string;
  headers: Headers;
};

export function swRequest(
  path: string,
  init: { method?: string; mode?: string; authorization?: string } = {},
): SwRequest {
  const headers = new Headers();
  if (init.authorization) headers.set("authorization", init.authorization);
  return {
    url: new URL(path, ORIGIN).toString(),
    method: init.method ?? "GET",
    mode: init.mode ?? "cors",
    headers,
  };
}

const keyOf = (request: SwRequest | string): string =>
  new URL(typeof request === "string" ? request : request.url, ORIGIN).toString();

/** A Cache that keys on URL and nothing else — exactly as the browser's does. */
class FakeCache {
  readonly entries = new Map<string, Response>();

  async match(request: SwRequest | string): Promise<Response | undefined> {
    return this.entries.get(keyOf(request))?.clone();
  }

  async put(request: SwRequest | string, response: Response): Promise<void> {
    this.entries.set(keyOf(request), response);
  }

  async add(url: string): Promise<void> {
    throw new Error(`unstubbed cache.add(${url})`);
  }

  async delete(request: SwRequest | string): Promise<boolean> {
    return this.entries.delete(keyOf(request));
  }

  async keys(): Promise<string[]> {
    return [...this.entries.keys()];
  }
}

/** One store per origin, shared by every session on the device. */
class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    const existing = this.stores.get(name);
    if (existing) return existing;
    const created = new FakeCache();
    this.stores.set(name, created);
    return created;
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }

  async has(name: string): Promise<boolean> {
    return this.stores.has(name);
  }

  async match(request: SwRequest | string, options?: { cacheName?: string }): Promise<Response | undefined> {
    const names = options?.cacheName ? [options.cacheName] : [...this.stores.keys()];
    for (const name of names) {
      const hit = await this.stores.get(name)?.match(request);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Every stored URL across every cache — what the assertions actually look at. */
  storedUrls(): string[] {
    return [...this.stores.values()].flatMap((cache) => [...cache.entries.keys()]);
  }
}

class FakeExtendableEvent {
  readonly waited: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>): void {
    this.waited.push(Promise.resolve(promise));
  }
  async settle(): Promise<void> {
    await Promise.all(this.waited);
  }
}

export class FakeFetchEvent extends FakeExtendableEvent {
  responded = false;
  private answer: Promise<Response> | null = null;

  constructor(readonly request: SwRequest) {
    super();
  }

  respondWith(response: Response | Promise<Response>): void {
    this.responded = true;
    this.answer = Promise.resolve(response);
  }

  /** The response the page receives, or null when the worker did not intercept at all. */
  async response(): Promise<Response | null> {
    return this.answer ? await this.answer : null;
  }
}

export class FakeMessageEvent extends FakeExtendableEvent {
  readonly delivered: unknown[] = [];
  readonly source = { postMessage: (msg: unknown) => { this.delivered.push(msg); } };
  constructor(readonly data: unknown) {
    super();
  }
}

type Listener = (event: never) => void;

export type SwSandbox = {
  caches: FakeCacheStorage;
  /** Every request the worker passed to the network, in order. */
  networkCalls: SwRequest[];
  /** The `init` each of those was sent with (P4-2: how it asked the HTTP cache). */
  networkInits: (RequestInit | undefined)[];
  dispatchFetch(request: SwRequest): Promise<FakeFetchEvent>;
  dispatchMessage(data: unknown): Promise<FakeMessageEvent>;
  /** Runs the worker's `install` handler to completion (precache included). */
  install(): Promise<void>;
  activate(): Promise<void>;
  claimed: () => boolean;
};

/**
 * Loads `public/sw.js` and returns a handle on the running worker.
 *
 * @param routes maps a pathname to the response the network gives for it. A path with no entry
 *               answers 200 with its own name as the body, which is enough for identity
 *               assertions ("whose wallet came back?").
 */
export function loadServiceWorker(routes: Record<string, () => Response> = {}, options: { build?: string } = {}): SwSandbox {
  const shipped = readFileSync(resolve(__dirname, "../../public/sw.js"), "utf8");
  // P4-3: the build writes its id into the worker it ships; a test names the build it is running.
  const source = options.build ? stampServiceWorker(shipped, options.build) : shipped;
  const listeners = new Map<string, Listener[]>();
  const cacheStorage = new FakeCacheStorage();
  const networkCalls: SwRequest[] = [];
  const networkInits: (RequestInit | undefined)[] = [];
  let claimed = false;

  const fetchImpl = async (input: SwRequest | string, init?: RequestInit): Promise<Response> => {
    // The worker's own install fetches pass a bare path (`fetch("/index.html", …)`).
    const request = typeof input === "string" ? swRequest(input) : input;
    networkCalls.push(request);
    networkInits.push(init);
    const path = new URL(request.url, ORIGIN).pathname;
    const route = routes[path];
    return route ? route() : new Response(`network:${path}`, { status: 200 });
  };

  const self_ = {
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    location: new URL(ORIGIN),
    skipWaiting: async () => undefined,
    clients: { claim: async () => { claimed = true; } },
  };

  const context = vm.createContext({
    self: self_,
    caches: cacheStorage,
    fetch: fetchImpl,
    // `new Request("/assets/x.js")` resolves against the worker's origin in a browser; Node's
    // Request refuses a relative URL, so the sandbox hands back the same shape `swRequest` makes.
    Request: function SandboxRequest(url: string) { return swRequest(url); },
    URL,
    Response,
    Headers,
    console,
  });
  vm.runInContext(source, context, { filename: "sw.js" });

  const dispatch = async <E extends FakeExtendableEvent>(type: string, event: E): Promise<E> => {
    for (const listener of listeners.get(type) ?? []) (listener as (e: E) => void)(event);
    await event.settle();
    return event;
  };

  return {
    caches: cacheStorage,
    networkCalls,
    networkInits,
    async dispatchFetch(request) {
      const event = new FakeFetchEvent(request);
      await dispatch("fetch", event);
      // The worker's own cache writes happen inside the respondWith promise.
      await event.response().catch(() => null);
      return event;
    },
    dispatchMessage: (data) => dispatch("message", new FakeMessageEvent(data)),
    install: async () => { await dispatch("install", new FakeExtendableEvent()); },
    activate: async () => { await dispatch("activate", new FakeExtendableEvent()); },
    claimed: () => claimed,
  };
}
