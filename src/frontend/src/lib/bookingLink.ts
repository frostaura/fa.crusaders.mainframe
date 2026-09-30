/**
 * Router state for a link that opens a booking's page KNOWING the booking is live — from the
 * member's upcoming or recent games, the grid, or the confirmation that just booked it.
 *
 * <p>
 * Perf lane (2026-09-30): with it, the booking page starts its result read beside the booking's
 * own read instead of a round trip after it. Without it — an email, the inbox, a typed address —
 * the page cannot know the game was not cancelled, and a cancelled game asks for no result at all
 * (F2.15), so the result is read only once the booking says it may be shown.
 * </p>
 */
export const RESULT_READABLE = { resultReadable: true } as const;

export function vouchesForResult(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as { resultReadable?: unknown }).resultReadable === true;
}
