import { useState } from "react";
import type { ActionsMenuItem } from "@/components/admin/ActionsMenu";
import { useToast } from "@/components/Toast";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { adminEndpoints } from "@/lib/adminApi";
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
  // Round-1 contract §7: the desk says why, for the change record and the member's email.
  const [reason, setReason] = useState("");
  return {
    title: COPY.resetCodeTitle(name), description: COPY.resetCodeBody, confirmLabel: COPY.resetCodeConfirm,
    action: COPY.resetCodeAction,
    children: (
      <>
        <Field controlId="reset-code-reason">
          <FieldLabel>{COPY.resetCodeReason}</FieldLabel>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={COPY.resetCodeReasonPlaceholder} />
          <FieldDescription>{COPY.resetCodeReasonHint}</FieldDescription>
        </Field>
        <RevokePasskeysSwitch
          label={COPY.revokePasskeys} hint={COPY.revokePasskeysHint} checked={revokePasskeys} onChange={setRevokePasskeys}
        />
      </>
    ),
    confirmDisabled: reason.trim() === "",
    onConfirm: async () => {
      const r = await adminEndpoints.memberCodeReset(membershipId, { revokePasskeys, reason: reason.trim() });
      toast.push({ tone: "success", text: COPY.codeReset(name, r.passkeys_revoked, r.passkeys_removed) });
      setRevokePasskeys(true);
      setReason("");
      await onDone();
    },
  };
}
