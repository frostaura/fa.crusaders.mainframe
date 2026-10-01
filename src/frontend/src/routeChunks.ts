import type { ComponentType } from "react";
import { whenApiQuiet } from "./lib/api";
import { prefetchRouteData } from "./lib/offline/memberReads";

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

/** The admin console's frame (`adminFrame`): not a member page, so it is not in `routeChunks`. */
export const loadAdminFrame = () => import("./adminFrame");

/** Looked up at call time, so a test can watch the loader. */
function hint(name: ChunkName) {
  routeChunks[name]().catch(() => undefined);
}


/**
 * At boot, once the session check is SENT (`main.tsx`): the opened page's code, then Bookings'.
 *
 * <p>
 * R4 (the first-Bookings regression, measured on :8088, slow 4G + 4x CPU): a member opening the
 * app on My Code and tapping Bookings as soon as the code showed waited 2.1 s, 1.4 s of it for
 * Bookings' ~30 files, because the tab bar's prefetch waited for sign-in, then 0.5 s, then an idle
 * callback — which on a busy phone came after the tap. Bookings is the next tap from every page,
 * so its code is asked for as soon as the opened page's own code and reads have settled — not
 * beside them; Wallet and Profile follow (`prefetchNavChunks`). Returns whether anything was
 * asked for.
 * </p>
 */
export function preloadAtSessionCheck(pathname: string, quiet: () => Promise<void> = whenApiQuiet, search = ""): boolean {
  if (!worthFetching()) return false;
  // The desk's console is its own chunk; a desk page is not where Bookings is the next tap.
  if (/^\/admin(\/|$)/.test(pathname)) return preloadRouteChunk(pathname);
  const current = BY_PATH.find(([pattern]) => pattern.test(pathname))?.[1];
  if (current) preloadRouteChunk(pathname);
  // P4-5 (R4 wave B) — and the opened page's own reads, beside its code rather than after it.
  // My Code has none here (its reads wait for the check, `useMemberCode`), so it pays nothing.
  prefetchRouteData(pathname, search);
  if (current === "schedule") return true;
  // Not beside the opened page's code and reads, but once they have settled: measured, asking for
  // Bookings' ~30 files beside the session check made a cold My Code — the page a member opens at
  // a locked door — 0.9 s slower (see `whenApiQuiet`).
  void quiet().then(() => { if (worthFetching()) hint("schedule"); });
  return true;
}

/** Start fetching the code of the page at `pathname`, if it is one of these. Returns whether it did. */
export function preloadRouteChunk(pathname: string): boolean {
  if (!worthFetching()) return false;
  if (/^\/admin(\/|$)/.test(pathname)) {
    loadAdminFrame().catch(() => undefined);
    return true;
  }
  const hit = BY_PATH.find(([pattern]) => pattern.test(pathname));
  if (!hit) return false;
  hint(hit[1]);
  return true;
}

/**
 * Once the phone is idle, fetch the tab bar's pages (and an admin's console). Returns a cancel.
 *
 * <p>
 * R4: each page after Bookings waits until the club's reads this tab has in flight have come back
 * (`quiet`) — a hint must not queue in front of the open page's own reads.
 * </p>
 */
export function prefetchNavChunks(delayMs = 500, admin = false, quiet: () => Promise<void> = whenApiQuiet): () => void {
  if (!worthFetching()) return () => undefined;
  let idle: number | null = null;
  let cancelled = false;
  const timer = window.setTimeout(() => {
    // One page at a time, Bookings first: all of them at once put ~50 files in front of the
    // member's own next tap on HTTP/1.1's six connections (measured: 1.2 s → 2.2 s).
    const run = async () => {
      for (const name of NAV_CHUNKS) {
        if (name !== "schedule") await quiet();
        if (cancelled || !worthFetching()) return;
        await routeChunks[name]().catch(() => undefined);
      }
      if (!admin) return;
      await quiet();
      if (!cancelled && worthFetching()) await loadAdminFrame().catch(() => undefined);
    };
    if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(() => void run(), { timeout: 4_000 });
    else void run();
  }, delayMs);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
    if (idle !== null && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
  };
}

/**
 * P4-5 (R4 wave B) — a member is about to open `to` (a nav link pressed, hovered or focused): its
 * code AND its reads start now, together, so the page arrives with both instead of fetching its
 * data only once its code has run. Hints only — nothing here is said to the member.
 */
export function routeIntent(to: string): void {
  if (!worthFetching()) return;
  const url = new URL(to, "http://intent.local");
  preloadRouteChunk(url.pathname);
  prefetchRouteData(url.pathname, url.search);
}

/** {@link routeIntent} as a link's props: pressed, hovered or focused. */
export function intentProps(to: string) {
  const go = () => routeIntent(to);
  return { onPointerDown: go, onMouseEnter: go, onFocus: go };
}
