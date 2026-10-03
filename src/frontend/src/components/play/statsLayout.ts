import { cn } from "@/lib/utils";

/**
 * Five tiles, and no orphan cell (P10 walk). Two columns, and an odd last tile spans both; wider,
 * a six-column track, three tiles across the first row and two, wider, across the second — a
 * balanced 3 + 2 rather than 3 + 2 + an empty hole.
 *
 * <p>
 * R4 X4-6 — the columns follow the grid's OWN width in rem (a container query), not the
 * viewport: at 200 % text on a phone two tiles were ~120 px and "Sessions" broke as "Sessi/ons".
 * There it is one tile per row. Every column change is one of the ranges below, so no two rules
 * compete for the same width.
 * </p>
 */
export const STATS_FRAME = "[container-type:inline-size]";
// R6 L6-18: from 45rem (the wide My game column) the five tiles are one even row, not 3 + 2.
export const STATS_GRID = "grid grid-cols-1 gap-3 [@container(min-width:14rem)]:grid-cols-2 [@container(min-width:30rem)_and_(max-width:44.99rem)]:grid-cols-6 [@container(min-width:45rem)]:grid-cols-5";

export function statSpan(index: number, count: number): string {
  const firstRow = Math.ceil(count / 2);
  return cn(
    index === count - 1 && count % 2 === 1 && "[@container(min-width:14rem)_and_(max-width:29.99rem)]:col-span-2",
    index < firstRow
      ? "[@container(min-width:30rem)_and_(max-width:44.99rem)]:col-span-2"
      : "[@container(min-width:30rem)_and_(max-width:44.99rem)]:col-span-3",
  );
}
