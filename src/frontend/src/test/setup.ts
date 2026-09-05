import "@testing-library/jest-dom/vitest";

// jsdom 28 delegates localStorage to Node's built-in, which is unavailable without
// --localstorage-file; back it with a plain in-memory store so tests get a working one.
const memoryStorage = (() => {
  let store = new Map<string, string>();
  const api: Storage = {
    get length() { return store.size; },
    clear: () => { store = new Map(); },
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => { store.delete(key); },
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
  };
  return api;
})();
for (const target of [globalThis, window]) {
  Object.defineProperty(target, "localStorage", {
    value: memoryStorage,
    writable: true,
    configurable: true,
  });
}

// jsdom has no EventSource, and `BalanceProvider` opens one against
// /api/v1/wallet/stream the moment a test signs in. Without this, any test that renders
// a page inside the balance provider dies on "EventSource is not defined" — a failure
// that reads as a broken page and is a missing browser API.
//
// Inert on purpose: it connects to nothing and never fires. A test that wants to prove
// something about the live balance push should drive `onmessage` on the instance it
// captures, rather than relying on this doing anything.
class InertEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readyState = InertEventSource.CONNECTING;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  constructor(url: string) { this.url = url; }
  addEventListener() { /* nothing arrives */ }
  removeEventListener() { /* nothing to remove */ }
  dispatchEvent() { return false; }
  close() { this.readyState = InertEventSource.CLOSED; }
}
if (!("EventSource" in globalThis)) {
  Object.defineProperty(globalThis, "EventSource", {
    value: InertEventSource, writable: true, configurable: true,
  });
}
