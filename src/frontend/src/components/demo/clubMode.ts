import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api";

/**
 * Which club an admin is in — the live one or its demo (a second tenant full of made-up members,
 * bookings and money, made by the server on the first visit). Only admins can be in the demo, so
 * only the admin's lazy demo chunk (`src/demoMode.tsx`) carries this; `whoami` does not say it.
 *
 * <p>
 * <b>Read once per page load, per admin.</b> A switch and a reset both load the app afresh, so the
 * answer never goes stale under the page. Until it lands — or when it cannot (no signal) — the
 * mode this browser last switched to for THIS user stands in: the demo's admin is a different user
 * from the live one, so a hint is never somebody else's, and the stripe is there from the first paint.
 * </p>
 */
export type ClubMode = "live" | "demo";

/** `GET /api/v1/admin/mode`. `club_name` is the REAL club's in both modes. */
export type ClubModeRead = {
  mode: ClubMode;
  club_name: string;
  demo: { generated_at: string; stale_after_hours: number } | null;
};

/** `POST /api/v1/admin/mode` — a sign-in's answer for the new session, plus the mode it is in. */
export type ModeSwitchAnswer = {
  access_token: string;
  user_id: string;
  is_admin: boolean;
  must_change_password: boolean;
  mode: ClubMode;
  generated_at: string | null;
};

/**
 * How long a switch or a reset may take. The first visit (and each one after the data is a day
 * old) draws a whole made-up club, which on the club's Pi takes far longer than the 20 s every
 * other call gets.
 */
export const DEMO_DRAW_TIMEOUT_MS = 5 * 60_000;

export const clubModeApi = {
  read: () => api.get<ClubModeRead>("/api/v1/admin/mode"),
  switchTo: (mode: ClubMode) => api.postSlow<ModeSwitchAnswer>("/api/v1/admin/mode", { mode }, DEMO_DRAW_TIMEOUT_MS),
  resetDemo: () => api.postSlow<{ generated_at: string }>("/api/v1/admin/demo/reset", undefined, DEMO_DRAW_TIMEOUT_MS),
};

const HINT_KEY = "crusaders.mainframe.club-mode";

type Known = { userId: string; mode: ClubMode };

/** Never throws — private mode refuses storage. */
function readHint(userId: string): ClubMode | null {
  try {
    const hint = JSON.parse(window.localStorage?.getItem(HINT_KEY) ?? "null") as Known | null;
    return hint?.userId === userId && (hint.mode === "live" || hint.mode === "demo") ? hint.mode : null;
  } catch {
    return null;
  }
}

/** What this browser last knew for `userId` — written by a read and by a switch. */
export function rememberClubMode(userId: string, mode: ClubMode): void {
  try { window.localStorage?.setItem(HINT_KEY, JSON.stringify({ userId, mode } satisfies Known)); } catch { /* private mode */ }
}

let known: Known | null = null;
let asked: string | null = null;
const listeners = new Set<() => void>();

function publish(next: Known) {
  known = next;
  for (const fn of listeners) fn();
}

function ask(userId: string) {
  if (asked === userId) return;
  asked = userId;
  clubModeApi.read().then(
    (r) => {
      rememberClubMode(userId, r.mode);
      publish({ userId, mode: r.mode });
    },
    // Unanswered: the hint stands, and the next mount or a focus asks again.
    () => { if (asked === userId) asked = null; },
  );
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The mode `userId` is in: the club's answer, else this browser's last word, else null (unknown). */
export function useClubMode(userId: string | null): ClubMode | null {
  const answered = useSyncExternalStore(subscribe, () => known);
  useEffect(() => {
    if (!userId) return;
    ask(userId);
    const again = () => ask(userId);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [userId]);
  if (!userId) return null;
  return answered?.userId === userId ? answered.mode : readHint(userId);
}

/** Test seam — forget the page's answer between cases. */
export function resetClubModeForTests(): void {
  known = null;
  asked = null;
}
