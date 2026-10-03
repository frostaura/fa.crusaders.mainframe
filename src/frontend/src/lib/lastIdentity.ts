/**
 * Who this browser last had a CONFIRMED session for. (D3)
 *
 * <p>
 * The offline state means "there is a token and the club cannot be reached to say anything
 * about it", and on its own that is not enough to render anything belonging to a person: a
 * token is a string in `localStorage` that nothing has vouched for. This is the second fact —
 * the id of the member `whoami` last actually confirmed, on this device. Together they are what
 * {@link OFFLINE_CAPABLE} routes are allowed to render a last-known store against.
 * </p>
 *
 * <p>
 * It is written only where the server has answered, and cleared wherever a session ends, so it
 * can never be true of somebody who has signed out. It is NOT a credential and grants nothing:
 * every request still carries the token and the API still decides.
 * </p>
 */
const LAST_IDENTITY_KEY = "crusaders.mainframe.last-identity";

/** Never throws — private mode refuses writes and a locked-down profile refuses reads. */
export function readLastIdentity(): string | null {
  try { return window.localStorage?.getItem(LAST_IDENTITY_KEY) ?? null; } catch { return null; }
}

/** Never throws — private mode refuses writes. */
export function writeLastIdentity(userId: string): void {
  try { window.localStorage?.setItem(LAST_IDENTITY_KEY, userId); } catch { /* private mode */ }
}

/** Never throws. */
export function clearLastIdentity(): void {
  try { window.localStorage?.removeItem(LAST_IDENTITY_KEY); } catch { /* nothing to do */ }
}
