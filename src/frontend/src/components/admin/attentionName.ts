import { attentionBadge, type AdminAttention } from "@/lib/adminAttention";
import type { AdminNavItem } from "./adminNav";

/** The three attention counts the admin navigation shows. */
export type BadgeCounts = Pick<AdminAttention, "pending" | "doors" | "faults">;

/**
 * The link's accessible name: the label, then the count in words — "Members, 2 membership
 * applications awaiting review" — or the label alone at zero.
 *
 * <p>
 * An `aria-label` rather than a visually hidden span, and that is the fix, not a style. The
 * count used to be a sibling flex item, then a visually hidden span inside the label; both are
 * block-level to Chromium's name computation (a flex item is blockified, an absolutely placed
 * `sr-only` box is block), and Chromium puts a space between block children — so the rail read
 * "Members , 7 membership applications…". jsdom does not, so no unit test could see it;
 * `e2e/admin-devices.spec.ts` asks Chromium's own accessibility tree. The name still opens with
 * the words on screen (WCAG 2.5.3).
 * </p>
 */
export function attentionName(item: AdminNavItem, counts: BadgeCounts): string {
  if (!item.badge) return item.label;
  const { count, label } = attentionBadge(item.badge, counts);
  return count > 0 ? `${item.label}, ${label}` : item.label;
}
