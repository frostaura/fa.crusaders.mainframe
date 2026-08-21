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
