import type { AdminSource, MembershipStatus } from "@/lib/memberDetailApi";
import { ADMIN_ROLE_COPY as COPY } from "@/lib/memberDetailCopy";

/**
 * What the console may offer about one person's admin rights (R20) — one rule for the Access
 * tab's switch, the members list's ⋯ and the record header's ⋯, so the three can never disagree.
 *
 * <ul>
 *   <li><b>grant</b> — what pressing would do: true = make an administrator, false = remove.</li>
 *   <li><b>locked</b> — why it cannot be pressed, or null. A config admin (`Admins:Emails`) cannot
 *   be removed from the console; a member who is not active cannot be granted (the route would
 *   409 `not_active_member`). An admin who is suspended can still be revoked.</li>
 *   <li><b>short</b> — the same reason in a menu's few words (the switch shows the long one).</li>
 * </ul>
 */
export type AdminRoleOffer = { grant: boolean; locked: string | null; short: string | null };

export function adminRoleOffer(isAdmin: boolean, adminSource: AdminSource | null, status: MembershipStatus | null): AdminRoleOffer {
  if (isAdmin && adminSource === "config") return { grant: false, locked: COPY.configLocked, short: COPY.menuConfigLocked };
  if (!isAdmin && status !== "Active") return { grant: true, locked: COPY.notActive, short: COPY.menuNotActive };
  return { grant: !isAdmin, locked: null, short: null };
}

/**
 * The offer for a members-list row — or null when the list did not say whether they are an admin:
 * absent never means false (an API that predates R20 sends no `is_admin`), and offering "Make
 * administrator" to someone who already is would be the screen asserting what it cannot know.
 */
export function rowAdminRoleOffer(row: { is_admin?: boolean; admin_source?: AdminSource | null; status: string }): AdminRoleOffer | null {
  if (typeof row.is_admin !== "boolean") return null;
  return adminRoleOffer(row.is_admin, row.admin_source ?? null, row.status as MembershipStatus);
}
