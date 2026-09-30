/**
 * The bell's words, apart from `playersCopy` because the bell is in the app shell on every screen
 * and `playersCopy` (~29 kB) is not: importing two functions from it put the whole players
 * vocabulary in the entry chunk (perf lane, 2026-09-30). `playersCopy` re-exports these, so
 * `INBOX_COPY.title` and the bell cannot say different things.
 */

/** The inbox's name — the bell's accessible name and the inbox page's title. */
export const INBOX_TITLE = "Notifications";

/** The bell's accessible name: "Notifications, 3 unread" — or just "Notifications". */
export function bellLabel(unread: number | null): string {
  return unread && unread > 0 ? `${INBOX_TITLE}, ${unread} unread` : INBOX_TITLE;
}

/** The digits on the bell: 1–9, then "9+". Null at zero or unknown — no badge at all. */
export function bellBadge(unread: number | null): string | null {
  if (!unread || unread <= 0) return null;
  return unread > 9 ? "9+" : String(unread);
}
