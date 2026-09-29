/**
 * R1 F2.3 / F2.5 — an invite link this device opened and nobody has answered yet, remembered so
 * the journey it started survives what comes between: signing in, joining the club (register,
 * confirm the email, wait for approval, sign in for the first time), or topping up because the
 * share was more than the member had to spend.
 *
 * <p>
 * <b>Only the token, never the game.</b> A signed-out device may not read the invite (the API
 * answers it only to a member), so there is nothing else to keep; the game is read again, by
 * whoever is signed in, when the invite is resurfaced — and the server still decides whose it is.
 * </p>
 *
 * <p>
 * <b>Whose it is.</b> Saved signed-out, it belongs to whoever signs in next on this device —
 * that is the journey. Saved by a signed-in member, it is theirs alone: the next person to sign
 * in here never has another member's link offered to them (the session rule that drops a
 * return-to page on sign-out, applied to invites).
 * </p>
 *
 * <p>
 * Browser storage can be missing or throw (a private window, blocked site data); every access is
 * guarded and the product works without it — the invite is simply not resurfaced.
 * </p>
 */

const KEY = "crusaders.pendingInvite";

/** How long an unanswered link is worth offering again. Shares close within a week of any game. */
export const PENDING_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type PendingInvite = {
  token: string;
  /** Who opened it, or null when it was opened signed out. */
  userId: string | null;
  savedAt: number;
};

function read(): PendingInvite | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingInvite>;
    if (typeof value.token !== "string" || !value.token || typeof value.savedAt !== "number") return null;
    return { token: value.token, userId: typeof value.userId === "string" ? value.userId : null, savedAt: value.savedAt };
  } catch {
    return null;
  }
}

/** Remember the link. A signed-in member's save replaces a signed-out one: it is theirs now. */
export function savePendingInvite(token: string, userId: string | null, now = Date.now()): void {
  if (!token) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ token, userId, savedAt: now } satisfies PendingInvite));
  } catch {
    // Storage refused: the invite is not resurfaced, and nothing else changes.
  }
}

/**
 * The link waiting for `userId` (null: whoever is signed out), or null — none, expired, or
 * another member's.
 */
export function pendingInvite(userId: string | null, now = Date.now()): PendingInvite | null {
  const saved = read();
  if (!saved) return null;
  if (now - saved.savedAt > PENDING_INVITE_TTL_MS) {
    clearPendingInvite(saved.token);
    return null;
  }
  if (saved.userId !== null && saved.userId !== userId) return null;
  return saved;
}

/** Forget the link — answered, refused, or closed. With a token, only when it is that one. */
export function clearPendingInvite(token?: string): void {
  try {
    if (token !== undefined && read()?.token !== token) return;
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to forget where nothing could be kept.
  }
}

/** The app path that reopens the waiting link, or null. */
export function pendingInvitePath(userId: string | null, now = Date.now()): string | null {
  const saved = pendingInvite(userId, now);
  return saved ? invitePathOf(saved.token) : null;
}

/** `/j/{token}` — the shared link's own page. */
export function invitePathOf(token: string): string {
  return `/j/${encodeURIComponent(token)}`;
}
