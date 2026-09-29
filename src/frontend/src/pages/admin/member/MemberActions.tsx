import { useState } from "react";
import { ActionsMenu, type ActionsMenuItem } from "@/components/admin/ActionsMenu";
import { RevokePasskeysSwitch } from "@/components/member-code/RevokePasskeysSwitch";
import { useToast } from "@/components/Toast";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ArrowCounterClockwise, Envelope, Key, Prohibit, UserMinus, UserPlus } from "@/components/ui/icons";
import { Textarea } from "@/components/ui/textarea";
import { endpoints } from "@/lib/api";
import { ACTIONS_COPY as COPY, MEMBER_COPY } from "@/lib/memberDetailCopy";
import type { MemberDetail } from "@/lib/memberDetailApi";

/**
 * The member's secondary actions behind one ⋯ (the founder: the old row of worded buttons was
 * "atrocious"). The two everyday actions — Top up, Book for member — stay on the header; the
 * lifecycle transitions live here, each behind a confirm dialog that states its consequence.
 *
 * <p>
 * <b>The lifecycle routes take the MEMBERSHIP id</b>, unlike everything else on this page. An
 * account with no membership row (a bootstrap admin) has no lifecycle, so those items are simply
 * absent for it rather than offered and refused.
 * </p>
 *
 * <p>
 * <b>A committed transition whose email failed says so.</b> `member_notified: false` means the
 * status changed and nobody told the member; a warning toast, never a success, never a failure.
 * </p>
 */
type Props = { detail: MemberDetail; name: string; onChanged: () => void | Promise<void> };

function ReasonField({ id, value, onChange }: { id: string; value: string; onChange: (next: string) => void }) {
  return (
    <Field controlId={id}>
      <FieldLabel>{COPY.reason}</FieldLabel>
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={COPY.reasonPlaceholder} />
      <FieldDescription>{COPY.reasonHint}</FieldDescription>
    </Field>
  );
}

/** The toast for a lifecycle answer: success, or a warning when the member was not told. */
function useLifecycleToast() {
  const toast = useToast();
  return (notified: boolean, done: string, unnotified: string) =>
    toast.push(notified ? { tone: "success", text: done } : { tone: "warning", text: unnotified, durationMs: 8000 });
}

function useLifecycleItems({ detail, name, onChanged }: Props) {
  const say = useLifecycleToast();
  const [reason, setReason] = useState("");
  const id = detail.membership_id;
  if (!id) return [];
  const settle = async () => { setReason(""); await onChanged(); };
  const reasonField = <ReasonField id="member-action-reason" value={reason} onChange={setReason} />;

  const approve: ActionsMenuItem = {
    label: COPY.approve, icon: <UserPlus aria-hidden="true" />,
    confirm: {
      title: COPY.approveTitle(name), description: COPY.approveBody, confirmLabel: COPY.approveConfirm, tone: "primary",
      action: COPY.approveAction,
      onConfirm: async () => {
        const r = await endpoints.adminApprove(id);
        say(r.member_notified, COPY.approved(name), COPY.approvedUnnotified(name));
        await settle();
      },
    },
  };
  const reject: ActionsMenuItem = {
    label: COPY.reject, icon: <UserMinus aria-hidden="true" />, danger: true,
    confirm: {
      title: COPY.rejectTitle(name), description: COPY.rejectBody, confirmLabel: COPY.rejectConfirm,
      action: COPY.rejectAction, children: reasonField, confirmDisabled: !reason.trim(),
      onConfirm: async () => {
        const r = await endpoints.adminReject(id, reason.trim());
        say(r.member_notified, COPY.rejected(name), COPY.rejectedUnnotified(name));
        await settle();
      },
    },
  };
  const reactivate: ActionsMenuItem = {
    label: COPY.reactivate, icon: <ArrowCounterClockwise aria-hidden="true" />,
    confirm: {
      title: COPY.reactivateTitle(name), description: COPY.reactivateBody, confirmLabel: COPY.reactivateConfirm,
      tone: "primary", action: COPY.reactivateAction,
      onConfirm: async () => {
        const r = await endpoints.adminReactivate(id);
        say(r.member_notified, COPY.reactivated(name), COPY.reactivatedUnnotified(name));
        await settle();
      },
    },
  };
  const suspend: ActionsMenuItem = {
    label: COPY.suspend, icon: <Prohibit aria-hidden="true" />, danger: true,
    confirm: {
      title: COPY.suspendTitle(name), description: COPY.suspendBody, confirmLabel: COPY.suspendConfirm,
      action: COPY.suspendAction, children: reasonField, confirmDisabled: !reason.trim(),
      onConfirm: async () => {
        const r = await endpoints.adminSuspend(id, reason.trim());
        say(r.member_notified, COPY.suspended(name), COPY.suspendedUnnotified(name));
        await settle();
      },
    },
  };

  switch (detail.status) {
    case "PendingApproval": return [approve, reject];
    case "Active": return [suspend];
    case "Suspended": return [reactivate];
    case "Rejected": return [approve];
    default: return [];
  }
}

/**
 * Reset member code — the desk's answer to "I lost my phone" (member-code §10, §13). The code
 * rotates and every session ends; the passkeys go too unless the admin says otherwise, because a
 * lost phone's passkey signs straight back in and picks up the new code. Takes the MEMBERSHIP id,
 * like the lifecycle routes, so an account with none has no item.
 */
function useResetCodeItem({ detail, name, onChanged }: Props): ActionsMenuItem | null {
  const toast = useToast();
  const [revokePasskeys, setRevokePasskeys] = useState(true);
  const id = detail.membership_id;
  if (!id) return null;
  return {
    label: COPY.resetCode, icon: <Key aria-hidden="true" />, danger: true,
    confirm: {
      title: COPY.resetCodeTitle(name), description: COPY.resetCodeBody, confirmLabel: COPY.resetCodeConfirm,
      action: COPY.resetCodeAction,
      children: (
        <RevokePasskeysSwitch
          label={COPY.revokePasskeys} hint={COPY.revokePasskeysHint} checked={revokePasskeys} onChange={setRevokePasskeys}
        />
      ),
      onConfirm: async () => {
        const r = await endpoints.adminResetMemberCode(id, revokePasskeys);
        toast.push({ tone: "success", text: COPY.codeReset(name, r.passkeys_revoked, r.passkeys_removed) });
        setRevokePasskeys(true);
        await onChanged();
      },
    },
  };
}

export function MemberActions(props: Props) {
  const { detail, name } = props;
  const toast = useToast();
  const lifecycle = useLifecycleItems(props);

  const resend: ActionsMenuItem | null = detail.email_verified ? null : {
    label: COPY.resendVerification, icon: <Envelope aria-hidden="true" />,
    onSelect: () => {
      endpoints.resendVerification(detail.email)
        .then(() => toast.push({ tone: "success", text: COPY.resent(detail.email) }))
        .catch(() => toast.push({ tone: "danger", text: COPY.resendFailed }));
    },
  };
  const resetCode = useResetCodeItem(props);

  return <ActionsMenu label={MEMBER_COPY.moreActions(name)} items={[resend, resetCode, ...lifecycle]} />;
}
