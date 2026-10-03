import type { AdminPackage, MemberGroup } from "@/lib/adminApi";
import type { ShelfItem, ShelfKey } from "@/lib/packagesCopy";

/**
 * The shelf a member SEES, for working out a saving the way their Buy page does (review round 6,
 * J6-5; contract §4.2–§4.3). A saving is measured against the smallest package on the member's
 * shelf, and a group member's shelf is that group's packages AND the club's, the club's at the
 * group's discount (§4.2, Dean's answer 2). Measured against the group's packages alone, a single
 * group package was "the only package on this shelf" with no saving at all.
 *
 * <p>
 * For a group's shelf this is the shelf of a member of that group alone — the club packages at
 * the group's own `package_discount_bps` (none when it sets none, or when the groups could not be
 * read). The club's own shelf is the club packages, as a member in no group sees them.
 * </p>
 */
export function memberShelfOf(packages: readonly AdminPackage[], shelf: ShelfKey, groups: readonly MemberGroup[] | null): ShelfItem[] {
  const active = packages.filter((p) => p.status === "active");
  const club = active.filter((p) => p.group === null);
  if (shelf === null) return club;
  const bps = groups?.find((g) => g.id === shelf)?.package_discount_bps ?? 0;
  const discounted = club.map((p) => ({ id: p.id, name: p.name, minutes: p.minutes, price_zar: discountedPrice(p.price_zar, bps) }));
  return [...discounted, ...active.filter((p) => p.group?.id === shelf)];
}

/** The member's shelf with `draft` standing in for the package it edits (or added) — the editor's preview. */
export function memberShelfWith(packages: readonly AdminPackage[], shelf: ShelfKey, groups: readonly MemberGroup[] | null, draft: ShelfItem): ShelfItem[] {
  return [...memberShelfOf(packages.filter((p) => p.id !== draft.id), shelf, groups), draft];
}

/** §4.2: `floor_cent(PriceZar × (10000 − d) ÷ 10000)` — in whole cents, so no float drift. */
function discountedPrice(priceZar: number, bps: number): number {
  if (bps <= 0) return priceZar;
  return Math.floor((Math.round(priceZar * 100) * (10000 - bps)) / 10000) / 100;
}
