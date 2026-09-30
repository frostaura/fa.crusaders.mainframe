import type { ComponentType } from "react";

/**
 * The member pages' code, by route — one loader per lazy page, shared by `App.tsx`'s `lazy()` and
 * by the two things that fetch a page's code before it is opened (perf lane, 2026-09-30):
 *
 * <ul>
 *   <li><b>{@link preloadRouteChunk}</b>, at boot: a cold start on `/bookings` fetched the entry,
 *   then `whoami`, and only then the Bookings chunk — three round trips in a row on a phone. With
 *   a session on the device the page's code is asked for BESIDE `whoami`.</li>
 *   <li><b>{@link prefetchNavChunks}</b>, once the member is signed in and the phone is idle: the
 *   tab bar's pages, so the first tap on Bookings or Wallet does not wait on a chunk (1.5 s of the
 *   2 s first Bookings visit on the slow profile was code, not data).</li>
 * </ul>
 *
 * <p>
 * Both are hints: a failure is swallowed (the real open goes through `loadChunk`, which explains
 * one), and neither runs offline or when the phone asks to save data.
 * </p>
 */
export const routeChunks: Record<"schedule" | "wallet" | "profile" | "bookingDetail" | "invites" | "inbox", () => Promise<{ default: ComponentType }>> = {
  schedule: () => import("./pages/Schedule"),
  wallet: () => import("./pages/Wallet"),
  profile: () => import("./pages/Profile"),
  bookingDetail: () => import("./pages/BookingDetail"),
  invites: () => import("./pages/Invites"),
  inbox: () => import("./pages/Inbox"),
};

type ChunkName = keyof typeof routeChunks;

/** Most specific first: `/bookings/invites` is its own page, not a booking id. */
const BY_PATH: readonly [RegExp, ChunkName][] = [
  [/^\/bookings\/invites\/?$/, "invites"],
  [/^\/bookings\/[^/]+\/?$/, "bookingDetail"],
  [/^\/bookings\/?$/, "schedule"],
  [/^\/wallet\/?$/, "wallet"],
  [/^\/profile\/?$/, "profile"],
  [/^\/inbox\/?$/, "inbox"],
];

/** The pages a member's tab bar leads to (My Code is in the entry already). */
const NAV_CHUNKS: readonly ChunkName[] = ["schedule", "wallet", "profile"];

function worthFetching(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return navigator.onLine !== false && connection?.saveData !== true;
}

/** Looked up at call time, so a test can watch the loader. */
function hint(name: ChunkName) {
  routeChunks[name]().catch(() => undefined);
}

/** Start fetching the code of the page at `pathname`, if it is one of these. Returns whether it did. */
export function preloadRouteChunk(pathname: string): boolean {
  if (!worthFetching()) return false;
  const hit = BY_PATH.find(([pattern]) => pattern.test(pathname));
  if (!hit) return false;
  hint(hit[1]);
  return true;
}

/** Once the phone is idle, fetch the tab bar's pages. Returns a cancel for an unmount. */
export function prefetchNavChunks(delayMs = 1_500): () => void {
  if (!worthFetching()) return () => undefined;
  let idle: number | null = null;
  const timer = window.setTimeout(() => {
    const run = () => { if (worthFetching()) NAV_CHUNKS.forEach(hint); };
    if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(run, { timeout: 4_000 });
    else run();
  }, delayMs);
  return () => {
    window.clearTimeout(timer);
    if (idle !== null && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
  };
}
