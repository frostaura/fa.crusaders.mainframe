import { useState } from "react";
import type { ActionsMenuItem } from "@/components/admin/ActionsMenu";
import { useToast } from "@/components/Toast";
import { endpoints } from "@/lib/api";
import { ACTIONS_COPY as COPY } from "@/lib/memberDetailCopy";
import { RevokePasskeysSwitch } from "./RevokePasskeysSwitch";

type ResetConfirm = NonNullable<ActionsMenuItem["confirm"]>;

/**
 * Reset member code — the desk's answer to "I lost my phone" (member-code §10, §13). The code
 * rotates and every session ends; the passkeys go too unless the admin says otherwise, because a
 * lost phone's passkey signs straight back in and picks up the new code. Takes the MEMBERSHIP id,
 * like the lifecycle routes.
 *
 * <p>
 * ONE confirm, whichever surface opens it (D8): the member's own page puts it behind its ⋯, and
 * the Members list's row ⋯ opens it as {@link ResetMemberCodeDialog} — same question, same
 * switch, same default, same toast.
 * </p>
 */
export function useResetMemberCodeConfirm(name: string, membershipId: string, onDone: () => void | Promise<void>): ResetConfirm {
  const toast = useToast();
  const [revokePasskeys, setRevokePasskeys] = useState(true);
  return {
    title: COPY.resetCodeTitle(name), description: COPY.resetCodeBody, confirmLabel: COPY.resetCodeConfirm,
    action: COPY.resetCodeAction,
    children: (
      <RevokePasskeysSwitch
        label={COPY.revokePasskeys} hint={COPY.revokePasskeysHint} checked={revokePasskeys} onChange={setRevokePasskeys}
      />
    ),
    onConfirm: async () => {
      const r = await endpoints.adminResetMemberCode(membershipId, revokePasskeys);
      toast.push({ tone: "success", text: COPY.codeReset(name, r.passkeys_revoked, r.passkeys_removed) });
      setRevokePasskeys(true);
      await onDone();
    },
  };
}
