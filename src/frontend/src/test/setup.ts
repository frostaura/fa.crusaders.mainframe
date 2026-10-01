import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// findBy* and waitFor give up after 3 s rather than Testing Library's 1 s. A passing assertion
// returns the moment it holds, so a quiet run is no slower; what the margin buys is a run that
// shares the machine — vitest's own workers, a parallel backend suite, another agent's build —
// where a page that settles in 200 ms can take over a second, and a 1 s wait fails a test with
// nothing wrong (settings-door-validation did, 2026-09-28). No test here relies on a wait
// timing out.
configure({ asyncUtilTimeout: 3_000 });

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

// Radix, cmdk and react-day-picker call browser APIs jsdom does not implement. Each polyfill is
// installed ONLY where the API is absent, so a test that stubs its own still wins, and each is
// inert: nothing is measured, captured or scrolled, because jsdom lays nothing out.
//
// - Pointer capture: Radix Select/Slider call `hasPointerCapture` on pointerdown and throw
//   "is not a function" without it — which reads as a broken component, not a missing API.
// - `scrollIntoView`: Radix Select and cmdk scroll the active option into view.
// - `ResizeObserver`: Radix Popper (every popover, select, menu, tooltip) and cmdk observe sizes.
//   It never fires — recharts' `ResponsiveContainer` stays a 0×0 box, which `Charts.test.tsx`
//   depends on (it reads the element tree, not pixels).
// - `DOMRect.fromRect`: floating-ui builds rects with it.
const elementProto = window.Element.prototype as unknown as Record<string, unknown>;
const inertMethods: Record<string, () => unknown> = {
  hasPointerCapture: () => false,
  setPointerCapture: () => undefined,
  releasePointerCapture: () => undefined,
  scrollIntoView: () => undefined,
};
for (const [name, impl] of Object.entries(inertMethods)) {
  if (typeof elementProto[name] !== "function") {
    Object.defineProperty(elementProto, name, { value: impl, writable: true, configurable: true });
  }
}

class InertResizeObserver {
  observe() { /* jsdom lays nothing out, so nothing ever resizes */ }
  unobserve() { /* nothing observed */ }
  disconnect() { /* nothing to disconnect */ }
}
if (typeof globalThis.ResizeObserver !== "function") {
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: InertResizeObserver, writable: true, configurable: true,
  });
}

if (typeof DOMRect === "function" && typeof (DOMRect as { fromRect?: unknown }).fromRect !== "function") {
  Object.defineProperty(DOMRect, "fromRect", {
    value: (r: DOMRectInit = {}) => new DOMRect(r.x ?? 0, r.y ?? 0, r.width ?? 0, r.height ?? 0),
    writable: true, configurable: true,
  });
}

// `matchMedia`: absent in jsdom. Installed so `useTheme()`'s OS listener and anything Radix asks
// has something to call. It answers `matches: false` to every query — light scheme, no reduced-
// motion preference, no hover — which is what `useCountUp` already assumed from a missing API.
// `useWalletLive` read a missing API as "do not animate"; the full suite was run with this stub
// in place and stayed green, and a test that needs either preference stubs `matchMedia` itself
// (see `lib/theme.test.tsx`), which this never overrides.
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// R3-3 — the club's remembered zone is module state, so it outlives a test.
//
// `lib/clubZone` holds the zone the club last mentioned, and vitest isolates modules per test
// FILE, not per test. One test formatting with an explicit `Pacific/Auckland` would otherwise
// leave every later test in that file reading Auckland midnights — which is exactly the class
// of hidden input the clock gotchas in MEMORY.md are about. Cleared before each test so a
// formatter with no zone of its own behaves the same however it was reached.
import { beforeEach } from "vitest";
import { forgetClubZone } from "../lib/clubZone";

beforeEach(() => { forgetClubZone(); });

// R3-26 — and the same for what has already been ANNOUNCED.
//
// `lib/announce` deliberately remembers across remounts, so a standing banner behind a poll
// says itself once rather than twelve times. That memory is module state, so without this one
// test's announcement silences the next test's identical one — and the failure reads as a
// component that does not announce.
import { resetStandingAnnouncements } from "../lib/announce";

beforeEach(() => { resetStandingAnnouncements(); });

// D1 — the member code's key store falls back to module memory where there is no IndexedDB
// (jsdom), so, like the club's zone, it would outlive a test. A key left by one test is a code
// the next one renders without ever enrolling.
import { wipeMemberCode } from "../lib/memberCode/keyStore";

beforeEach(async () => { await wipeMemberCode(); });

// R4 wave B — the member query cache (`lib/offline`) is module memory too: a read one test made
// would draw the next test's page instantly, before its own stub had answered anything.
import { resetQueryCacheForTests } from "../lib/offline/queryCache";

beforeEach(() => { resetQueryCacheForTests(); });
