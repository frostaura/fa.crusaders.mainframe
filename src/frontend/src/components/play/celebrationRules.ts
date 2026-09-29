import type { Celebration } from "@/lib/playApi";

/**
 * The celebration overlay's rules (§9.3), apart from the component so each is a plain,
 * testable function: where a moment may never appear, and how a queue becomes one moment.
 */

/**
 * Where a celebration must never appear: the pass at the court (`/my-code`, and its old path),
 * an invite link, and every auth or first-run page. The public landing too.
 */
const QUIET = /^\/(my-code|court-code|j|invites|login|register|verify-email|welcome|forgot-password|reset-password|change-password|get-started)(\/|$)/;

/** More than this many waiting, and they are one moment rather than a queue of overlays. */
export const COLLAPSE_OVER = 3;

export function isQuietPath(pathname: string): boolean {
  return pathname === "/" || QUIET.test(pathname);
}

export type Moment =
  | { kind: "one"; celebration: Celebration }
  | { kind: "many"; ids: string[] };

/** The one moment to show for this queue, oldest first — or a single "N new badges". */
export function momentOf(items: readonly Celebration[]): Moment | null {
  if (items.length === 0) return null;
  if (items.length > COLLAPSE_OVER) return { kind: "many", ids: items.map((c) => c.id) };
  return { kind: "one", celebration: items[0] };
}
