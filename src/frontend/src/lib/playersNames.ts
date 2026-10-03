import { clubClock, clubShortDate } from "./clubClock";

/**
 * Names and instants between members — split out of `playersCopy` (R7, P5-7) so a screen that
 * needs only these (the wallet) does not pull the whole players copy into every member's first
 * load. `playersCopy` re-exports them, so no caller had to change.
 */

/** Who a nameless member is, in a sentence. */
export const SOMEONE = "A member";

/** "Sam" from "Sam Petersen" — the grid's own rule: first names between members. */
export function firstName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return SOMEONE;
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

/** "Sam", "Sam and Alex", "Sam, Alex and Jo". */
export function listNames(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * "Wed 30 Sep, 18:00" in the club's zone — the one face every players screen writes an instant
 * in: the club's ONE short date (`clubShortDate` — never "01 Oct", never "Sept") and its clock.
 */
export function playersWhen(iso: string | number | Date, timezone?: string): string {
  return `${clubShortDate(iso, timezone)}, ${clubClock(iso, timezone)}`;
}
