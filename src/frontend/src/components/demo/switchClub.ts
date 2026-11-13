import { ApiError, NetworkError, endSessionGeneration, tokenStore } from "@/lib/api";
import { wipeSessionData } from "@/lib/sessionWipe";
import { readLastIdentity, writeLastIdentity } from "@/lib/lastIdentity";
import { DEMO_DRAW_TIMEOUT_MS, clubModeApi, rememberClubMode, type ClubMode } from "./clubMode";

/**
 * Moving between the live club and its demo, and resetting the demo.
 *
 * <p>
 * <b>A switch is a new session, and it starts with nothing of the last one.</b> The server answers a
 * token pair for the other tenant (and sets the refresh cookie for it); the token is adopted as a
 * sign-in adopts one, and EVERY per-person and per-club store goes first — kept reads, the worker's
 * API caches, last-known door facts, the code's key, the club's zone and the confirmed identity
 * (`lib/sessionWipe`, the same wipe a sign-out runs), and this tab's `sessionStorage` (a Settings
 * draft among it). Then the app is loaded afresh at My Code (a hard navigation, not the router), so
 * the profile, the balance and its stream, every read cache and every page's state start clean. No
 * live figure can be drawn in the demo, nor a made-up one in the live club.
 * </p>
 *
 * <p>
 * Other tabs of this browser hear it through {@link MODE_SWITCHED_KEY} and load afresh too: the
 * token they read on their next request is the new club's, and what they drew is the old one's.
 * </p>
 */
export const MODE_SWITCHED_KEY = "crusaders.mainframe.mode-switched";

/** Where the app opens after a switch — the start URL and the door. */
export const AFTER_SWITCH_PATH = "/my-code";

/** The hard navigation — a seam, because jsdom's `location.assign` can be neither run nor spied on. */
export const leavePage = { to: (path: string) => window.location.assign(path) };

const ID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/|$)/i;

/**
 * The demo club (an admin's mode switch) and its reset: the club answered a new session — another
 * tenant, another user — so this browser starts it with NOTHING of the last one, exactly as after a
 * sign-out, then holds the new token and the identity the club just named (as a sign-in does).
 * A reply to an exchange still in flight for the old session is discarded (C1). The caller then
 * loads the app afresh, so every in-memory context starts clean too. Resolves once the stores are wiped.
 */
async function restartSessionLocally(accessToken: string, userId: string): Promise<void> {
  endSessionGeneration(true);
  tokenStore.set(accessToken);
  // A store that would not delete (private mode, a blocked database) must not stop the switch: the
  // token has already changed, and kept reads are keyed by member, so the new one never reads them.
  await wipeSessionData().catch(() => undefined);
  writeLastIdentity(userId);
}

async function startAfresh(accessToken: string, userId: string, mode: ClubMode, landing: string): Promise<void> {
  await restartSessionLocally(accessToken, userId);
  // This tab's own per-person and per-club leftovers (a Settings draft, a top-up's way back, a
  // half-done tour step) — `sessionStorage` holds nothing the next session should inherit.
  try { window.sessionStorage?.clear(); } catch { /* blocked */ }
  rememberClubMode(userId, mode);
  try { window.localStorage?.setItem(MODE_SWITCHED_KEY, String(Date.now())); } catch { /* private mode */ }
  leavePage.to(landing);
}

/**
 * The gateway or Cloudflare gave up on a request the club was still working on: nginx's 502/504,
 * Cloudflare's 524 — or this tab's own ceiling. The club finishes a demo draw whoever is still
 * waiting, so asking again is how the answer is collected.
 */
export function cutOffInFlight(error: unknown): boolean {
  if (error instanceof NetworkError) return error.kind === "timeout";
  return error instanceof ApiError && (error.status === 502 || error.status === 504 || error.status === 524);
}

/** Pause between asks — a seam, so tests need not wait. */
export const retryPause = { ms: 2_000 };

/**
 * Asks until the club answers or {@link DEMO_DRAW_TIMEOUT_MS} has passed, retrying only a cut-off
 * request. Safe for the switch: the mode already in force answers a fresh session, and a club
 * already drawn answers at once.
 */
async function untilAnswered<T>(ask: () => Promise<T>): Promise<T> {
  const giveUpAt = Date.now() + DEMO_DRAW_TIMEOUT_MS;
  for (;;) {
    try {
      return await ask();
    } catch (error) {
      if (!cutOffInFlight(error) || Date.now() + retryPause.ms >= giveUpAt) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryPause.ms));
    }
  }
}

/**
 * Into the demo, into its member view, or back to the live club. Rejects (and changes nothing here)
 * when the club refuses. `from` names the member view when that is where the session is: the
 * persona is not an admin, so its way out is the member route, not the admin switch.
 */
/**
 * BA-12: where a switch lands. An admin switching between live and demo from a console page
 * stays on that page — the switch threw them onto My Code, both ways, and they had to find their
 * place again. A page naming one record (an id in its path) goes to the console's start instead,
 * because that record is the other club's; the member view, and a switch from outside the
 * console, land on My Code as before.
 */
export function landingAfterSwitch(to: ClubMode, pathname: string, search: string): string {
  if (to === "demo_member" || !/^\/admin(\/|$)/.test(pathname)) return AFTER_SWITCH_PATH;
  return ID_SEGMENT.test(pathname) ? "/admin" : pathname + search;
}

export async function switchClub(to: ClubMode, from?: ClubMode): Promise<void> {
  const leaving = from === "demo_member" && to !== "demo_member";
  const answer = await untilAnswered(() => (leaving ? clubModeApi.leaveMemberView(to as "demo" | "live") : clubModeApi.switchTo(to)));
  const landing = landingAfterSwitch(answer.mode, window.location.pathname, window.location.search);
  await startAfresh(answer.access_token, answer.user_id, answer.mode, landing);
}

/**
 * A reset is NOT asked twice — a second one would draw the club again from the start. A cut-off
 * one is waited out instead: the club's mode is read until the demo's draw time moves past the
 * one standing before the reset.
 */
async function resetAndWait(): Promise<void> {
  const before = await clubModeApi.read().then((r) => r.demo?.generated_at ?? null, () => null);
  try {
    await clubModeApi.resetDemo();
  } catch (error) {
    if (!cutOffInFlight(error)) throw error;
    await untilAnswered(async () => {
      const now = await clubModeApi.read();
      if ((now.demo?.generated_at ?? null) === before) throw new NetworkError("timeout");
    });
  }
}

/**
 * The demo's made-up data, made again. The session survives it, but everything kept from the old
 * data does not; the page reloads where it is unless it names something by id (that row is gone).
 */
export async function resetDemoClub(): Promise<void> {
  await resetAndWait();
  const token = tokenStore.get();
  const userId = readLastIdentity();
  const here = window.location.pathname;
  const landing = ID_SEGMENT.test(here) ? AFTER_SWITCH_PATH : here + window.location.search;
  if (token && userId) await startAfresh(token, userId, "demo", landing);
  else leavePage.to(landing);
}
