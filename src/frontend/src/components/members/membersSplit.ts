import { createContext, useContext } from "react";

/**
 * What the members list tells a member's record drawn beside it (R4 form factor, SPEC §3.8).
 *
 * <p>
 * The record is a child route of the list (`/admin/members/:userId` under `/admin/members`), drawn
 * in the list page's own `SplitView`. Inside it the record must not frame itself a second time —
 * the list page owns the `PageShell` — and its back link returns to the list as the admin left it
 * (status and search), which the record's own URL does not carry.
 * </p>
 *
 * <p>
 * Outside the list (a test mounting the record alone) there is no provider and the record frames
 * itself as before.
 * </p>
 */
export type MembersSplit = {
  /** The list's URL with the filters the admin left it on: `/admin/members?status=PendingApproval`. */
  listHref: string;
};

export const MembersSplitContext = createContext<MembersSplit | null>(null);

export function useMembersSplit(): MembersSplit | null {
  return useContext(MembersSplitContext);
}
