import { endSessionGeneration, tokenStore } from "@/lib/api";
import { wipeSessionData } from "@/lib/sessionWipe";
import { readLastIdentity, writeLastIdentity } from "@/lib/lastIdentity";
import { clubModeApi, rememberClubMode, type ClubMode } from "./clubMode";

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

/** Into the demo, or back to the live club. Rejects (and changes nothing here) when the club refuses. */
export async function switchClub(to: ClubMode): Promise<void> {
  const answer = await clubModeApi.switchTo(to);
  await startAfresh(answer.access_token, answer.user_id, answer.mode, AFTER_SWITCH_PATH);
}

/**
 * The demo's made-up data, made again. The session survives it, but everything kept from the old
 * data does not; the page reloads where it is unless it names something by id (that row is gone).
 */
export async function resetDemoClub(): Promise<void> {
  await clubModeApi.resetDemo();
  const token = tokenStore.get();
  const userId = readLastIdentity();
  const here = window.location.pathname;
  const landing = ID_SEGMENT.test(here) ? AFTER_SWITCH_PATH : here + window.location.search;
  if (token && userId) await startAfresh(token, userId, "demo", landing);
  else leavePage.to(landing);
}
