import { lazy, useSyncExternalStore, type ComponentType } from "react";
import { loadChunk } from "./lib/chunkLoad";
import { whenApiQuiet } from "./lib/api";
import { prefetchMyInvites } from "./lib/earlyInvites";
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
export type ChunkName = "schedule" | "wallet" | "profile" | "bookingDetail" | "invites" | "inbox";

export const routeChunks: Record<ChunkName, () => Promise<{ default: ComponentType }>> = {
  schedule: () => noteChunk("schedule", import("./pages/Schedule")),
  wallet: () => noteChunk("wallet", import("./pages/Wallet")),
  profile: () => noteChunk("profile", import("./pages/Profile")),
  bookingDetail: () => noteChunk("bookingDetail", import("./pages/BookingDetail")),
  invites: () => noteChunk("invites", import("./pages/Invites")),
  inbox: () => noteChunk("inbox", import("./pages/Inbox")),
};

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
 *
 * <p>
 * <b>From My Code, once the code's own read is on its way (R6 X6-3).</b> "Settled" came too late
 * there: the chip's and the passkey list's reads were still out when the code showed, so a member
 * tapping Bookings at once fetched its ~30 files only at the tap (first session, slow profile:
 * p50 1.6 s). The code's read is the one thing the door page waits on, and once it has a socket the
 * files queue behind it, not in front of it — the code paints no later (A/B in `decisions-frontend-bundle`).
 * Whichever signal comes first asks, once.
 * </p>
 */
export function preloadAtSessionCheck(
  pathname: string, quiet: () => Promise<void> = whenApiQuiet, search = "", codeAsked: () => Promise<void> = whenCodeAsked,
): boolean {
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
  const ready = MY_CODE.test(pathname) ? Promise.race([quiet(), codeAsked()]) : quiet();
  void ready.then(() => { if (worthFetching()) hint("schedule"); });
  return true;
}

const MY_CODE = /^\/my-code\/?$/;

let codeAskedNow: (() => void) | null = null;
const codeAskedOnce = new Promise<void>((resolve) => { codeAskedNow = resolve; });

/**
 * X6-3 — the member code's own read has been SENT (`lib/memberCode/lifecycle` calls it as the
 * enrolment goes out). Released a task later, so the request has left before any file queues
 * behind it. Only a signal: what it unblocks is a hint, and a later call is a no-op.
 */
export function noteCodeAsked(): void {
  const release = codeAskedNow;
  codeAskedNow = null;
  if (release) setTimeout(release, 0);
}

/** Resolves once {@link noteCodeAsked} has been called in this page's life. */
export function whenCodeAsked(): Promise<void> {
  return codeAskedOnce;
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
 * (`quiet`) — a hint must not queue in front of the open page's own reads. P5-4 (review round 5):
 * Bookings too — its ~25 files started beside a cold /wallet's own reads made Wallet usable at
 * 8.3 s on Fast 3G. From My Code, Bookings is asked for earlier still (`preloadAtSessionCheck`).
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
        await quiet();
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
  // Review round 5 — the invites badge's read with the code, not one more round trip after it.
  if (INVITES_READERS.test(url.pathname)) prefetchMyInvites();
}

/** The pages whose first render reads `/me/invites` (`useMyInvites`): Bookings' badge, Invites, Inbox. */
const INVITES_READERS = /^\/(bookings|bookings\/invites|inbox)\/?$/;

/** {@link routeIntent} as a link's props: pressed, hovered or focused. */
export function intentProps(to: string) {
  const go = () => routeIntent(to);
  return { onPointerDown: go, onMouseEnter: go, onFocus: go };
}

/*
 * P5-3 (review round 5) — a navigation waiting on a page's code says so at once.
 *
 * On a first session (no worker yet, so no chunk on the phone) a tap on a booking card left the
 * old page standing, with nothing to say the tap had landed, for as long as the detail's code took
 * (0.5 s on slow 4G, 1.5–1.8 s on Fast 3G): the router moves in a transition, so a page under the
 * same Suspense boundary is kept rather than replaced by its skeleton. The tap is seen here instead
 * (`components/shell/RoutePending` marks a click on a link to a page whose code has not arrived),
 * and the shell draws a pending cue until that code has arrived — or failed, or 20 s have passed.
 */

const loaded = new Set<ChunkName>();
let pendingPath: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
const pendingListeners = new Set<() => void>();
const PENDING_CAP_MS = 20_000;

function setPending(path: string | null) {
  if (pendingTimer !== null) { clearTimeout(pendingTimer); pendingTimer = null; }
  if (path !== null) pendingTimer = setTimeout(() => setPending(null), PENDING_CAP_MS);
  if (pendingPath === path) return;
  pendingPath = path;
  for (const listener of [...pendingListeners]) listener();
}

function chunkFor(pathname: string): ChunkName | null {
  return BY_PATH.find(([pattern]) => pattern.test(pathname))?.[1] ?? null;
}

/** Records a page's code arriving (or failing): a navigation waiting on it is no longer pending. */
export function noteChunk<T>(name: ChunkName, load: Promise<T>): Promise<T> {
  const settle = () => {
    if (pendingPath !== null && chunkFor(pendingPath) === name) setPending(null);
  };
  load.then((module) => { loaded.add(name); arrivedModules.set(name, module as RouteModule); settle(); }, settle);
  return load;
}

type RouteModule = { default: ComponentType };
const arrivedModules = new Map<ChunkName, RouteModule>();

/**
 * R14 PERF — the page's module, once ANY caller's fetch of it has arrived (a prefetch, an intent,
 * an earlier open), else undefined. `App.tsx`'s route `lazy` answers React synchronously with it,
 * so a prefetched page mounts in the tap's own commit instead of suspending once behind its
 * skeleton (React then holds a shown fallback ≥ 300 ms: the first Wallet tap measured 310–318 ms).
 */
export function arrivedChunk(name: ChunkName): RouteModule | undefined {
  return arrivedModules.get(name);
}

/** A link to `pathname` was followed: pending while its page's code has not arrived. */
export function markNavigationPending(pathname: string): boolean {
  const name = chunkFor(pathname);
  if (name === null || loaded.has(name)) return false;
  setPending(pathname);
  return true;
}

/** The navigation landed (the shell's location moved): nothing is pending any more. */
export function clearNavigationPending(): void {
  setPending(null);
}

export function isNavigationPending(): boolean {
  return pendingPath !== null;
}

export function subscribeNavigationPending(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
}

/**
 * Whether a followed link is waiting on its page's code. The shell draws `RoutePendingBar` under
 * the top bar and marks `<main>` busy while it is.
 */
export function useNavigationPending(): boolean {
  return useSyncExternalStore(subscribeNavigationPending, isNavigationPending, () => false);
}

/**
 * R14 PERF — a member tab page (`routeChunks`): once its module has arrived by ANY path (the tab
 * bar's idle prefetch, a link's intent, an earlier open), React.lazy is answered by a thenable that
 * resolves synchronously, so the page mounts in the tap's commit. A plain `lazy` re-imported the
 * prefetched module and suspended once on the promise; the shown skeleton is then held ≥ 300 ms
 * (React's fallback throttle) — the first Wallet tap of a session measured 310–318 ms of skeleton
 * on a 7 ms open. Not yet arrived: the ordinary `loadChunk` path and its skeleton.
 */
export const routeLazy = (name: ChunkName) =>
  lazy(() => {
    const ready = arrivedChunk(name);
    if (ready) return { then: (resolve: (m: { default: ComponentType }) => void) => resolve(ready) } as Promise<{ default: ComponentType }>;
    return loadChunk(routeChunks[name]);
  });
