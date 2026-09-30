import type { AdminSettings } from "./api";

/**
 * The Settings page's unsaved edits, kept for this tab — review round 1, F3.15.
 *
 * <p>
 * A session that ended during a save threw every edit away: the page unmounted on the way to
 * sign-in and the draft lived only in React state. It is now mirrored to `sessionStorage` (this
 * tab only, gone with it) under the admin's own id, together with the settings it was edited
 * FROM. It comes back only when the club's settings are still exactly those — an edit restored
 * over somebody else's newer save would silently undo theirs.
 * </p>
 *
 * <p>
 * Browser storage can be missing or throw (private mode, blocked site data); every access is
 * guarded and the page works without it, as it did before.
 * </p>
 */
const PREFIX = "crusaders.settings.draft.";

type Kept = { basis: AdminSettings; draft: AdminSettings };

function storage(): Storage | null {
  try { return window.sessionStorage ?? null; } catch { return null; }
}

export function keepSettingsDraft(userId: string, basis: AdminSettings, draft: AdminSettings): void {
  try { storage()?.setItem(PREFIX + userId, JSON.stringify({ basis, draft } satisfies Kept)); } catch { /* full or blocked */ }
}

export function forgetSettingsDraft(userId: string): void {
  try { storage()?.removeItem(PREFIX + userId); } catch { /* blocked */ }
}

/**
 * The kept draft and the settings it was edited from, or null. The caller decides whether the
 * club's settings are still those (it owns the comparison — `changedKeys`).
 */
export function keptSettingsDraft(userId: string): Kept | null {
  try {
    const raw = storage()?.getItem(PREFIX + userId);
    return raw ? (JSON.parse(raw) as Kept) : null;
  } catch {
    return null;
  }
}
